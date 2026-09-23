/**
 * Shared end-to-end pipeline. Called by both auto-edit.js (manual CLI) and scan.js (Dropbox watcher).
 *
 * Stages:
 *   1. probe source
 *   2. extract MP3 from raw input → transcribe with Whisper (no normalize needed for audio)
 *   3. decide cuts with Claude (tool-use, two-pass, confidence gating)
 *   4. normalize source → source.mp4 (CFR, keyframes/sec, 48k stereo) — runs in parallel with cuts
 *   5. invert drop-spans → keep-segments
 *   6. snap keep-segment boundaries to nearest silence (kills clicks)
 *   7. cut + concat → preview.mp4 (straight cuts, stream-copy)
 *   8. emit FCPXML pointing at source.mp4 with rational frame timing
 *   9. write audit.md
 */

const fs = require('fs');
const path = require('path');

const ffmpeg = require('./ffmpeg');
const { transcribe } = require('./whisper');
const { decideCuts } = require('./cut-decider');
const { detectStutters, mergeWithLlmCuts } = require('./stutter-detector');
const { detectSilenceRegions } = require('./silence-detector');
const { detectAltTakes } = require('./alt-take-detector');
const { writeFcpxml } = require('./fcpxml');
const { buildAudit } = require('./audit');
const { loadClient } = require('./config');

