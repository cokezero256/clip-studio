/**
 * The worker.
 *
 * This process exists so that ffmpeg, yt-dlp and whisper NEVER run inside the web server.
 * v1 ran the whole pipeline in the Next request handler via an `eval('require')` bridge,
 * which meant: a render outlived its own HTTP request (the UI resorted to a 2-minute abort
 * plus 8 minutes of HEAD-polling a file path), cancelling could only SIGKILL every ffmpeg
 * on the machine and hope, and restarting the dev server killed in-flight work.
 *
 * Here the web app only ever writes a job row. This claims it, runs it, and streams
 * progress into job_event.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const db = require('@clip-studio/db');
const { run } = require('@clip-studio/engine/src/pipeline2');
const { assertCapabilities } = require('@clip-studio/engine/src/capabilities');
const { sourceKey } = require('@clip-studio/engine/src/ingest');
const { processPage } = require('@clip-studio/engine/src/outliers/pipeline');

const OWNER = `${os.hostname()}:${process.pid}`;
const REFRESH_DAYS = Number(process.env.OUTLIER_REFRESH_DAYS || 7);
const POLL_MS = 1000;
const LEASE_S = 60;
const DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');

let shuttingDown = false;
/**
 * Two lanes, one process. Everything the editor waits on (a preview proxy, an export, pane
 * detection) is seconds of work; a stream is ten minutes of whisper. With one queue the
 * editor sat behind the stream — measured: four editor jobs waiting on one transcription.
 * The fast lane never touches a `process` job, the slow lane never touches an editor job,
 * so both make progress; ffmpeg and whisper side by side are fine on this machine.
 */
const LANES = {
  fast: ['proxy', 'render-clip', 'locate-panes', 'read-titles'],
  slow: ['process', 'outliers', 'reclassify', 'classify-pending', 'transcribe-outliers'],
};
const activeJobs = new Map();   // lane → job id

/**
 * Singleton guard.
 *
 * A second worker is not merely wasteful — an OLD one races the new one for jobs and wins
 * often enough to matter. That happened repeatedly here: a worker started via `npm run
 * worker` runs `node src/main.js` from a different cwd, so a pkill pattern written for
 * `apps/worker/src/main.js` missed it, and the stale process kept claiming jobs whose
 * handlers it did not have — failing them with "Unknown job type" while the new worker sat
 * idle. A lock file makes that impossible rather than relying on remembering to kill it.
 */
function acquireLock() {
  const lockPath = path.join(DATA_DIR, 'worker.lock');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(lockPath)) {
    const prev = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
    if (Number.isFinite(prev) && prev !== process.pid) {
      try {
        process.kill(prev, 0);            // throws if that pid is gone
        console.error(
          `[worker] another worker is already running (pid ${prev}).\n` +
          `         Stop it first:  kill ${prev}\n` +
          `         Running two lets a stale one claim jobs it cannot handle.`
        );
        process.exit(1);
      } catch {
        console.log(`[worker] clearing stale lock from dead pid ${prev}`);
      }
    }
  }
  fs.writeFileSync(lockPath, String(process.pid));
  // The web app reads this to tell the editor whether a worker is alive and how old its code
  // is (the worker caches modules at start — a rebuilt engine needs a restart, a trap that
  // bit repeatedly). The lock itself stays a bare pid: existing code parses it as one.
  fs.writeFileSync(path.join(DATA_DIR, 'worker.status.json'), JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname(),
    capabilities: (() => { try { return require('@clip-studio/engine/src/capabilities').checkTools(); } catch { return null; } })(),
    setup: null,
  }));
  const release = () => { try { if (fs.readFileSync(lockPath, 'utf-8').trim() === String(process.pid)) fs.unlinkSync(lockPath); } catch {} };
  process.on('exit', release);
  return release;
}

/** A cancel flips a flag in the DB; the pipeline checks it between stages. */
function isCancelled(jobId) {
  const j = db.getJob(jobId);
  return !j || j.cancel_requested === 1;
}

