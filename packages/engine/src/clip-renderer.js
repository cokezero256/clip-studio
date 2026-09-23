/**
 * Render a clip from a source video into one of two finished formats:
 *
 *   - "vertical"   → 1080×1920 (9:16) for TikTok / Reels / YouTube Shorts.
 *                    Center-crops a 9:16 column out of the source. Re-encodes via
 *                    h264_videotoolbox on Mac for speed.
 *   - "horizontal" → 1920×1080 (16:9) for YouTube / Twitter / standard player.
 *                    Scales the source to fit 1920×1080 with letterbox if needed.
 *
 * Both formats include:
 *   - Light audio fade in/out (40ms) at the cut boundaries so transitions don't pop.
 *   - faststart moov atom for instant social-upload playback.
 *   - Sane bitrate (4Mbps vertical, 8Mbps horizontal) — visually transparent at
 *     these resolutions and small enough to upload quickly.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const FFMPEG = process.env.FFMPEG_BIN || require('ffmpeg-static');
const { detectSubject } = require('./subject-tracker');
const captionsAss = require('./captions/ass-generator');
const captionsTracks = require('./captions/track-store');
const captionsStyles = require('./captions/style-store');
const { buildSplitScreenFilterGraph } = require('./layouts/split-screen');
const { buildLayoutGraph, loadLayout } = require('./layouts/compose');

// ── Seek / caption-sync invariant ──────────────────────────────────────────
// The hybrid seek coarse-seeks the input to (start - PREROLL) then output-seeks past
// PREROLL. Captions are burned relative to the input-seek origin, so the caption timeline
// MUST be anchored to (start - PREROLL). These two helpers are the single source of truth
// for that coupling; test/smoke.js asserts captionClipStart(s) + seekPreroll(s) === s so
// the two can never drift apart again (which is what made captions ~0.5s early).
function seekPreroll(startSeconds) {
  return Math.min(0.5, Math.max(0, startSeconds));
}
function captionClipStart(startSeconds) {
  return startSeconds - seekPreroll(startSeconds);
}

function run(bin, args, { timeout = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${timeout}ms`));
    }, timeout);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stderr });
      else reject(new Error(`${bin} exited ${code}: ${stderr.slice(-1500)}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Render a single clip.
 *
 * @param {object} opts
 * @param {string} opts.inputPath           Source video to cut from (normalized source.mp4 preferred)
 * @param {number} opts.startSeconds        Inclusive start time
 * @param {number} opts.endSeconds          Exclusive end time
 * @param {'vertical'|'horizontal'} opts.format
 * @param {string} opts.outputPath          Full output file path (.mp4)
 * @param {'smart'|'center'} [opts.cropMode='smart']  Vertical-only. 'smart' uses MediaPipe
 *                                          to position the 9:16 crop around the speaker;
 *                                          'center' is the legacy fixed center crop. Smart
 *                                          falls back to center if MediaPipe isn't installed
 *                                          or detection confidence is too low.
 * @param {string} [opts.clipId]            Stable id used for subject-tracker cache.
 * @param {string} [opts.outputDir]         The video's outputDir (for cache files).
 * @param {null|object} [opts.captions]     If set, burn karaoke-style captions into the video.
 *                                          Shape: { enabled: true, styleId: 'mozzo', transcript: <whisper verbose_json> }.
 *                                          Falls back gracefully (no captions) if track or style missing.
 * @param {object} [opts.clip]              Clip metadata { start_seconds, end_seconds, ... } —
 *                                          passed through to caption track generation.
 */
/** House default caption style. Overridable per render, per clip, or per client. */
const DEFAULT_CAPTION_STYLE_ID = process.env.CAPTION_STYLE_ID || 'open-sans-viral';