async function runPipeline({
  inputPath,
  outputDir,
  workDir,
  client = '_default',
  projectName,
  log = console,
}) {
  const clientConfig = loadClient(client);
  const baseName = projectName || path.basename(inputPath, path.extname(inputPath));

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // Progress writer — drops a small JSON file on every stage transition so the dashboard
  // (or any external watcher) can render a live progress bar without subscribing to a stream.
  const progressPath = path.join(outputDir, 'progress.json');
  const startedAt = Date.now();
  const stages = [
    { id: 'probe',       label: 'Probing source' },
    { id: 'transcribe',  label: 'Transcribing (Whisper)' },
    { id: 'cut_decide',  label: 'Deciding cuts (Claude)' },
    { id: 'normalize',   label: 'Normalizing (CFR + keyframes)' },
    { id: 'silence',     label: 'Detecting silence boundaries' },
    { id: 'render',      label: 'Cutting & concatenating segments' },
    { id: 'preview',     label: 'Encoding 1080p preview' },
    { id: 'finalize',    label: 'Writing FCPXML + audit' },
  ];
  function writeProgress(currentId, extra = {}) {
    const idx = stages.findIndex((s) => s.id === currentId);
    const data = {
      pid: process.pid,
      started_at: startedAt,
      updated_at: Date.now(),
      elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
      stage_index: idx,
      stage_total: stages.length,
      stage_id: currentId,
      stage_label: stages[idx]?.label || currentId,
      status: 'running',
      ...extra,
    };
    try { fs.writeFileSync(progressPath, JSON.stringify(data, null, 2)); } catch {}
  }
  function writeFinal(status, extra = {}) {
    const data = {
      pid: process.pid,
      started_at: startedAt,
      updated_at: Date.now(),
      elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
      stage_index: stages.length,
      stage_total: stages.length,
      stage_id: 'done',
      stage_label: status === 'done' ? 'Complete' : 'Failed',
      status,
      ...extra,
    };
    try { fs.writeFileSync(progressPath, JSON.stringify(data, null, 2)); } catch {}
  }

  // Clear any cancel flag left over from a prior run before we start spawning ffmpeg.
  ffmpeg.resetCancel?.();

  try {
  // ── Stage 1: probe ──
  writeProgress('probe');
  log.info?.(`[1/7] probing source…`);

  // Quick readability check — try to read 1MB within 5s. If this times out the file is
  // inaccessible (iCloud eviction, stuck I/O, disconnected drive) and ffmpeg will hang
  // indefinitely in an unkillable UE state. Fail fast instead.
  await new Promise((resolve, reject) => {
    const { createReadStream } = require('fs');
    const stream = createReadStream(inputPath, { start: 0, end: 1024 * 1024 });
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error(
        `Cannot read input file within 5s — file may be in iCloud (not downloaded), on a disconnected drive, or locked by another process. ` +
        `If you see a cloud icon in Finder, click it to download first.`
      ));
    }, 5000);
    stream.on('data', () => { clearTimeout(timer); stream.destroy(); resolve(); });
    stream.on('error', (e) => { clearTimeout(timer); reject(new Error(`Input file unreadable: ${e.message}`)); });
  });

  const initialProbe = await ffmpeg.probe(inputPath);
  log.info?.(
    `      ${initialProbe.codec.toUpperCase()} ${initialProbe.width}x${initialProbe.height} @ ${(initialProbe.fps_num / initialProbe.fps_den).toFixed(3)}fps · ` +
    `${formatDur(initialProbe.duration_seconds)} · audio ${initialProbe.audio_sample_rate}Hz/${initialProbe.audio_channels}ch` +
    (initialProbe.is_intra_frame ? ' · intra-frame (fast path)' : '') +
    (initialProbe.is_vfr ? ' · VFR (will force CFR)' : ''),
  );

  const sourceExt = initialProbe.container_ext;
  const sourcePath = path.join(outputDir, `source${sourceExt}`);

  // ── Stage 2: transcribe from raw input (no normalize needed for audio) ──
  // We extract a tiny mono MP3 directly from the original file — takes ~5s vs minutes
  // for a full normalize. Cuts are decided from this transcript, then normalize runs.
  const transcriptCachePath = path.join(outputDir, 'transcript.json');
  let transcript;
  if (fs.existsSync(transcriptCachePath)) {
    log.info?.(`[2/7] using cached transcript — skipping Whisper`);
    transcript = JSON.parse(fs.readFileSync(transcriptCachePath, 'utf-8'));
  } else {
    writeProgress('transcribe', { detail: 'extracting audio from raw source → Whisper API' });
    log.info?.(`[2/7] transcribing with Whisper API (language=${clientConfig.language})…`);
    transcript = await transcribe(inputPath, {
      language: clientConfig.language,
      workDir,
    });
    fs.writeFileSync(transcriptCachePath, JSON.stringify(transcript), 'utf-8');
  }
  log.info?.(`      ${transcript.segments?.length || 0} segments, ${transcript.words?.length || 0} words`);

  // ── Stage 3: decide cuts + normalize in parallel ──
  // Claude only needs the transcript; normalize only needs the raw file.
  // Running them concurrently saves the full normalize wait before cuts are known.
  writeProgress('cut_decide', { detail: `Claude analyzing ${transcript.segments?.length || 0} segments` });
  log.info?.(`[3/7] deciding cuts (Claude) + normalizing source in parallel…`);
  // Pick up per-video editor notes (output/<name>/ai-notes.txt) if present — these get
  // folded into the cut-decider system prompt so "cut this exact line / topic / window"
  // instructions actually shape the trim.
  const aiNotesPath = path.join(outputDir, 'ai-notes.txt');
  const aiNotes = fs.existsSync(aiNotesPath) ? fs.readFileSync(aiNotesPath, 'utf-8') : '';
  if (aiNotes.trim()) {
    log.info?.(`      editor notes loaded (${aiNotes.length} chars)`);
  }

  // Run Claude cut-decisions and normalize concurrently — neither depends on the other.
  const normalizeTask = (async () => {
    if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).size > 0) {
      log.info?.(`      using cached normalized source — skipping normalize`);
      return ffmpeg.probe(sourcePath);
    }
    writeProgress('normalize', {
      detail: initialProbe.is_intra_frame ? 'fast path (remux only)' : `re-encoding ${initialProbe.width}x${initialProbe.height} — running in background`,
      source_duration: initialProbe.duration_seconds,
    });
    if (initialProbe.is_intra_frame && !initialProbe.is_vfr) {
      log.info?.(`      normalize: fast path (remux only)…`);
    } else {
      log.info?.(`      normalize: re-encoding in background…`);
    }
    const t1 = Date.now();
    const normResult = await ffmpeg.normalize(inputPath, sourcePath, initialProbe, {
      onProgress: (pct, sec) => {
        writeProgress('normalize', {
          percent: pct,
          detail: `encoding ${Math.round(sec)}s / ${Math.round(initialProbe.duration_seconds)}s (hardware accelerated)`,
          source_duration: initialProbe.duration_seconds,
        });
      },
    });
    log.info?.(`      normalize done: ${normResult.didReencode ? 're-encoded' : 'remuxed'} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    return ffmpeg.probe(sourcePath);
  })();

  const decision = await decideCuts(transcript, clientConfig, {
    twoPass: clientConfig.two_pass !== false,
    aiNotes,
  });

  // Programmatic alt-take detection — catches consecutive segments that share opening
  // words (multi-take repetitions). Deterministic; the LLM is unreliable on this rule.
  const altTakeCuts = detectAltTakes(transcript);
  if (altTakeCuts.length > 0) {
    log.info?.(`      alt-take-detector found ${altTakeCuts.length} multi-take groups (always keeping last)`);
  }

  // Programmatic stutter detection — catches what Whisper smoothed away.
  const stutterCuts = detectStutters(transcript);
  if (stutterCuts.length > 0) {
    log.info?.(`      stutter-detector found ${stutterCuts.length} additional patterns (word-repeat + gap-in-segment)`);
  }

  // Wait for normalize to finish before we need probe data for silence detection.
  const probe = await normalizeTask;

  // Programmatic silence detection — catches leading/trailing/inter-thought silence
  // the LLM never anchors on (no words = no input to reason about).
  const silenceCuts = detectSilenceRegions(transcript, probe.duration_seconds, {
    edgeMinDuration: clientConfig.edge_silence_threshold_seconds ?? clientConfig.silence_threshold_seconds ?? 0.4,
    midMinDuration: clientConfig.mid_silence_threshold_seconds ?? 0.5,
  });
  if (silenceCuts.length > 0) {
    log.info?.(`      silence-detector found ${silenceCuts.length} silent regions`);
  }

  const allCuts = mergeWithLlmCuts(decision.cuts, [...altTakeCuts, ...stutterCuts, ...silenceCuts]);

  const autoApply = clientConfig.auto_apply_confidence ?? 0.85;

  const drops = allCuts.filter((c) => c.action === 'drop' && c.confidence >= autoApply);
  const suggested = allCuts.filter((c) => c.action === 'drop' && c.confidence < autoApply);
  const highlights = allCuts.filter((c) => c.action === 'keep_highlight');

  log.info?.(
    `      ${drops.length} cuts to apply · ${suggested.length} suggested · ${highlights.length} highlights`,
  );

  // ── Stage 4: invert drops → keep-segments ──
  let keepSegments = invertDrops(drops, probe.duration_seconds);
  // discard keeps shorter than the configured minimum
  const minKeep = clientConfig.min_keep_segment_seconds ?? 1.5;
  keepSegments = keepSegments.filter((s) => s.end_seconds - s.start_seconds >= minKeep);

  if (keepSegments.length === 0) {
    throw new Error(
      'After applying cuts, no keep-segments remain. Likely too aggressive — check the audit and lower auto_apply_confidence.',
    );
  }

  // ── Stage 5: snap boundaries to silence ──
  writeProgress('silence', { detail: `scanning for silence regions to snap cut boundaries` });
  log.info?.(`[4/7] running silencedetect for boundary snapping…`);
  const silenceRegions = await ffmpeg.detectSilence(sourcePath, {
    threshold_db: -35,
    min_duration_s: 0.05,
  });
  log.info?.(`      ${silenceRegions.length} silence regions found`);

  keepSegments = keepSegments.map((seg, i) => {
    const out = { ...seg };
    // Don't snap the very first start (0) or the very last end (duration), so we keep head/tail intact.
    if (i > 0) out.start_seconds = ffmpeg.snapToSilence(seg.start_seconds, silenceRegions, 150);
    if (i < keepSegments.length - 1) {
      out.end_seconds = ffmpeg.snapToSilence(seg.end_seconds, silenceRegions, 150);
    }
    // Also pad each boundary by a touch (~80ms) inward to avoid glottal artifacts.
    // Note: since snapping already targets silence, this padding is mostly a safety net.
    return out;
  });

  // Persist the final keep-segments so downstream features (Export trim, future
  // trim editor) can re-render or reconstitute the same cut without rerunning the
  // pipeline. Written here, AFTER silence-snap, BEFORE concat — these are the
  // exact ranges cut.mp4 is about to be built from.
  const cutDuration = keepSegments.reduce((sum, s) => sum + (s.end_seconds - s.start_seconds), 0);
  fs.writeFileSync(
    path.join(outputDir, 'cut-decisions.json'),
    JSON.stringify({
      source_duration_seconds: probe.duration_seconds,
      cut_duration_seconds: cutDuration,
      keepers: keepSegments.map((s) => ({
        start_seconds: s.start_seconds,
        end_seconds: s.end_seconds,
      })),
    }, null, 2),
  );

  // ── Stage 6: cut + concat → preview.mp4 ──
  writeProgress('render', {
    detail: `${keepSegments.length} segments to cut + concat`,
    segments_total: keepSegments.length,
  });
  log.info?.(`[5/7] cutting & concatenating ${keepSegments.length} segments…`);
  const segDir = path.join(workDir, 'segments');
  fs.mkdirSync(segDir, { recursive: true });
  // clear any prior segments from a retry
  for (const f of fs.readdirSync(segDir)) {
    fs.unlinkSync(path.join(segDir, f));
  }

  const segPaths = [];
  for (let i = 0; i < keepSegments.length; i++) {
    const seg = keepSegments[i];
    const segPath = path.join(segDir, `seg_${String(i + 1).padStart(4, '0')}${sourceExt}`);
    await ffmpeg.cutSegment(sourcePath, seg.start_seconds, seg.end_seconds, segPath);
    segPaths.push(segPath);
    // Update progress every few segments so the UI shows live progress through this stage.
    if (i % 3 === 0 || i === keepSegments.length - 1) {
      writeProgress('render', {
        detail: `cut ${i + 1}/${keepSegments.length} segments`,
        segments_done: i + 1,
        segments_total: keepSegments.length,
      });
    }
  }

  // Concat in the source container (lossless stream-copy).
  const cutPath = path.join(outputDir, `cut${sourceExt}`);
  await ffmpeg.concat(segPaths, cutPath);

  // Always emit a small, shareable H.264 preview.mp4 — the cut.mov can be 8GB+.
  const previewPath = path.join(outputDir, 'preview.mp4');
  writeProgress('preview', { detail: 'encoding 1080p H.264 preview (HW accelerated)' });
  log.info?.(`      encoding shareable preview.mp4 (1080p H.264)…`);
  const tPrev = Date.now();
  await ffmpeg.encodeShareablePreview(cutPath, previewPath, { maxHeight: 1080 });
  log.info?.(`      preview.mp4 ready in ${((Date.now() - tPrev) / 1000).toFixed(1)}s`);

  const finalProbe = await ffmpeg.probe(cutPath);
  log.info?.(`      cut${sourceExt} = ${formatDur(finalProbe.duration_seconds)}`);

  // ── Stage 7: FCPXML ──
  writeProgress('finalize', { detail: 'writing FCPXML + audit' });
  log.info?.(`[6/7] writing FCPXML + audit…`);
  const fcpxmlPath = path.join(outputDir, 'timeline.fcpxml');
  writeFcpxml(fcpxmlPath, {
    projectName: baseName,
    sourceFileName: `source${sourceExt}`,
    probe,
    keepSegments,
  });

  // ── Stage 8: audit.md ──
  const auditMd = buildAudit({
    sourceName: baseName,
    client,
    probe,
    cuts: allCuts,
    appliedCuts: drops,
    suggestedCuts: suggested,
    highlights,
    finalDuration: finalProbe.duration_seconds,
    clientConfig,
  });
  const auditPath = path.join(outputDir, 'audit.md');
  fs.writeFileSync(auditPath, auditMd, 'utf-8');

  // Cleanup intermediate segments
  for (const f of fs.readdirSync(segDir)) fs.unlinkSync(path.join(segDir, f));
  try { fs.rmdirSync(segDir); } catch {}

  const result = {
    sourcePath,
    cutPath,
    previewPath,
    fcpxmlPath,
    auditPath,
    sourceDuration: probe.duration_seconds,
    finalDuration: finalProbe.duration_seconds,
    cutsApplied: drops.length,
    suggestedCuts: suggested.length,
    highlights: highlights.length,
    usage: decision.usage,
  };

  writeFinal('done', {
    cuts_applied: drops.length,
    suggested_cuts: suggested.length,
    highlights: highlights.length,
    source_duration: probe.duration_seconds,
    final_duration: finalProbe.duration_seconds,
  });

  return result;
  } catch (err) {
    // If the user cancelled, report it as a clean cancel rather than a scary failure.
    if (err?.cancelled || ffmpeg.isCancelled?.()) {
      writeFinal('cancelled', { error: 'Cancelled by user.' });
    } else {
      writeFinal('failed', { error: err?.message || String(err) });
    }
    throw err;
  }
}

function invertDrops(drops, totalDuration) {
  if (drops.length === 0) {
    return [{ start_seconds: 0, end_seconds: totalDuration }];
  }

  // Merge overlapping/adjacent drops
  const sorted = [...drops].sort((a, b) => a.start_seconds - b.start_seconds);
  const merged = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.start_seconds <= cur.end_seconds + 0.01) {
      cur.end_seconds = Math.max(cur.end_seconds, next.end_seconds);
    } else {
      merged.push(cur);
      cur = { ...next };
    }
  }
  merged.push(cur);

  // Invert: build keep-segments between drops
  const keeps = [];
  let prevEnd = 0;
  for (const drop of merged) {
    if (drop.start_seconds > prevEnd) {
      keeps.push({ start_seconds: prevEnd, end_seconds: drop.start_seconds });
    }
    prevEnd = Math.max(prevEnd, drop.end_seconds);
  }
  if (prevEnd < totalDuration) {
    keeps.push({ start_seconds: prevEnd, end_seconds: totalDuration });
  }
  return keeps;
}

function formatDur(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

module.exports = { runPipeline, invertDrops };