async function handleProcess(job, payload) {
  const { input, clientId = null, format = 'vertical', layout = 'auto',
          styleId = 'open-sans-viral', maxRender = 3,
          paneOrder = null, selectOptions = {}, referenceShortcode = null } = payload;

  const key = sourceKey(input);
  const source = db.createSource({ input, sourceKey: key, clientId });
  db.updateSource(source.id, { status: 'processing' });
  if (!job.source_id) {
    db.getDb().prepare('UPDATE job SET source_id=? WHERE id=?').run(source.id, job.id);
  }

  // Map the engine's progress callbacks onto the durable event log.
  const stageWeights = { ingest: 0.15, transcribe: 0.45, select: 0.55, plan: 0.6, compose: 0.65, render: 0.95, verify: 1 };
  const onProgress = (p) => {
    if (isCancelled(job.id)) throw new Error('cancelled');
    const base = stageWeights[p.stage] ?? null;
    db.emit(job.id, {
      stage: p.stage,
      message: p.message || (p.percent != null ? `${p.percent}%` : ''),
      progress: base,
    });
  };

  if (referenceShortcode) {
    db.emit(job.id, { stage: 'select', message: `matching the shape of ${referenceShortcode}` });
  }
  // Hand the pipeline the corpus so ranking is judged against real clips from the tracked
  // pages rather than hand-written weights.
  const corpus = db.groundingCorpus({ limit: 120 });
  if (corpus.length) {
    db.emit(job.id, { stage: 'select', message: `grounding on ${corpus.length} real clips from the tracked pages` });
  } else {
    db.emit(job.id, { stage: 'select', message: 'no grounding corpus yet — ranking on local signals only', level: 'error' });
  }

  /**
   * Write the burned-in title automatically.
   *
   * The band treatment reserves space above the frame for a title, so a clip rendered
   * without one leaves a large empty black band. Titles previously existed only behind a
   * "Suggest titles" click, which the automatic path never performs — so every batch clip
   * shipped with that space empty. Grounded on the corpus WINNERS AND FLOPS: without duds
   * the model learns "a trading title" rather than what separates one that worked from one
   * that didn't. Every candidate is then gated against the clip's own transcript, so a
   * title cannot promise something the clip does not contain.
   */
  const { generateVerifiedTitles } = require('@clip-studio/engine/src/titles/generate');
  const titleExemplars = db.getDb().prepare(
    `SELECT ocr_title, display_mult FROM post
     WHERE ocr_title IS NOT NULL AND z >= 0.8 ORDER BY z DESC LIMIT 8`).all();
  const titleFlops = db.getDb().prepare(
    `SELECT ocr_title, display_mult FROM post
     WHERE ocr_title IS NOT NULL AND z < -0.3 ORDER BY z LIMIT 4`).all();

  const generateTitle = async ({ transcriptText }) => {
    const r = await generateVerifiedTitles({
      transcriptText, exemplars: titleExemplars, flops: titleFlops,
    });
    // Only a title that passed the grounding check may be burned in.
    return r.accepted.length ? r.accepted[0].title : null;
  };

  const result = await run(input, {
    workDir: path.join(DATA_DIR, 'media'),
    maxRender, format, layout, styleId, paneOrder, selectOptions,
    groundingCorpus: corpus,
    generateTitle: titleExemplars.length ? generateTitle : null,
    onProgress,
  });

  db.updateSource(source.id, {
    status: 'ready',
    title: result.manifest.meta.title || null,
    uploader: result.manifest.meta.uploader || null,
    duration_s: result.manifest.meta.durationSeconds || null,
    work_dir: result.outputDir,
    video_path: result.videoPath,
    audio_path: path.join(result.outputDir, 'audio.16k.wav'),
  });

  db.replaceClips(source.id, result.planned);

  // Attach renders to their clip rows so history accumulates instead of overwriting.
  const clipRows = db.listClips(source.id);
  for (const r of result.renders) {
    if (!r.path) continue;
    const match = clipRows.find(
      (c) => Math.abs(c.start_s - r.clip.start_seconds) < 0.05
    );
    if (!match) continue;
    // Keep the card honest: the title burned into the file is the clip's title.
    if (r.titleText && !match.title_text) {
      db.getDb().prepare('UPDATE clip SET title_text=? WHERE id=?').run(r.titleText, match.id);
    }
    let bytes = null;
    try { bytes = fs.statSync(r.path).size; } catch {}
    db.addRender({
      clipId: match.id, path: r.path, format, layout,
      captionStyle: styleId, bytes,
      durationS: r.verify ? r.verify.durationSeconds : null,
      verify: r.verify,
    });
  }

  db.emit(job.id, {
    stage: 'done',
    message: `${result.ready.length} of ${result.planned.length} clips ready, ${result.renders.filter((x) => x.path).length} rendered`,
    progress: 1,
  });
  return { sourceId: source.id };
}

/**
 * Refresh the outlier corpus.
 *
 * Runs page by page and persists after EACH page rather than at the end — Instagram CDN
 * urls expire, Apify can rate-limit, and losing six pages of work because the seventh
 * failed is the obvious way to waste a run.
 */
