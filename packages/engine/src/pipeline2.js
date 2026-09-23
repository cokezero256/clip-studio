/**
 * Phase-1 orchestrator: link (or file) → transcript → candidates → planned clips → MP4s.
 *
 * Deliberately a plain async function with no database and no server, so the whole core
 * loop can be exercised from a CLI and proven before any of the app is built around it.
 * The worker will call exactly this.
 */

const fs = require('fs');
const path = require('path');

const { ingest, isUrl } = require('./ingest');
const { transcribe } = require('./transcribe');
const { generateCandidates } = require('./select/candidates');
const { planAllMeasured } = require('./select/plan');
const { groundedRank } = require('./select/ground');
const { verifyRenderedFile, trimTrailingSilence } = require('./select/measure');
const { measurePauses } = require('./select/pauses');
const { keptSpans } = require('./select/gates');
const { assertCapabilities } = require('./capabilities');
const { renderClip } = require('./clip-renderer');
const { planComposition } = require('./compose/detect-regions');
const { locatePanes } = require('./compose/locate-panes');
const { renderRecomposedSpan, probeDimensions, resolveBands, seamY } = require('./compose/recompose');
const captionTracks = require('./captions/track-store');
const captionStyles = require('./captions/style-store');
const captionAss = require('./captions/ass-generator');
const ffmpeg = require('./ffmpeg');

const noop = () => {};

/**
 * Scope a transcript to one render span.
 *
 * The caption generator anchors each word with `max(0, word.start - clipStart)`. Hand a
 * segment the whole clip's words and every word outside that segment clamps to 0, so they
 * all draw at once on top of each other. Exported so this stays under test.
 */

/** Length of an audio file in seconds via ffprobe, or 0 when it cannot be read. */
async function audioDurationOf(audioPath) {
  try {
    const { execFile } = require('child_process');
    const ffprobe = process.env.FFPROBE_BIN || require('ffprobe-static').path;
    return await new Promise((resolve) => {
      execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', audioPath],
        (err, out) => resolve(err ? 0 : parseFloat(String(out).trim()) || 0));
    });
  } catch { return 0; }
}

function scopeTranscript(transcript, startSeconds, endSeconds) {
  if (!transcript) return transcript;
  return {
    ...transcript,
    /*
     * A word belongs to the span it STARTS in. The old rule kept any word that merely
     * overlapped, so a word straddling a cut was captioned in BOTH neighbouring spans —
     * flashing for a few frames before the cut, i.e. before it was said, and again after.
     * The 50 ms slack keeps a word whose start sits a hair before a span that was itself
     * snapped to that word.
     */
    words: (transcript.words || []).filter((w) => w.start >= startSeconds - 0.05 && w.start < endSeconds),
    segments: (transcript.segments || []).filter((g) => g.end > startSeconds && g.start < endSeconds),
  };
}

/**
 * Render one planned clip. When the clip has cuts, each kept span is rendered separately
 * and the pieces are concatenated — this is how the removed silence actually leaves the
 * file. Fade rules matter: only the FIRST span fades in and only the LAST fades out, or
 * every internal join dips to silence and you hear each cut.
 */
/**
 * Re-composed render path: one 16:9 source with a webcam and a screen-share becomes a
 * filled 9:16 frame (chart over trader), instead of the whole landscape frame letterboxed
 * into a thin strip. This is how the reference reels are actually cut.
 */
