/**
 * Render ONE clip in the "band" treatment: the source 16:9 frame kept whole on a black
 * 9:16 canvas, with the title plate in the space above it.
 *
 * SINGLE PASS. The kept spans are selected out of one decode of the source and encoded
 * once. This replaced a renderer that encoded every span to its own AAC file, joined them,
 * then re-encoded the whole clip again for the title — and that design drifted:
 *
 *   Each span's AAC audio was padded to a whole 1024-sample frame, so at every join the
 *   audio started one AAC frame late. Measured on a 27-span clip: +23.1 ms per join, a
 *   clean linear climb to +600 ms by the last span (video 59.600 s vs audio 59.822 s).
 *   Captions are burned into the video, so they ran up to half a second AHEAD of the
 *   voice by the end of every multi-cut clip — and lip sync drifted the same way.
 *
 * Here, every cut boundary is snapped to the source's frame grid; video is chosen frame by
 * frame and audio is trimmed sample-exactly at the SAME boundaries, so audio and video
 * cover identical durations at every cut and cannot drift. Captions are ONE file in
 * output time built from the (voice-aligned) words, not per-span track files. The canvas
 * runs at the source frame rate — the old `color` source had no rate and defaulted to
 * 25 fps, silently dropping every sixth frame of a 30 fps stream.
 *
 * Takes no database and no job: progress is a callback, bookkeeping belongs to the caller.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { bandGeometry } = require('./band');
const paneGeo = require('./pane-geometry');
const { renderPlate } = require('./title-plate');
const { keptSpans } = require('../select/gates');
const captionAss = require('../captions/ass-generator');
const captionStyles = require('../captions/style-store');
const ffmpegLib = require('../ffmpeg');

const LAYOUT_PATH = require('../paths').configPath('layouts', 'layout-6-band-title.json');

/** Is this variant name one this renderer handles? */
const isBandVariant = paneGeo.isBandVariant;

/**
 * Snap kept spans to the video frame grid. Returns frame-exact spans with their position
 * in the OUTPUT timeline. Spans shorter than one frame are dropped.
 */
function snapSpans(spans, fps) {
  const out = [];
  let outFrames = 0;
  for (const s of spans) {
    const fa = Math.round(s.start * fps);
    const fb = Math.round(s.end * fps);
    if (fb - fa < 1) continue;
    out.push({ a: fa / fps, b: fb / fps, fa, fb, outStart: outFrames / fps });
    outFrames += fb - fa;
  }
  return { spans: out, durationSeconds: outFrames / fps, frames: outFrames };
}

/**
 * Map source-time words onto the output timeline. A word belongs to the span it STARTS in
 * (a word straddling a cut must not be shown on both sides of it). A start a hair before
 * the first span — the span was snapped to that word — is clamped onto it.
 */
function mapWordsToOutput(words, snapped) {
  const out = [];
  const { spans } = snapped;
  if (!spans.length) return out;
  for (const w of words) {
    let s = w.start;
    if (s < spans[0].a && s >= spans[0].a - 0.05) s = spans[0].a;
    const k = spans.findIndex((sp) => s >= sp.a && s < sp.b);
    if (k < 0) continue;
    const sp = spans[k];
    const start = sp.outStart + (s - sp.a);
    const end = sp.outStart + (Math.min(w.end, sp.b) - sp.a);
    out.push({
      text: String(w.text ?? w.word ?? '').trim(),
      edited_text: w.edited_text ?? null,
      emphasis: w.emphasis || 'none',
      newline_after: !!w.newline_after,
      start: +start.toFixed(3),
      end: +Math.max(start + 0.05, end).toFixed(3),
    });
  }
  return out.filter((w) => w.text).map((w, i) => ({ i, ...w }));
}

/**
 * The caption style actually burned in: the style preset, then the editor's overrides, then
 * the band geometry for anything the editor left at its default.
 */
function captionStyleFor(style, overrides, layout, geo) {
  const o = overrides || {};
  const y = o.y ?? geo.captionY;
  return {
    ...style,
    ...(o.font_family ? { font_family: o.font_family } : {}),
    ...(o.primary_color ? { primary_color: o.primary_color } : {}),
    ...(o.highlight_color ? { highlight_color: o.highlight_color } : {}),
    ...(o.case ? { case: o.case } : {}),
    animation: o.mode === 'highlight' ? 'highlight' : 'reveal',
    stack_enabled: false,
    font_size_px: o.font_size_px ?? layout.caption.fontSize,
    y_offset_pct: y / layout.canvas.height,
    // Horizontal centre in canvas px; the generator falls back to the frame's centre.
    x_center_px: o.x ?? null,
    anchor: 'bottom',
  };
}