async function handleOutliers(job, payload) {
  const {
    pages = null, days = Number(process.env.OUTLIER_WINDOW_DAYS || 60),
    maxDownloads = 12, classify = true,
  } = payload;

  const all = db.listPages();
  const targets = pages && pages.length
    ? all.filter((p) => pages.includes(p.username))
    : all;

  const mediaRoot = path.join(DATA_DIR, 'outliers');
  let totalPosts = 0;
  let totalOutliers = 0;
  let totalDownloaded = 0;

  for (let i = 0; i < targets.length; i++) {
    const page = targets[i];
    if (isCancelled(job.id)) throw new Error('cancelled');
    db.emit(job.id, {
      stage: 'page',
      message: `${page.username} (${i + 1}/${targets.length})`,
      progress: i / targets.length,
    });

    try {
      const res = await processPage(page.username, {
        mediaRoot, days, maxDownloads, classify,
        onProgress: (p) => db.emit(job.id, { stage: p.stage, message: p.message, level: p.level }),
      });
      db.upsertPosts(page.id, res.posts);
      totalPosts += res.posts.length;
      totalOutliers += res.posts.filter((x) => x.isOutlier).length;
      totalDownloaded += res.downloaded;
    } catch (err) {
      db.emit(job.id, {
        stage: 'error',
        message: `${page.username}: ${String(err.message).slice(0, 200)}`,
        level: 'error',
      });
    }
  }

  db.emit(job.id, {
    stage: 'done',
    message: `${totalPosts} posts across ${targets.length} pages · ${totalOutliers} outliers · ${totalDownloaded} downloaded & classified`,
    progress: 1,
  });
}

/**
 * Re-classify rows that were stored before the chart attributes were persisted.
 *
 * Those rows have a format label but no has_chart / chart_share, so the clips-only filter
 * can only fall back to the label — and the label is exactly the unreliable part (a
 * split-screen gets called a talking head whenever the face is prominent). Cheap to fix:
 * the frames are already on disk, so this is a vision call and nothing else.
 */
async function handleReclassify(job, payload) {
  const fs = require('fs');
  const { classifyReel } = require('@clip-studio/engine/src/outliers/classify');
  const rows = db.postsNeedingAttributes(payload.limit ?? 500);
  db.emit(job.id, { stage: 'start', message: `${rows.length} rows need chart attributes`, progress: 0 });

  let done = 0;
  let failed = 0;
  for (const r of rows) {
    if (isCancelled(job.id)) throw new Error('cancelled');
    try {
      const dir = path.join(r.media_dir, 'frames');
      if (!fs.existsSync(dir)) { failed++; continue; }
      const frames = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
      if (!frames.length) { failed++; continue; }
      const pick = [1, 4, 7, 10].map((i) => frames[Math.min(i, frames.length - 1)]);
      const b64 = [...new Set(pick)].map((f) => fs.readFileSync(path.join(dir, f)).toString('base64'));
      const c = await classifyReel({ frames: b64, title: r.ocr_title, caption: r.caption });
      db.updateClassification(r.shortcode, c);
      done++;
      db.emit(job.id, {
        stage: 'reclassify',
        message: `${r.shortcode}: ${c.format} (chart ${c.has_chart ? Math.round((c.chart_share ?? 0) * 100) + '%' : 'no'})`,
        progress: done / Math.max(1, rows.length),
      });
    } catch (err) {
      failed++;
      db.emit(job.id, { stage: 'error', message: `${r.shortcode}: ${String(err.message).slice(0, 120)}`, level: 'error' });
    }
  }
  db.emit(job.id, { stage: 'done', message: `${done} re-classified, ${failed} skipped`, progress: 1 });
}

/** Process posts that were scraped but never downloaded, so they can be filtered. */
async function handleClassifyPending(job, payload) {
  const { processPending } = require('@clip-studio/engine/src/outliers/pipeline');
  const rows = db.pendingPosts({ minZ: payload.minZ ?? 0, limit: payload.limit ?? 200 });
  db.emit(job.id, { stage: 'start', message: `${rows.length} scraped posts to process`, progress: 0 });

  const mediaRoot = path.join(DATA_DIR, 'outliers');
  let done = 0;
  for (const post of rows) {
    if (isCancelled(job.id)) throw new Error('cancelled');
    const [res] = await processPending([post], {
      mediaRoot,
      onProgress: (p) => db.emit(job.id, { stage: p.stage, message: p.message, level: p.level }),
    });
    // Persist each one immediately — a failure at post 180 must not lose the first 179.
    db.applyPendingResult(res);
    done++;
    if (done % 5 === 0) db.emit(job.id, { stage: 'progress', message: `${done}/${rows.length}`, progress: done / rows.length });
  }
  db.emit(job.id, { stage: 'done', message: `${done} processed`, progress: 1 });
}