async function renderRecomposedClip(clip, {
  inputPath, outputDir, clipId, transcript, captionsEnabled = true, styleId,
  titleText, composition, layoutDoc, paneOrder, captionSizePx, titleSizePx,
  // null = whole clip. See compose/band-clip.js for why the old 8 s default was wrong.
  titleSeconds = null,
  onProgress = noop,
}) {
  let pendingPlate = null;
  const spans = keptSpans({
    start_seconds: clip.start_seconds, end_seconds: clip.end_seconds,
    manual_cuts: clip.manual_cuts,
  });
  const finalPath = path.join(outputDir, 'clips', clipId, `${clipId}-recompose.mp4`);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const dims = probeDimensions(inputPath);

  const segPaths = [];
  for (let i = 0; i < spans.length; i++) {
    const segTranscript = scopeTranscript(transcript, spans[i].start, spans[i].end);
    let assPath = null;

    if (captionsEnabled && segTranscript && segTranscript.words.length) {
      const segId = `${clipId}-rc${i}`;
      const track = captionTracks.loadOrGenerateTrack({
        outputDir, clipId: segId,
        clip: { id: segId, start_seconds: spans[i].start, end_seconds: spans[i].end },
        transcript: segTranscript,
        defaultStyleId: styleId || 'open-sans-viral',
      });
      const style = captionStyles.loadStyle(styleId || 'open-sans-viral');
      if (style && track.words.length) {
        assPath = path.join(outputDir, 'captions', `${segId}-recompose.ass`);
        fs.mkdirSync(path.dirname(assPath), { recursive: true });

        const bands = resolveBands(layoutDoc, paneOrder);
        const seam = seamY(bands);
        // The title plate rides ON the seam between the panes, which is where every
        // reference reel puts it. Only the first span carries it — repeating it on each
        // span would restart its timing at every cut.
        /**
         * The title is a CoreText plate composited after the concat, not ASS text.
         * libass cannot render colour emoji (they came out as tofu boxes), and tying the
         * title to a span made it vanish when that span ended.
         */
        if (titleText && i === 0 && !pendingPlate) {
          const { renderPlate } = require('./compose/title-plate');
          const bands0 = resolveBands(layoutDoc, paneOrder);
          const plate = renderPlate({
            text: titleText,
            outDir: path.join(outputDir, 'clips', clipId),
            fontName: (style.header && style.header.font_family) || 'Sequel Sans Bold Head',
            fontSize: titleSizePx || layoutDoc.title.fontSize || 62,
            textColor: (style.header && style.header.box && style.header.box.text_color) || '#111111',
            fill: (style.header && style.header.box && style.header.box.fill) || '#FFFFFF',
            radius: (style.header && style.header.box && style.header.box.radius) || 24,
            maxWidth: Math.round(layoutDoc.canvas.width * 0.9),
          });
          if (plate) {
            plate.x = Math.round((layoutDoc.canvas.width - plate.width) / 2);
            plate.y = Math.round(seamY(bands0) - plate.height / 2);
            pendingPlate = plate;
          }
        }

        captionAss.writeAssFile(assPath, {
          track: { ...track, title_text: null },
          style: {
            ...style,
            font_size_px: captionSizePx || style.font_size_px,
            y_offset_pct: layoutDoc.caption.y / layoutDoc.canvas.height,
            anchor: 'bottom',
          },
          frameDims: { width: layoutDoc.canvas.width, height: layoutDoc.canvas.height },
          // Same hybrid-seek origin the caption invariant is locked to.
          clipStart: require('./clip-renderer').captionClipStart(spans[i].start),
        });
      }
    }

    const segPath = spans.length === 1
      ? finalPath
      : path.join(outputDir, 'clips', clipId, `.rc${i}.mp4`);
    onProgress({ stage: 'render', message: `recompose span ${i + 1}/${spans.length}` });
    await renderRecomposedSpan({
      inputPath, startSeconds: spans[i].start, endSeconds: spans[i].end,
      outputPath: segPath,
      srcW: dims.width, srcH: dims.height,
      cam: composition.cam, screen: composition.screen,
      layout: layoutDoc, paneOrder, assPath, fontsDir: captionStyles.FONTS_DIR,
      fadeIn: i === 0, fadeOut: i === spans.length - 1,
    });
    segPaths.push(segPath);
  }

  if (segPaths.length > 1) {
    onProgress({ stage: 'render', message: `joining ${segPaths.length} spans` });
    await ffmpeg.concatAccurate(segPaths, finalPath);
    for (const p of segPaths) { try { fs.unlinkSync(p); } catch {} }
  }

  // Title after the join, so its duration is a choice rather than an accident of how the
  // silence cuts happened to fall.
  if (pendingPlate) {
    const { overlayTitle } = require('./compose/overlay-title');
    onProgress({ stage: 'title', message: titleSeconds ? `title held ${titleSeconds}s` : 'title held for the whole clip' });
    await overlayTitle(finalPath, pendingPlate, { seconds: titleSeconds });
  }
  return finalPath;
}