/** Render the title plate PNG and place it. Returns null when there is no title to draw. */
function titlePlateFor({ titleText, titleStyle, style, layout, geo, outDir }) {
  const t = titleStyle || {};
  const centreY = t.y ?? geo.titleY;
  if (!titleText || !centreY) return null;
  const plate = renderPlate({
    text: titleText,
    outDir,
    fontName: t.fontName || (style.header && style.header.font_family) || 'Sequel Sans Bold Head',
    fontSize: t.fontSize || layout.title.fontSize,
    textColor: t.textColor || '#111111',
    fill: t.fill || '#FFFFFF',
    radius: t.radius ?? 26,
    strokeWidth: t.strokeWidth || 0,
    strokeColor: t.strokeColor || null,
    maxWidth: 940,
  });
  if (!plate) return null;
  const centreX = t.x ?? layout.canvas.width / 2;
  plate.x = Math.round(centreX - plate.width / 2);
  plate.y = Math.round(centreY - plate.height / 2);
  return plate;
}

const escFilterPath = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

/** The whole clip as one filter graph. Pure, so it stays under test. */
function buildSinglePassGraph({ snapped, fps, layout, geo, assPath, fontsDir, plate, titleSeconds, panes = null }) {
  const CW = layout.canvas.width;
  const CH = layout.canvas.height;
  const half = 0.5 / fps;
  const { spans, durationSeconds: D } = snapped;
  const parts = [];

  // VIDEO: pick exactly frames [fa, fb) of every span by absolute source time (-copyts),
  // then renumber them contiguously.
  const expr = spans
    .map((s) => `gte(t\\,${(s.a - half).toFixed(6)})*lt(t\\,${(s.b - half).toFixed(6)})`)
    .join('+');
  if (panes) {
    // Re-composed layout: the selected frames feed every pane's crop → cover → crop chain,
    // computed by pane-geometry.js — the same numbers the browser preview draws with.
    parts.push(`[0:v]select='${expr}',setpts=N/FRAME_RATE/TB[sel]`);
    for (const line of paneGeo.paneGraph(panes, 'sel', layout.background)) parts.push(line.replace('__FPS__', String(fps)));
  } else {
    parts.push(`[0:v]select='${expr}',setpts=N/FRAME_RATE/TB,scale=${CW}:${geo.h},setsar=1[band]`);
    parts.push(`color=c=${layout.background}:s=${CW}x${CH}:r=${fps}[bg]`);
    parts.push(`[bg][band]overlay=0:${geo.y}:shortest=1[comp]`);
  }
  let last = 'comp';

  if (assPath) {
    const fd = fontsDir ? `:fontsdir=${escFilterPath(fontsDir)}` : '';
    parts.push(`[${last}]subtitles=${escFilterPath(assPath)}${fd}[capped]`);
    last = 'capped';
  }
  if (plate) {
    const x = Math.round(plate.x ?? (CW - plate.width) / 2);
    const y = Math.round(plate.y ?? 0);
    if (titleSeconds && titleSeconds > 0) {
      const fadeOut = 0.4;
      parts.push(`[1:v]format=rgba,fade=t=out:st=${Math.max(0, titleSeconds - fadeOut).toFixed(3)}:d=${fadeOut}:alpha=1[plate]`);
      parts.push(`[${last}][plate]overlay=${x}:${y}:shortest=1:enable='lte(t,${titleSeconds})'[v]`);
    } else {
      parts.push(`[${last}][1:v]overlay=${x}:${y}:shortest=1[v]`);
    }
  } else {
    parts.push(`[${last}]null[v]`);
  }

  // AUDIO: sample-exact trims at the SAME frame-snapped boundaries, joined audio-only, so
  // no codec frame padding can enter at a cut.
  if (spans.length === 1) {
    parts.push(`[0:a]atrim=start=${spans[0].a.toFixed(6)}:end=${spans[0].b.toFixed(6)},asetpts=PTS-STARTPTS[acat]`);
  } else {
    parts.push(`[0:a]asplit=${spans.length}${spans.map((_, i) => `[as${i}]`).join('')}`);
    spans.forEach((s, i) => {
      parts.push(`[as${i}]atrim=start=${s.a.toFixed(6)}:end=${s.b.toFixed(6)},asetpts=PTS-STARTPTS[at${i}]`);
    });
    parts.push(`${spans.map((_, i) => `[at${i}]`).join('')}concat=n=${spans.length}:v=0:a=1[acat]`);
  }
  parts.push(`[acat]afade=t=in:st=0:d=0.04,afade=t=out:st=${Math.max(0, D - 0.04).toFixed(3)}:d=0.04[a]`);
  return parts.join(';');
}