/** Transcribe downloaded outliers so selection can compare CONTENT, not just format. */
async function handleTranscribeOutliers(job, payload) {
  const { transcribeOutlier } = require('@clip-studio/engine/src/outliers/pipeline');
  const rows = db.getDb().prepare(
    `SELECT shortcode, media_dir FROM post
     WHERE media_state='downloaded' AND media_dir IS NOT NULL AND transcript IS NULL
     LIMIT ?`).all(payload.limit ?? 500);
  db.emit(job.id, { stage: 'start', message: `${rows.length} reels to transcribe`, progress: 0 });

  const upd = db.getDb().prepare('UPDATE post SET transcript=? WHERE shortcode=?');
  let done = 0;
  let failed = 0;
  for (const r of rows) {
    if (isCancelled(job.id)) throw new Error('cancelled');
    try {
      const t = await transcribeOutlier(r.media_dir);
      upd.run(t.text || null, r.shortcode);
      done++;
      db.emit(job.id, {
        stage: 'transcribe',
        message: `${r.shortcode}: ${t.words} words — "${t.text.slice(0, 50)}"`,
        progress: done / Math.max(1, rows.length),
      });
    } catch (err) {
      failed++;
      db.emit(job.id, { stage: 'error', message: `${r.shortcode}: ${String(err.message).slice(0, 100)}`, level: 'error' });
    }
  }
  db.emit(job.id, { stage: 'done', message: `${done} transcribed, ${failed} failed`, progress: 1 });
}

/**
 * Read titles the OCR pass missed.
 *
 * Runs only where the classifier reported a burned-in title but OCR returned nothing —
 * measured at 9 of 20 such reels. The gallery's value is showing which HEADLINES perform,
 * so a card with no title is a card with nothing to learn from.
 */
async function handleReadTitles(job, payload) {
  const { readTitle } = require('@clip-studio/engine/src/outliers/read-title');
  const rows = db.getDb().prepare(
    `SELECT shortcode, media_dir FROM post
     WHERE media_state='downloaded' AND media_dir IS NOT NULL
       AND ocr_title IS NULL AND has_burned_title = 1
     LIMIT ?`).all(payload.limit ?? 200);
  db.emit(job.id, { stage: 'start', message: `${rows.length} reels have a title OCR missed`, progress: 0 });

  const upd = db.getDb().prepare('UPDATE post SET ocr_title=? WHERE shortcode=?');
  let found = 0;
  let none = 0;
  for (const [i, r] of rows.entries()) {
    if (isCancelled(job.id)) throw new Error('cancelled');
    try {
      const t = await readTitle(r.media_dir);
      if (t.has_title) {
        upd.run(t.title, r.shortcode);
        found++;
        db.emit(job.id, { stage: 'title', message: `${r.shortcode}: "${t.title.slice(0, 60)}"`, progress: (i + 1) / rows.length });
      } else {
        none++;
      }
    } catch (err) {
      db.emit(job.id, { stage: 'error', message: `${r.shortcode}: ${String(err.message).slice(0, 100)}`, level: 'error' });
    }
  }
  db.emit(job.id, { stage: 'done', message: `${found} titles recovered, ${none} genuinely have none`, progress: 1 });
}

/**
 * Render ONE clip on demand, whatever the corpus said about it.
 *
 * The ranker calling a clip "cut" is advice, not a veto — an editor who wants that moment
 * must be able to have it. Without this the UI is a wall of "not rendered" cards with no
 * way to act on any of them.
 */
/**
 * Build the editor's preview proxy for one clip: a small, seek-friendly copy of the clip's
 * window plus waveform peaks (see engine/src/edit/proxy.js). Requested by the editor's GET
 * when no proxy covers the clip's current range.
 */