async function renderPlannedClip(clip, {
  inputPath, outputDir, clipId, format = 'vertical', layout = 'single',
  secondarySourcePath = null, transcript, captionsEnabled = true, styleId, titleText,
  onProgress = noop,
}) {
  const spans = keptSpans({
    start_seconds: clip.start_seconds,
    end_seconds: clip.end_seconds,
    manual_cuts: clip.manual_cuts,
  });
  const finalPath = path.join(outputDir, 'clips', clipId, `${clipId}-${format}.mp4`);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });

  const common = {
    inputPath, format, layout, secondarySourcePath, outputDir,
    cropMode: 'center',
    clip: { ...clip, id: clipId, title_text: titleText || null },
    captions: captionsEnabled
      ? { enabled: true, transcript, styleId, titleText: titleText || null }
      : null,
  };

  if (spans.length === 1) {
    onProgress({ stage: 'render', message: 'single span' });
    await renderClip({
      ...common, clipId,
      startSeconds: spans[0].start, endSeconds: spans[0].end,
      outputPath: finalPath, fadeIn: true, fadeOut: true,
    });
    return finalPath;
  }

  const segPaths = [];
  for (let i = 0; i < spans.length; i++) {
    const segPath = path.join(outputDir, 'clips', clipId, `.seg${i}.mp4`);
    onProgress({ stage: 'render', message: `span ${i + 1}/${spans.length}` });

    /**
     * Each segment gets a transcript scoped to ITS OWN span.
     *
     * The caption generator anchors words with `max(0, word.start - clipStart)`, so if a
     * segment is handed the whole clip's words, every word outside that segment clamps to
     * 0 and they all render simultaneously, stacked at the same centred position. That is
     * exactly what happened: 47 caption events all stamped 0:00:00.00→0:00:00.20, drawing
     * "candle" and "closes." on top of each other.
     */
    const segTranscript = scopeTranscript(transcript, spans[i].start, spans[i].end);

    await renderClip({
      ...common,
      // The clip handed to the caption layer must describe THIS span, not the whole clip.
      clip: { ...common.clip, start_seconds: spans[i].start, end_seconds: spans[i].end },
      captions: captionsEnabled
        ? { enabled: true, transcript: segTranscript, styleId, titleText: titleText || null }
        : null,
      clipId: `${clipId}-seg${i}`,
      startSeconds: spans[i].start,
      endSeconds: spans[i].end,
      outputPath: segPath,
      fadeIn: i === 0,                    // only the first span fades in
      fadeOut: i === spans.length - 1,    // only the last fades out
    });
    segPaths.push(segPath);
  }

  onProgress({ stage: 'render', message: `joining ${segPaths.length} spans` });
  // concat FILTER (not the demuxer) — the demuxer leaves AAC priming gaps at every join,
  // which would reintroduce exactly the dead air we just removed.
  await ffmpeg.concatAccurate(segPaths, finalPath);
  for (const p of segPaths) { try { fs.unlinkSync(p); } catch {} }
  return finalPath;
}

/**
 * Full run. `input` is a URL or a local path.
 * Returns the planned clips plus whatever was rendered.
 */