async function renderClip(opts) {
  const {
    inputPath,
    startSeconds,
    endSeconds,
    format,
    outputPath,
    cropMode = 'smart',
    clipId,
    outputDir,
    captions = null,
    clip = null,
    layout = 'single',
    secondarySourcePath = null,
    // Pre-computed crop expression — when rendering multiple segments from the same clip,
    // detect subject ONCE for the full range and pass the result here to skip per-segment
    // detection (~40s each). Avoids N×40s detection for N keeper segments after manual cuts.
    precomputedCropX = null,
    // Audio edge fades. For a standalone clip both are true (clean in/out). For keeper
    // segments that will be concatenated, only the FIRST segment fades in and only the
    // LAST fades out — internal cut joins must NOT fade to silence (that creates an
    // audible dip at every cut). Internal joins use a tiny hard edge instead.
    fadeIn = true,
    fadeOut = true,
    // Local one-click audio cleanup: high-pass rumble, light spectral denoise, and EBU
    // loudness normalization to -16 LUFS (the social-platform target). Free, no API.
    enhanceAudio = false,
  } = opts;
  const isSplit = layout === 'split-vertical' || layout === 'split-horizontal';
  if (!fs.existsSync(inputPath)) throw new Error(`Source not found: ${inputPath}`);
  if (isSplit && (!secondarySourcePath || !fs.existsSync(secondarySourcePath))) {
    throw new Error(`Split-screen layout requires secondarySourcePath, got: ${secondarySourcePath}`);
  }
  if (endSeconds <= startSeconds) {
    throw new Error(`Invalid clip range: ${startSeconds} -> ${endSeconds}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const duration = endSeconds - startSeconds;
  const isMac = process.platform === 'darwin';
  const codec = isMac ? 'h264_videotoolbox' : 'libx264';

  // HYBRID-SEEK PRE-ROLL — must be defined BEFORE captions are generated. We coarse-seek
  // the input to (start - PREROLL) and accurately output-seek past PREROLL (kills the dark
  // first frame). The subtitles filter burns relative to the INPUT-seek origin, so caption
  // times must be anchored to (start - PREROLL), not start — otherwise captions land ~PREROLL
  // seconds early. INVARIANT (locked by test/smoke.js): captionClipStart + PREROLL === start.
  const PREROLL = seekPreroll(startSeconds);

  // Resolve which of the 4 locked layouts this render uses (config/layouts/*.json).
  //   single+vertical → layout-1   split-vertical   → layout-2
  //   single+horizontal → layout-3 split-horizontal → layout-4
  const layoutId =
    layout === 'split-vertical' ? 'layout-2' :
    layout === 'split-horizontal' ? 'layout-4' :
    format === 'vertical' ? 'layout-1' : 'layout-3';
  const layoutCfg = loadLayout(layoutId);
  const frameDims = { width: layoutCfg.canvas.width, height: layoutCfg.canvas.height };

  // Face tracking is DISABLED on clips (user preference) — always centre-crop. This also
  // skips the slow MediaPipe detect-subject pass entirely. (layout-1 is letterboxed so it
  // never crops horizontally anyway; layout-2's camera pane just centres.)
  const smartCropX = null;

  // Captions: generate the ASS file. The composer burns it into the filtergraph, so we
  // only need the path here (no manual subtitles= append). Caption baseline per layout
  // comes from the layout config (caption.y), expressed as a bottom-anchored offset.
  let captionDetail = null;
  let captionAssPath = null;
  let captionFontsDir = null;
  if (captions && captions.enabled && clipId && outputDir && clip && captions.transcript) {
    try {
      let track = captionsTracks.loadOrGenerateTrack({
        outputDir,
        clipId,
        clip,
        transcript: captions.transcript,
        defaultStyleId: captions.styleId || DEFAULT_CAPTION_STYLE_ID,
      });
      // Segment renders use clipId like `_full-seg0` so loadOrGenerateTrack
      // generates a fresh track with title_text=null. Carry it through from the caller.
      if (captions.titleText && !track.title_text) {
        track = { ...track, title_text: captions.titleText };
      }
      // Horizontal (16:9) exports carry NO title — just the layout + captions (user pref).
      if (layoutCfg.aspect === '16:9') {
        track = { ...track, title_text: null };
      }
      track = await captionsTracks.ensureAiEmphasis({ outputDir, clipId, track });
      // Caption style is now selectable per clip/client. v1 hard-locked every render to
      // 'viral-mozzo-plain' regardless of what was requested, which made the whole style
      // system dead code — editors asked for this to be openable.
      // Precedence: explicit request > the clip's saved track > the house default.
      const effectiveStyleId =
        captions.styleId || track.style_id || DEFAULT_CAPTION_STYLE_ID;
      if (track.style_id && track.style_id !== effectiveStyleId) {
        // A track cached under a previous style must not silently override the current
        // choice — that is how the old hard-lock kept reasserting itself.
        track = { ...track, style_id: effectiveStyleId };
      }
      const style = captionsStyles.loadStyle(effectiveStyleId);
      if (style && track.words.length > 0) {
        // Place captions at the layout's caption band, bottom-anchored so multi-line
        // captions grow upward into the safe area (never into a dead zone).
        const captionStyle = {
          ...style,
          y_offset_pct: layoutCfg.caption.y / layoutCfg.canvas.height,
          anchor: 'bottom',
        };
        const assPath = path.join(outputDir, 'captions', `${clipId}-${effectiveStyleId}-${layoutId}.ass`);
        captionsAss.writeAssFile(assPath, {
          track,
          style: captionStyle,
          frameDims,
          // Anchor to the input-seek origin (start - PREROLL) so burned captions align
          // with the spoken word. The output -ss PREROLL then shifts video + captions
          // together, leaving them in sync. (Anchoring to `startSeconds` made captions
          // appear ~PREROLL seconds early.) captionClipStart + PREROLL === startSeconds.
          clipStart: captionClipStart(startSeconds),
          titlePos: layoutCfg.title,
        });
        captionAssPath = assPath;
        captionFontsDir = captionsStyles.styleHasCustomFont(style) ? captionsStyles.fontsDir() : null;
        captionDetail = `captions ${effectiveStyleId} (${track.words.length} words${captionFontsDir ? ', custom font' : ', system font'})`;
      } else if (!style) {
        captionDetail = `captions style "${effectiveStyleId}" not found → skipping`;
      } else {
        captionDetail = 'no transcript words in clip range → skipping captions';
      }
    } catch (err) {
      console.warn(`[renderClip] caption generation failed for ${clipId}: ${err.message}`);
      captionDetail = `caption error → skipping (${err.message.slice(0, 80)})`;
    }
  }

  if (captionDetail) {
    console.log(`[renderClip] ${path.basename(outputPath)} · ${captionDetail}`);
  }

  // Frame-1 B-roll guard (split layouts only): screen recordings often start on a black
  // frame at the seek point. Probe once; the composer drops+clones it if so.
  let screenIsBlack = false;
  if (isSplit) {
    screenIsBlack = await hasBlackFirstFrame(FFMPEG, secondarySourcePath, startSeconds);
    if (screenIsBlack) {
      console.log(`[renderClip] ${path.basename(outputPath)} · Screen.mp4 black frame-1 at ${startSeconds.toFixed(2)}s → tpad clone fix applied`);
    }
  }

  // Build the filtergraph for this layout (camera = input 0, screen = input 1 if split).
  const graph = buildLayoutGraph({
    layoutId,
    cameraCropExpr: smartCropX,
    captionAssPath,
    fontsDir: captionFontsDir,
    screenHasBlackFirstFrame: screenIsBlack,
  });

  const isVertical = layoutCfg.aspect === '9:16';
  const targetBitrate = isVertical ? '4M' : '8M';

  const fadeS = 0.04;
  const fadeOutStart = Math.max(0, duration - fadeS).toFixed(3);
  const fadeParts = [];
  if (fadeIn) fadeParts.push(`afade=in:st=0:d=${fadeS.toFixed(3)}`);
  if (fadeOut) fadeParts.push(`afade=out:st=${fadeOutStart}:d=${fadeS.toFixed(3)}`);
  // Optional one-click enhancement runs BEFORE the edge fades: high-pass to kill low
  // rumble, light FFT denoise, then loudnorm to -16 LUFS. afade after so the level target
  // isn't re-touched by normalization.
  const enhanceParts = enhanceAudio
    ? ['highpass=f=80', 'afftdn=nr=12:nf=-25', 'loudnorm=I=-16:TP=-1.5:LRA=11']
    : [];
  const audioParts = [...enhanceParts, ...fadeParts];
  // anull keeps a valid -af when nothing applies (internal keeper segments, no enhance).
  const audioFilter = audioParts.length ? audioParts.join(',') : 'anull';

  const ext = path.extname(outputPath);
  const tmpOutput = outputPath.slice(0, -ext.length) + '.partial' + ext;
  try { fs.unlinkSync(tmpOutput); } catch {}

  // HYBRID SEEK (PREROLL defined above) — coarse input-seek to (start - PREROLL), then
  // accurate output-seek past PREROLL. Kills the dark first frame; captions are anchored
  // to the same origin so they stay in sync.
  const inSeek = (startSeconds - PREROLL).toFixed(3);
  const outSeek = PREROLL.toFixed(3);

  // All four layouts use filter_complex (banded canvas + overlays). Camera input always;
  // screen input only for split layouts.
  const args = [
    '-y',
    '-ss', inSeek, '-i', inputPath,
    ...(isSplit ? ['-ss', inSeek, '-i', secondarySourcePath] : []),
    '-ss', outSeek,             // accurate output seek — discards the dark pre-roll frame
    '-t', duration.toFixed(3),
    '-filter_complex', graph.videoFilter,
    '-map', '[v]',
    '-map', '0:a?',             // Camera audio (optional — falls through if missing)
    '-af', audioFilter,
    '-c:v', codec,
    ...(isMac ? ['-b:v', targetBitrate, '-tag:v', 'avc1'] : ['-preset', 'fast', '-crf', '20']),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    tmpOutput,
  ];

  await run(FFMPEG, args);
  fs.renameSync(tmpOutput, outputPath);
  return outputPath;
}

/** Returns the smart-crop x-expression (or null when not applicable/available). */
async function maybeComputeSmartCropX({ needed, cropMode, clipId, outputDir, inputPath, startSeconds, endSeconds, setDetail }) {
  if (!needed) return null;
  if (cropMode !== 'smart' || !clipId || !outputDir) {
    setDetail(`cropMode=${cropMode}`);
    return null;
  }
  const detected = await detectSubject({ sourcePath: inputPath, startSeconds, endSeconds, clipId, outputDir });
  if (detected && Array.isArray(detected.control_points) && detected.control_points.length >= 2) {
    // Cap at 30 control points — ffmpeg's expression parser rejects very long
    // nested if/lerp chains (observed failure at 122 points for a 193s clip).
    // Evenly subsample while always keeping the first and last points.
    const MAX_POINTS = 30;
    let pts = detected.control_points;
    if (pts.length > MAX_POINTS) {
      const step = (pts.length - 1) / (MAX_POINTS - 1);
      pts = Array.from({ length: MAX_POINTS }, (_, i) =>
        pts[Math.min(Math.round(i * step), pts.length - 1)],
      );
    }
    const xs = pts.map((p) => p.x_pct);
    const range = Math.max(...xs) - Math.min(...xs);
    setDetail(`smart trajectory ${pts.length} points (of ${detected.control_points.length}), x range ${range.toFixed(2)} (${detected.detector})`);
    return buildPiecewiseCropExpr(pts);
  }
  if (detected && Array.isArray(detected.control_points) && detected.control_points.length === 1) {
    const x = detected.control_points[0].x_pct;
    setDetail(`smart static x_pct=${x.toFixed(3)} (${detected.detector})`);
    return `max(0\\,min(in_w-1080\\,in_w*${x.toFixed(4)}-540))`;
  }
  setDetail('smart requested → fell back to center');
  return null;
}

/** Frame dimensions for a given layout/format pair. */
function pickFrameDims({ layout, format }) {
  if (layout === 'split-vertical') return { width: 1080, height: 1920 };
  if (layout === 'split-horizontal') return { width: 1920, height: 1080 };
  return format === 'vertical' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

function clipFileName(clipId, format, composition) {
  // Include composition so the SAME clip exported in different layouts produces distinct
  // files instead of overwriting (e.g. clip-c4-vertical-split.mp4 vs clip-c4-vertical-single.mp4).
  const comp = composition === 'split' ? 'split' : 'single';
  return `clip-${clipId}-${format}-${comp}.mp4`;
}

/**
 * Build a piecewise-linear ffmpeg crop x-expression from control points.
 *
 * Control points are { t (clip-local seconds), x_pct (0..1) }. Between consecutive
 * points we linearly interpolate using ffmpeg's built-in lerp(a,b,m) and between(t,a,b).
 * Outside the range we hold the boundary values (clamp).
 *
 * The returned expression evaluates to the desired x_pct * in_w - 540 for the cropleft,
 * then we wrap in max/min to clamp inside [0, in_w-1080]. `in_w` is the post-scale width
 * (after `scale=-2:1920`), which is what the crop filter sees.
 *
 * Commas inside the expression must be escaped with `\,` because the surrounding
 * filtergraph syntax uses comma as a filter separator.
 */
function buildPiecewiseCropExpr(controlPoints) {
  if (!controlPoints.length) return '(in_w-1080)/2';
  if (controlPoints.length === 1) {
    return `max(0\\,min(in_w-1080\\,in_w*${controlPoints[0].x_pct.toFixed(4)}-540))`;
  }

  // Build the nested if-chain. We use a chain of `if(lt(t, t_i), <left>, <right>)`.
  // Reading from the END so the innermost else is the final hold (last point).
  let expr = controlPoints[controlPoints.length - 1].x_pct.toFixed(4);
  for (let i = controlPoints.length - 1; i >= 1; i--) {
    const p0 = controlPoints[i - 1];
    const p1 = controlPoints[i];
    const t0 = p0.t.toFixed(3);
    const t1 = p1.t.toFixed(3);
    const x0 = p0.x_pct.toFixed(4);
    const x1 = p1.x_pct.toFixed(4);
    // lerp from x0 to x1 over [t0, t1]
    // ffmpeg supports lerp(a, b, m) = a + (b-a)*m
    const lerp = `lerp(${x0}\\,${x1}\\,(t-${t0})/(${t1}-${t0}))`;
    expr = `if(lt(t\\,${t1})\\,${lerp}\\,${expr})`;
  }
  // Hold first value if t < first.t (rare since first.t ≈ 0).
  const firstT = controlPoints[0].t.toFixed(3);
  const firstX = controlPoints[0].x_pct.toFixed(4);
  expr = `if(lt(t\\,${firstT})\\,${firstX}\\,${expr})`;

  return `max(0\\,min(in_w-1080\\,in_w*(${expr})-540))`;
}

/**
 * Returns true if the first decoded video frame of `videoPath` at `seekSeconds` is
 * predominantly black (mean 8-bit luma < 10). Used to detect screen recordings that
 * haven't started rendering content at the clip's seek point.
 *
 * Extracts a tiny 8×8 grayscale raw frame from stdout — fast (~100 ms) and best-effort:
 * any ffmpeg error resolves as false so the render never blocks.
 */
function hasBlackFirstFrame(ffmpegBin, videoPath, seekSeconds) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', seekSeconds.toFixed(3),
      '-i', videoPath,
      '-vframes', '1',
      '-vf', 'scale=8:8,format=gray',
      '-f', 'rawvideo',
      '-pix_fmt', 'gray8',
      'pipe:1',
    ]);
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('close', (code) => {
      if (code !== 0) { resolve(false); return; }
      const buf = Buffer.concat(chunks);
      if (buf.length < 64) { resolve(false); return; }
      const mean = buf.slice(0, 64).reduce((s, v) => s + v, 0) / 64;
      resolve(mean < 10);
    });
    proc.on('error', () => resolve(false));
  });
}

module.exports = { renderClip, clipFileName, buildPiecewiseCropExpr, seekPreroll, captionClipStart, DEFAULT_CAPTION_STYLE_ID };