async function handleProxy(job, payload) {
  const { ensureProxy } = require('@clip-studio/engine/src/edit/proxy');
  const { normalizeDoc } = require('@clip-studio/engine/src/edit/doc');
  const clip = db.getClip(payload.clipId);
  if (!clip) throw new Error('clip not found');
  const source = db.getSource(clip.source_id);
  if (!source?.video_path || !fs.existsSync(source.video_path)) throw new Error('source video is not on disk');
  let range = { start: clip.start_s, end: clip.end_s };
  if (clip.edit_json) {
    try { range = normalizeDoc(JSON.parse(clip.edit_json), clip).range; } catch {}
  }
  // The editor may ask for a wider window than the document (trim handles dragged out).
  if (payload.start != null && payload.end != null) range = { start: +payload.start, end: +payload.end };
  db.emit(job.id, { stage: 'proxy', message: `building preview for ${Math.round(range.end - range.start)}s (+30s each side)`, progress: 0.1 });
  const m = await ensureProxy({
    sourcePath: source.video_path, workDir: source.work_dir, clipId: clip.id,
    start: range.start, end: range.end,
  });
  db.emit(job.id, { stage: 'done', message: `preview ready · ${m.duration.toFixed(0)}s at ${m.width}×${m.height}`, progress: 1 });
}

/**
 * Find the webcam and the chart in a source once, and keep the answer on the source row.
 * The editor's re-composed formats and the render both read it from there.
 */
async function handleLocatePanes(job, payload) {
  const { locatePanes } = require('@clip-studio/engine/src/compose/locate-panes');
  const source = db.getSource(payload.sourceId);
  if (!source?.video_path) throw new Error('source has no video on disk');
  // At the clip's own moment when we have one: a stream's layout moves during the session.
  const at = payload.atSeconds != null
    ? Math.max(0, payload.atSeconds)
    : Math.min(120, Math.max(20, (source.duration_s || 120) / 3));
  db.emit(job.id, { stage: 'compose', message: 'locating the webcam and the chart', progress: 0.2 });
  const composition = await locatePanes(source.video_path, { atSeconds: at });
  if (payload.clipId) db.setClipComposition(payload.clipId, composition);
  else db.updateSource(source.id, { composition_json: JSON.stringify(composition) });
  db.emit(job.id, { stage: 'done', message: `${composition.mode}${composition.camSide ? ` · webcam ${composition.camSide}` : ''}`, progress: 1 });
}