async function run(input, {
  workDir, clientConfig = {}, maxRender = 3, format = 'vertical', layout = 'single',
  secondarySourcePath = null, render = true, captionsEnabled = true, styleId,
  paneOrder = null, captionSizePx = null, titleSizePx = null, titles = {},
  /**
   * Optional: ({ clip, transcriptText }) => Promise<string|null>.
   *
   * The band treatment RESERVES space above the frame for a title, so a clip rendered
   * without one leaves a large empty black band — worse-looking than no treatment at all.
   * Titles were only ever generated by the operator clicking "Suggest titles" in the UI,
   * which the automatic path never does. Injected rather than imported so the engine keeps
   * no database dependency: the caller supplies the corpus grounding.
   */
  generateTitle = null,
  groundingCorpus = null,
  onProgress = noop, selectOptions = {},
} = {}) {
  assertCapabilities({ verbose: true });
  fs.mkdirSync(workDir, { recursive: true });

  // 1 — source
  onProgress({ stage: 'ingest', message: isUrl(input) ? 'fetching' : 'reading local file' });
  const src = await ingest(input, path.join(workDir, 'sources'), { onProgress });
  const outputDir = src.outDir;

  // 2 — transcript (starts while the video is still downloading)
  // Say how much audio there is, then move the bar with whisper's own percentages: the
  // transcription is most of a stream's wait, and a bar that sits still reads as "stuck".
  const audioSeconds = await audioDurationOf(src.audioPath);
  const audioLabel = audioSeconds ? ` · ${Math.floor(audioSeconds / 3600) ? `${Math.floor(audioSeconds / 3600)} h ` : ''}${Math.round((audioSeconds % 3600) / 60)} min of audio` : '';
  onProgress({ stage: 'transcribe', message: `whisper.cpp${audioLabel}`, progress: 0.2 });
  const transcript = await transcribe(src.audioPath, {
    onProgress: (p) => {
      if (p && p.percent != null) {
        onProgress({ stage: 'transcribe', message: `transcribing ${p.percent}%${audioLabel}`, progress: 0.2 + 0.5 * (p.percent / 100) });
      } else if (p && p.stage) onProgress(p);
    },
  });
  const videoPath = await src.video;

  /**
   * 3 — search (deterministic).
   *
   * Silences are measured from the waveform ONCE and fed to candidate generation, because
   * the transcript cannot supply them: whisper.cpp tiles word timings so consecutive words
   * touch even across seconds of real silence. Without this the boundary finder saw one
   * clause per 63 words and most candidates ended mid-sentence; with it, one per 12.
   */
  onProgress({ stage: 'select', message: 'measuring pauses across the source' });
  let silenceRegions = null;
  try {
    silenceRegions = await measurePauses(src.audioPath, 0, transcript.duration || 0, { minPause: 0.4, protect: (transcript.words || []).map((w) => w.start) });
    onProgress({ stage: 'select', message: `${silenceRegions.length} pauses measured` });
  } catch (err) {
    onProgress({ stage: 'select', message: `pause measurement failed (${String(err.message).slice(0, 60)})`, level: 'error' });
  }

  onProgress({ stage: 'select', message: 'generating candidates' });
  const { candidates, stats } = generateCandidates(transcript, { ...selectOptions, silenceRegions });

  // 4 — plan: cuts from MEASURED audio silence, then gate
  onProgress({ stage: 'plan', message: `${candidates.length} candidates` });
  const planned = await planAllMeasured(candidates, transcript, src.audioPath, {
    ...clientConfig, ...selectOptions, silenceRegions,
  });
  let ready = planned.filter((p) => p.ready);

  /**
   * 4a — RANK AGAINST THE CORPUS.
   *
   * Until now ranking used nine coefficients written by hand. They ordered clips by "dense,
   * number-heavy speech", which is not the same thing as "a moment that works on these
   * pages". Here each surviving clip is judged against real clips from the tracked pages,
   * winners and flops alike, and the corpus verdict leads the ordering.
   */
  if (groundingCorpus && groundingCorpus.length && ready.length) {
    onProgress({ stage: 'rank', message: `ranking ${ready.length} clips against ${groundingCorpus.length} real ones` });
    try {
      ready = await groundedRank(ready, groundingCorpus, { batch: 5 });
      // Merge the verdicts back onto `planned` — that is what gets persisted, and grounding
      // ran on a filtered copy, so without this the reasoning is computed and thrown away.
      const byStart = new Map(ready.map((c) => [c.start_seconds.toFixed(3), c]));
      for (let i = 0; i < planned.length; i++) {
        const g = byStart.get(planned[i].start_seconds.toFixed(3));
        if (g) {
          planned[i] = {
            ...planned[i],
            verdict: g.verdict, corpusScore: g.corpusScore,
            why: g.why, closestExemplar: g.closestExemplar, failureMode: g.failureMode,
          };
        }
      }
      const shipped = ready.filter((c) => c.verdict === 'ship').length;
      onProgress({ stage: 'rank', message: `${shipped} rated "ship" of ${ready.length}` });
    } catch (err) {
      onProgress({ stage: 'rank', message: `corpus ranking unavailable (${String(err.message).slice(0, 80)}) — using local scores`, level: 'error' });
    }
  }

  // 4b — decide framing. A single 16:9 source holding both a webcam and a screen-share
  // is re-composed rather than letterboxed.
  let composition = null;
  let layoutDoc = null;
  // The source already carries its own webcam inset — keep the frame whole (band treatment)
  // instead of re-cropping it.
  let useBand = false;
  if (format === 'vertical' && layout === 'auto') {
    onProgress({ stage: 'compose', message: 'locating panes' });
    const probeAt = Math.min(120, Math.max(20, (transcript.duration || 120) / 3));

    /**
     * Vision first, variance as the free fallback.
     *
     * Temporal variance finds a side-by-side split precisely when the background is static,
     * but trading streams often run a live order-flow heatmap that animates more than the
     * person does — on such a source the variance map's strongest blob was the CHART and the
     * webcam was invisible to it. One vision call per source settles the layout definitively
     * and is cached with the source.
     */
    try {
      composition = await locatePanes(videoPath, { atSeconds: probeAt });
    } catch (err) {
      onProgress({ stage: 'compose', message: `vision unavailable (${String(err.message).slice(0, 60)}) — using motion analysis`, level: 'error' });
      composition = planComposition(videoPath, { startSeconds: probeAt });
    }

    /**
     * A SOURCE THAT ALREADY HAS A WEBCAM INSET IS ALREADY COMPOSED. Leave it whole.
     *
     * This used to convert a corner-webcam source into a "split" and crop the chart out of
     * whichever half the webcam was not in. The justification was that letterboxing left
     * the content in a thin strip with most of the canvas black — true, but the fix for
     * black canvas is to PUT THE TITLE IN IT, which is what the band treatment does.
     *
     * Measured on a real rp.profits stream: the recomposed output blew the chart past
     * readability, stacked it over an unrelated crop of the order ladder, and left a ghost
     * strip of the original webcam above the re-placed inset. The band render of the same
     * clip kept the trader's own framing intact and read cleanly. The operator's verdict
     * was "the format is entirely bad ... this cannot happen in other videos", so this is
     * now a hard rule rather than a heuristic: never re-crop a frame the trader already
     * composed.
     */
    if (composition.mode === 'pip' && composition.cam) {
      useBand = true;
      const onRight = composition.cam.x + composition.cam.w / 2 > 0.5;
      onProgress({
        stage: 'compose',
        message: `webcam inset found ${onRight ? 'bottom-right' : 'bottom-left'} — keeping the frame whole, title above`,
      });
    }

    if (composition.mode === 'split' && !useBand) {
      layoutDoc = JSON.parse(fs.readFileSync(
        require('./paths').configPath('layouts', 'layout-5-vertical-recompose.json'), 'utf-8'));
      onProgress({ stage: 'compose', message: `split detected (camera ${composition.camSide}, confidence ${composition.confidence})` });
    } else if (!useBand) {
      onProgress({ stage: 'compose', message: `letterbox — ${composition.reason || composition.mode || 'no split found'}` });
    }
  }

  /**
   * 5 — render only what is worth rendering.
   *
   * Previously this rendered the top N by local score regardless of quality, which is how
   * three mediocre clips got produced from a livestream that contained one decent moment.
   * When the corpus has judged them, anything it rated "cut" is not rendered at all — and
   * if nothing survives, that is reported rather than papered over with filler.
   */
  /** The words spoken inside a span, as plain text — what a title must be grounded in. */
  const scopeText = (tr, a, b) => (tr.words || [])
    .filter((w) => w.end > a && w.start < b)
    .map((w) => w.word)
    .join(' ');

  const renders = [];
  // Which band arrangement the automatic path uses. `paneOrder` carries the choice when the
  // caller made one (the UI sends 'band-title-top' and friends through the same field).
  const bandVariant = String(paneOrder || '').startsWith('band-') ? paneOrder : 'band-title-top';
  const worthRendering = ready.some((c) => c.verdict)
    ? ready.filter((c) => c.verdict === 'ship' || c.verdict === 'maybe')
    : ready;

  if (render && !worthRendering.length && ready.length) {
    onProgress({
      stage: 'render',
      message: `nothing worth rendering — all ${ready.length} candidates rated "cut" against the corpus`,
      level: 'error',
    });
  }

  if (render && worthRendering.length) {
    const toRender = worthRendering.slice(0, maxRender);
    for (let i = 0; i < toRender.length; i++) {
      const clip = toRender[i];
      const clipId = `c${i + 1}-${Math.round(clip.start_seconds)}`;
      onProgress({ stage: 'render', message: `clip ${i + 1}/${toRender.length}` });
      try {
        // Resolve the title BEFORE rendering: a saved one wins, then a caller-supplied
        // one, then generation. A generation failure must never fail the render.
        let titleText = titles[clipId] ?? clip.titleText ?? null;
        if (!titleText && generateTitle) {
          const text = scopeText(transcript, clip.start_seconds, clip.end_seconds);
          if (text.trim().length >= 40) {
            onProgress({ stage: 'title', message: `writing a title for clip ${i + 1}` });
            try {
              titleText = await generateTitle({ clip, transcriptText: text });
              // Persist onto the planned clip so replaceClips() stores it and the card
              // shows the same title that is burned into the file.
              if (titleText) clip.titleText = titleText;
              if (titleText) onProgress({ stage: 'title', message: `"${String(titleText).slice(0, 48)}"` });
              else onProgress({ stage: 'title', message: 'no title passed the grounding check', level: 'error' });
            } catch (err) {
              onProgress({ stage: 'title', message: `title generation failed (${String(err.message).slice(0, 60)})`, level: 'error' });
            }
          }
        }
        const out = useBand
          ? await require('./compose/band-clip').renderBandClip({
              inputPath: videoPath, outputDir, clipId,
              variant: bandVariant,
              startSeconds: clip.start_seconds, endSeconds: clip.end_seconds,
              manualCuts: clip.manual_cuts || [],
              transcript, styleId, captionsEnabled,
              titleText,
              onProgress,
            })
          : layoutDoc
          ? await renderRecomposedClip(clip, {
              inputPath: videoPath, outputDir, clipId, transcript, captionsEnabled,
              styleId, titleText,
              composition, layoutDoc, paneOrder, captionSizePx, titleSizePx, onProgress,
            })
          : await renderPlannedClip(clip, {
              inputPath: videoPath, outputDir, clipId, format,
              layout: layout === 'auto' ? 'single' : layout,
              secondarySourcePath, transcript, captionsEnabled, styleId,
              titleText, onProgress,
            });
        // Trim the trailing silence the renderer's fade + the final word's stretched
        // timestamp leave behind, THEN gate.
        onProgress({ stage: 'verify', message: clipId });
        const trim = await trimTrailingSilence(out);
        // THE GATE THAT COUNTS — verify the produced file, not the plan.
        const verdict = await verifyRenderedFile(out);
        // The title travels WITH the render: `clip` here may be a ranked copy of the planned
        // row, so a title written onto it never reached the database — the card showed no title
        // while the file had one burned in.
        renders.push({ clipId, path: out, clip, verify: verdict, trim, titleText });
      } catch (err) {
        renders.push({ clipId, error: err.message, clip });
      }
    }
  }

  const manifest = {
    input, sourceKey: src.key, outputDir,
    meta: src.meta,
    transcript: { words: transcript.words.length, engine: transcript.engine, model: transcript.model },
    selection: stats,
    clips: planned.map((p) => ({
      start: p.start_seconds, end: p.end_seconds, duration: p.finalDurationSeconds,
      ready: p.ready, prescore: p.prescore, hook: p.hook,
      corpusScore: p.corpusScore ?? null, verdict: p.verdict ?? null,
      closestExemplar: p.closestExemplar ?? null, why: p.why ?? null,
      cuts: p.cutsApplied, silenceRemovedMs: p.silenceRemovedMs,
      gate: p.gate.results.map((g) => ({ id: g.id, passed: g.passed, detail: g.detail })),
    })),
    renders: renders.map((r) => ({ clipId: r.clipId, path: r.path, error: r.error })),
  };
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { transcript, planned, ready, renders, stats, outputDir, videoPath, manifest };
}

module.exports = { run, renderPlannedClip, renderRecomposedClip, scopeTranscript };