function runFfmpeg(args) {
  const FFMPEG = process.env.FFMPEG_BIN || require('ffmpeg-static');
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err.slice(-1500)}`))));
  });
}

async function renderBandClip({
  inputPath,
  outputDir,
  clipId,
  variant = 'band-title-top',
  startSeconds,
  endSeconds,
  manualCuts = [],
  transcript,
  styleId = 'sequel-viral',
  titleText = null,
  /*
   * null = hold the title for the WHOLE clip (the default); a number = that many seconds.
   * It defaulted to 8, and every caller inherited it, so the title vanished eight seconds in
   * — the operator's "the title keeps disappearing". The band layout reserves space above
   * the frame for the title; emptying that space mid-clip leaves a black hole.
   */
  titleSeconds = null,
  captionsEnabled = true,
  // Caller-supplied words (source time) override the transcript — the editor's hook for
  // word edits. Omit to caption straight from the transcript.
  words = null,
  // The editor's styling (see edit/doc.js docToRenderParams). Omit for house defaults.
  titleStyle = null,
  captionStyle = null,
  // Detected webcam/chart regions (normalised 0–1); required for re-composed variants.
  composition = null,
  onProgress = () => {},
}) {
  const style = captionStyles.loadStyle(styleId) || captionStyles.loadStyle('sequel-viral');
  const info = await ffmpegLib.probe(inputPath);
  const fps = info.fps_num / info.fps_den;
  const G = paneGeo.layoutGeometry(variant, { composition, srcW: info.width, srcH: info.height });
  // `layout`/`geo` keep the shape the rest of this function reads; both kinds fill them.
  const layout = {
    canvas: G.canvas, background: '#000000',
    title: { fontSize: G.titleFontSize }, caption: { fontSize: G.captionFontSize },
  };
  const geo = G.kind === 'band'
    ? { ...G.band, titleY: G.titleY, captionY: G.captionY }
    : { x: 0, y: 0, w: G.canvas.width, h: G.canvas.height, titleY: G.titleY, captionY: G.captionY };
  const panes = G.kind === 'panes' ? G : null;

  const snapped = snapSpans(
    keptSpans({ start_seconds: startSeconds, end_seconds: endSeconds, manual_cuts: manualCuts }),
    fps,
  );
  if (!snapped.spans.length) throw new Error('clip has no kept span longer than one frame');

  const clipDir = path.join(outputDir, 'clips', clipId);
  const finalPath = path.join(clipDir, `${clipId}-${variant}.mp4`);
  fs.mkdirSync(clipDir, { recursive: true });

  // ONE caption file, in output time.
  let assPath = null;
  if (captionsEnabled) {
    const sourceWords = words || (transcript && transcript.words) || [];
    const outWords = mapWordsToOutput(sourceWords, snapped);
    if (outWords.length) {
      assPath = path.join(clipDir, `${clipId}-${variant}.ass`);
      captionAss.writeAssFile(assPath, {
        track: {
          auto_chunked: style.animation === 'reveal',
          chunk_size: 2,
          position_y_offset_pct: null,
          title_text: null,
          words: outWords,
        },
        style: captionStyleFor(style, captionStyle, layout, geo),
        frameDims: { width: layout.canvas.width, height: layout.canvas.height },
        clipStart: 0,
      });
    }
  }

  const plate = titlePlateFor({ titleText, titleStyle, style, layout, geo, outDir: clipDir });

  // Decode only what the clip needs: from a second before the first kept frame to just
  // after the last. -copyts keeps source timestamps so the frame selection is absolute.
  const origin = Math.max(0, snapped.spans[0].a - 1);
  const readFor = snapped.spans[snapped.spans.length - 1].b - origin + 0.5;
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-copyts', '-ss', origin.toFixed(3), '-t', readFor.toFixed(3), '-i', inputPath,
  ];
  if (plate) args.push('-loop', '1', '-framerate', String(fps), '-i', plate.path);
  args.push(
    '-filter_complex', buildSinglePassGraph({
      snapped, fps, layout, geo, assPath, fontsDir: captionStyles.FONTS_DIR, plate, titleSeconds, panes,
    }),
    '-map', '[v]', '-map', '[a]',
    '-r', String(fps),
    '-c:v', process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264',
    ...(process.platform === 'darwin' ? ['-b:v', '8M', '-tag:v', 'avc1'] : ['-preset', 'fast', '-crf', '18']),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
  );
  const tmp = `${finalPath}.partial.mp4`;
  args.push(tmp);

  onProgress({
    stage: 'render',
    message: `one pass · ${snapped.spans.length} spans · ${snapped.durationSeconds.toFixed(1)}s` +
      (plate ? (titleSeconds ? ` · title ${titleSeconds}s` : ' · title held for the whole clip') : ''),
  });
  await runFfmpeg(args);
  fs.renameSync(tmp, finalPath);
  return finalPath;
}

module.exports = {
  renderBandClip, isBandVariant, LAYOUT_PATH,
  // Shared with the editor's preview so it places things exactly where the export does.
  titlePlateFor, captionStyleFor,
  // Exported for tests.
  snapSpans, mapWordsToOutput, buildSinglePassGraph,
};