async function handleRenderClip(job, payload) {
  const fs = require('fs');
  const { renderRecomposedClip, renderPlannedClip } = require('@clip-studio/engine/src/pipeline2');
  const { locatePanes } = require('@clip-studio/engine/src/compose/locate-panes');
  const { verifyRenderedFile, trimTrailingSilence } = require('@clip-studio/engine/src/select/measure');

  const clip = db.getClip(payload.clipId);
  if (!clip) throw new Error('clip not found');
  const source = db.getSource(clip.source_id);
  if (!source?.video_path) throw new Error('source has no video on disk');

  // Through the loader, never straight off disk: it upgrades whisper's tiled word timings.
  const transcript = require('@clip-studio/engine/src/transcribe').loadTranscript(source.audio_path);
  const outputDir = source.work_dir;
  const clipId = `m${String(clip.id).slice(-6)}`;
  const paneOrder = payload.paneOrder || 'screen-top';
  const styleId = payload.styleId || 'sequel-viral';
  const titleText = payload.title !== undefined ? payload.title : clip.title_text;
  // Persist an edited title so the card shows it and the next render reuses it.
  if (payload.title !== undefined) {
    db.getDb().prepare('UPDATE clip SET title_text=? WHERE id=?').run(payload.title || null, clip.id);
  }

  /**
   * "band" formats keep the source 16:9 frame WHOLE on a black canvas with the title in the
   * space above — the rp.profits treatment. They deliberately do not re-compose, because
   * cropping a source that already carries its own webcam inset destroys the look.
   */
  const { renderBandClip, isBandVariant } = require('@clip-studio/engine/src/compose/band-clip');

  /*
   * An edited clip renders from its composition document and NOTHING else — range, cuts,
   * format, title styling, caption styling and per-word fixes all come from the document,
   * so what the editor previewed is what gets burned in.
   */
  if (clip.edit_json) {
    const { normalizeDoc, docToRenderParams } = require('@clip-studio/engine/src/edit/doc');
    const doc = normalizeDoc(JSON.parse(clip.edit_json), clip);
    const p = docToRenderParams(doc, transcript);
    // Re-composed formats need the webcam/chart regions FOR THIS CLIP; detect at its own
    // moment once and keep them on the clip (the editor's preview uses the same row).
    let composition = null;
    try { composition = clip.composition_json ? JSON.parse(clip.composition_json) : null; } catch {}
    if (!p.variant.startsWith('band-') && !composition) {
      const { locatePanes } = require('@clip-studio/engine/src/compose/locate-panes');
      db.emit(job.id, { stage: 'compose', message: 'locating the webcam and the chart' });
      composition = await locatePanes(source.video_path, { atSeconds: Math.max(0, clip.start_s + 5) });
      db.setClipComposition(clip.id, composition);
    }
    db.emit(job.id, { stage: 'render', message: `from the editor · ${p.variant} · ${p.spans.length} spans · ${doc.captions.mode} captions` });
    const finalPath = await renderBandClip({
      inputPath: source.video_path,
      outputDir, clipId, variant: p.variant,
      startSeconds: p.startSeconds, endSeconds: p.endSeconds, manualCuts: p.manualCuts,
      transcript, styleId, words: p.words, captionsEnabled: p.captionsEnabled,
      titleText: p.titleText, titleSeconds: p.titleSeconds,
      titleStyle: p.titleStyle, captionStyle: p.captionStyle, composition,
      onProgress: (e) => db.emit(job.id, e),
    });
    await trimTrailingSilence(finalPath);
    const v = await verifyRenderedFile(finalPath);
    let b = null; try { b = fs.statSync(finalPath).size; } catch {}
    db.addRender({ clipId: clip.id, path: finalPath, format: 'vertical', layout: p.variant,
                   captionStyle: `${styleId}:${doc.captions.mode}`, bytes: b, durationS: v.durationSeconds, verify: v });
    db.emit(job.id, { stage: 'done', message: v.passed ? 'rendered and clean' : `rendered — ${v.detail}`, progress: 1 });
    return;
  }

  if (isBandVariant(paneOrder)) {
    const finalPath = await renderBandClip({
      inputPath: source.video_path,
      outputDir, clipId, variant: paneOrder,
      startSeconds: clip.start_s, endSeconds: clip.end_s,
      manualCuts: JSON.parse(clip.cuts_json || '[]'),
      transcript, styleId, titleText,
      // Whole clip unless the editor asked for a finite hold.
      titleSeconds: payload.titleSeconds ?? null,
      onProgress: (e) => db.emit(job.id, e),
    });

    await trimTrailingSilence(finalPath);
    const v = await verifyRenderedFile(finalPath);
    let b = null; try { b = fs.statSync(finalPath).size; } catch {}
    db.addRender({ clipId: clip.id, path: finalPath, format: 'vertical', layout: paneOrder,
                   captionStyle: styleId, bytes: b, durationS: v.durationSeconds, verify: v });
    db.emit(job.id, { stage: 'done', message: v.passed ? 'rendered and clean' : `rendered — ${v.detail}`, progress: 1 });
    return;
  }

  db.emit(job.id, { stage: 'compose', message: 'locating panes', progress: 0.1 });
  let composition = null;
  let layoutDoc = null;
  try {
    composition = await locatePanes(source.video_path, { atSeconds: Math.max(20, clip.start_s) });
    if (composition.mode === 'pip' && composition.cam) {
      const cam = composition.cam;
      const onRight = cam.x + cam.w / 2 > 0.5;
      composition = {
        ...composition, mode: 'split',
        screen: onRight
          ? { x: 0, y: 0, w: Math.max(0.5, cam.x), h: 1 }
          : { x: Math.min(0.5, cam.x + cam.w), y: 0, w: Math.max(0.5, 1 - (cam.x + cam.w)), h: 1 },
      };
    }
    if (composition.mode === 'split') {
      layoutDoc = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, '../../../packages/engine/config/layouts/layout-5-vertical-recompose.json'), 'utf-8'));
    }
  } catch (err) {
    db.emit(job.id, { stage: 'compose', message: `falling back to letterbox (${String(err.message).slice(0, 60)})`, level: 'error' });
  }

  const planned = {
    start_seconds: clip.start_s, end_seconds: clip.end_s,
    manual_cuts: JSON.parse(clip.cuts_json || '[]'),
    hook: clip.hook, titleText,
  };

  db.emit(job.id, { stage: 'render', message: 'rendering', progress: 0.3 });
  const out = layoutDoc
    ? await renderRecomposedClip(planned, {
        inputPath: source.video_path, outputDir, clipId, transcript,
        captionsEnabled: true, styleId, titleText,
        composition, layoutDoc, paneOrder,
        onProgress: (p) => db.emit(job.id, { stage: p.stage, message: p.message }),
      })
    : await renderPlannedClip(planned, {
        inputPath: source.video_path, outputDir, clipId, format: 'vertical', layout: 'single',
        transcript, captionsEnabled: true, styleId, titleText,
        onProgress: (p) => db.emit(job.id, { stage: p.stage, message: p.message }),
      });

  db.emit(job.id, { stage: 'verify', message: 'checking for dead air', progress: 0.9 });
  await trimTrailingSilence(out);
  const verify = await verifyRenderedFile(out);

  let bytes = null;
  try { bytes = fs.statSync(out).size; } catch {}
  db.addRender({
    clipId: clip.id, path: out, format: 'vertical',
    layout: layoutDoc ? paneOrder : 'letterbox',
    captionStyle: styleId, bytes,
    durationS: verify.durationSeconds, verify,
  });
  db.emit(job.id, { stage: 'done', message: verify.passed ? 'rendered and clean' : `rendered — ${verify.detail}`, progress: 1 });
}

async function runJob(job) {
  const payload = JSON.parse(job.payload_json);
  db.emit(job.id, { stage: 'start', message: `${job.type} started`, progress: 0 });

  const heartbeat = setInterval(() => db.renewLease(job.id, OWNER, LEASE_S), (LEASE_S / 3) * 1000);
  try {
    if (job.type === 'process') await handleProcess(job, payload);
    else if (job.type === 'outliers') await handleOutliers(job, payload);
    else if (job.type === 'reclassify') await handleReclassify(job, payload);
    else if (job.type === 'classify-pending') await handleClassifyPending(job, payload);
    else if (job.type === 'transcribe-outliers') await handleTranscribeOutliers(job, payload);
    else if (job.type === 'read-titles') await handleReadTitles(job, payload);
    else if (job.type === 'render-clip') await handleRenderClip(job, payload);
    else if (job.type === 'proxy') await handleProxy(job, payload);
    else if (job.type === 'locate-panes') await handleLocatePanes(job, payload);
    else throw new Error(`Unknown job type: ${job.type}`);
    db.finishJob(job.id, 'succeeded');
  } catch (err) {
    const cancelled = /cancelled/i.test(err.message) || isCancelled(job.id);
    db.emit(job.id, {
      stage: cancelled ? 'cancelled' : 'error',
      message: cancelled ? 'Cancelled' : err.message.slice(0, 500),
      level: 'error',
    });
    db.finishJob(job.id, cancelled ? 'cancelled' : 'failed', err.message.slice(0, 2000));
    const src = job.source_id ? db.getSource(job.source_id) : null;
    if (src && src.status !== 'deleting') db.updateSource(job.source_id, { status: cancelled ? 'pending' : 'failed' });
  } finally {
    clearInterval(heartbeat);
    // The dashboard deleted this source while its job was running: the route could only
    // cancel and mark it, because the files are ours. Finish the deletion now.
    const src = job.source_id ? db.getSource(job.source_id) : null;
    if (src && src.status === 'deleting') {
      try {
        const r = db.deleteSource(src.id);
        console.log(`[worker] deleted source ${src.id} after its job ended (${r ? Math.round(r.bytes / 1e6) : 0} MB)`);
      } catch (e) { console.warn(`[worker] could not finish deleting ${src.id}: ${e.message}`); }
    }
  }
}

/**
 * Keep the corpus current without a system-level scheduler.
 *
 * The worker is already long-lived, so it schedules itself: if the last successful corpus
 * refresh is older than REFRESH_DAYS, queue another. No launchd plist, no crontab, nothing
 * to leave behind on the machine — and if the worker isn't running, nothing happens, which
 * is correct because a scrape needs the worker anyway.
 *
 * Re-scraping the last 60 days (rather than only since the last run) matters: it refreshes
 * VIEW COUNTS on recent posts, which is what makes the metric time-series — and therefore
 * "what's gaining right now" — possible at all.
 */
function maybeScheduleRefresh() {
  const last = db.getDb().prepare(
    `SELECT finished_at FROM job WHERE type='outliers' AND status='succeeded'
     ORDER BY finished_at DESC LIMIT 1`).get();
  const queued = db.getDb().prepare(
    `SELECT COUNT(*) c FROM job WHERE type='outliers' AND status IN ('queued','running')`).get().c;
  if (queued > 0) return;

  const ageDays = last?.finished_at
    ? (Date.now() - new Date(last.finished_at).getTime()) / 86400000
    : Infinity;
  if (ageDays < REFRESH_DAYS) return;

  const id = db.enqueue({
    type: 'outliers',
    payload: { days: 60, maxDownloads: 30, classify: true, scheduled: true },
  });
  console.log(`[worker] corpus is ${ageDays === Infinity ? 'unbuilt' : Math.round(ageDays) + 'd old'} — queued weekly refresh ${id}`);
}

async function lane(name, types) {
  let lastRefreshCheck = 0;
  while (!shuttingDown) {
    // The corpus refresh check rides on the slow lane, hourly — it is cheap but needn't run 3600x/hr.
    if (name === 'slow' && Date.now() - lastRefreshCheck > 3600_000) {
      lastRefreshCheck = Date.now();
      try { maybeScheduleRefresh(); } catch (err) { console.warn('[worker] refresh check failed:', err.message); }
    }
    const job = db.claimJob(OWNER, LEASE_S, types);
    if (!job) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    activeJobs.set(name, job.id);
    console.log(`[worker:${name}] claimed ${job.id} (${job.type})`);
    await runJob(job);
    console.log(`[worker:${name}] finished ${job.id}`);
    activeJobs.delete(name);
  }
}

async function loop() {
  acquireLock();
  // Bookkeeping can lie; the disk cannot. Re-derive media_state from the files on start.
  try {
    const r = db.repairMediaState();
    if (r.checked) console.log(`[worker] media state repaired from disk: ${r.downloaded} downloaded, ${r.gone} missing (of ${r.checked})`);
  } catch (e) { console.warn(`[worker] media state repair skipped: ${e.message}`); }
  console.log(`[worker] ${OWNER} started — fast lane: ${LANES.fast.join(', ')} · slow lane: ${LANES.slow.join(', ')}`);
  const reaped = db.reapStaleJobs();
  if (reaped) console.log(`[worker] requeued ${reaped} stale job(s) from a previous run`);

  // Tools first: a fresh machine has no yt-dlp, no whisper, no model. The worker fetches
  // them itself and reports progress through worker.status.json so the dashboard can say
  // "installing yt-dlp… 40%" instead of failing the first job with ENOENT.
  const statusPath = path.join(DATA_DIR, 'worker.status.json');
  const patchStatus = (patch) => {
    try {
      const cur = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      fs.writeFileSync(statusPath, JSON.stringify({ ...cur, ...patch }));
    } catch { /* status is best effort */ }
  };
  try {
    const { ensureTools } = require('@clip-studio/engine/src/tools');
    let lastLine = '';
    const r = await ensureTools({
      log: (m) => console.log(`[setup] ${m}`),
      onProgress: (p) => {
        patchStatus({ setup: p });
        const line = `[setup] ${p.tool}: ${p.message}${p.percent != null ? ` ${p.percent}%` : ''}`;
        if (line !== lastLine && (p.percent == null || p.percent % 10 === 0 || p.percent === 100)) { console.log(line); lastLine = line; }
      },
    });
    for (const w of r.warnings) console.warn(`[setup] WARNING: ${w}`);
    patchStatus({ setup: null, capabilities: require('@clip-studio/engine/src/capabilities').checkTools() });
  } catch (err) {
    patchStatus({ setup: { tool: 'setup', message: err.message, percent: null, failed: true } });
    console.error(`[worker] FATAL: ${err.message}`);
    process.exit(1);
  }
  try {
    assertCapabilities({ verbose: true });
  } catch (err) {
    console.error(`[worker] FATAL: ${err.message}`);
    process.exit(1);
  }

  await Promise.all([lane('fast', LANES.fast), lane('slow', LANES.slow)]);
  console.log('[worker] stopped');
  // Leave explicitly: an LLM client's keep-alive sockets can hold the event loop open for
  // minutes after the loop ends, and the lock is only released on 'exit'.
  process.exit(0);
}

/**
 * Shutdown is a drain: the first signal stops claiming and lets running jobs FINISH (a
 * restart must not throw away ten minutes of transcription); a second signal cancels the
 * running jobs at their next stage boundary; a third leaves immediately.
 */
let signals = 0;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    signals++;
    if (signals >= 3) process.exit(1);
    if (signals === 2) {
      console.log(`\n[worker] ${sig} again — cancelling ${activeJobs.size} running job(s)`);
      for (const id of activeJobs.values()) db.requestCancel(id);
      return;
    }
    shuttingDown = true;
    const n = activeJobs.size;
    console.log(`\n[worker] ${sig} — no new jobs; ${n ? `finishing ${n} running job(s) first` : 'nothing running'} (send again to cancel)`);
  });
}

loop().catch((err) => { console.error('[worker] fatal', err); process.exit(1); });
