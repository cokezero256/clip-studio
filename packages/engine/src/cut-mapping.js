/**
 * Cut-mapping utilities for the "Quick Trim" export flow.
 *
 * The pipeline produces cut.mp4 (the source with silences + fillers removed) and
 * cut-decisions.json (the keeper ranges in source-time). To caption cut.mp4 OR to
 * apply the same trim to a parallel Screen.mp4 (split-screen sources), we need:
 *
 *   - remapTranscriptToCut(transcript, keepers) — shift each word's timestamps from
 *     SOURCE time to CUT time. Words inside dropped ranges or straddling boundaries
 *     are excluded.
 *   - trimToKeepers({ inputPath, keepers, outPath, ffmpeg }) — concat-demuxer cut+
 *     stitch over a parallel source (Screen.mp4) using the same keeper ranges.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * @param {object} transcript    Whisper verbose_json — must have `words: [{word, start, end}]`
 * @param {Array<{start_seconds: number, end_seconds: number}>} keepers
 * @returns {object} A new transcript with the same shape but `words` remapped to cut-time.
 *                   `segments` are also remapped if present (best-effort — segments that
 *                   span dropped ranges are split or excluded).
 */
function remapTranscriptToCut(transcript, keepers) {
  if (!transcript || !Array.isArray(transcript.words)) {
    throw new Error('remapTranscriptToCut: transcript.words required');
  }
  if (!Array.isArray(keepers) || keepers.length === 0) {
    throw new Error('remapTranscriptToCut: keepers required');
  }

  // Pre-compute the cut-time offset at the start of each keeper.
  // cutOffsets[i] = sum of (keepers[0..i-1].duration). So a word in keeper i with
  // source-time `srcT` lands at cut-time `cutOffsets[i] + (srcT - keepers[i].start_seconds)`.
  const cutOffsets = [];
  let acc = 0;
  for (const k of keepers) {
    cutOffsets.push(acc);
    acc += k.end_seconds - k.start_seconds;
  }
  const cutDuration = acc;

  const remappedWords = [];
  for (const w of transcript.words) {
    if (typeof w.start !== 'number' || typeof w.end !== 'number') continue;
    const k = findContainingKeeper(keepers, w.start, w.end);
    if (k < 0) continue; // word in dropped range or straddling boundary
    const offset = cutOffsets[k];
    const start = offset + (w.start - keepers[k].start_seconds);
    const end = offset + (w.end - keepers[k].start_seconds);
    remappedWords.push({ ...w, start, end });
  }

  // Best-effort segment remapping (some downstream callers iterate segments).
  const remappedSegments = [];
  if (Array.isArray(transcript.segments)) {
    for (const s of transcript.segments) {
      if (typeof s.start !== 'number' || typeof s.end !== 'number') continue;
      const k = findContainingKeeper(keepers, s.start, s.end);
      if (k < 0) continue;
      const offset = cutOffsets[k];
      remappedSegments.push({
        ...s,
        start: offset + (s.start - keepers[k].start_seconds),
        end: offset + (s.end - keepers[k].start_seconds),
      });
    }
  }

  return {
    ...transcript,
    duration: cutDuration,
    words: remappedWords,
    segments: remappedSegments,
  };
}

/**
 * Returns the index of the first keeper that fully contains [t0, t1], or -1.
 * Allows a small tolerance at the edges (50 ms) so words that snapped to a silence
 * boundary aren't lost to a sub-frame discrepancy.
 */
function findContainingKeeper(keepers, t0, t1) {
  const EPS = 0.05;
  for (let i = 0; i < keepers.length; i++) {
    const k = keepers[i];
    if (t0 >= k.start_seconds - EPS && t1 <= k.end_seconds + EPS) return i;
  }
  return -1;
}

/**
 * Concat-demuxer trim a parallel source (e.g. Screen.mp4) using the same keeper ranges
 * the pipeline used for cut.mp4. Output is stream-copied where possible; falls back to
 * the ffmpeg helper's cutSegment which knows how to handle non-intra-frame codecs.
 *
 * Idempotent: if `outPath` exists and is NEWER than `keepersStatePath` (the cut-decisions
 * file), the function reports `cached: true` and skips work. Pass `force: true` to override.
 *
 * @param {object} opts
 * @param {string} opts.inputPath      Source video to trim (Screen.mp4)
 * @param {Array<{start_seconds:number, end_seconds:number}>} opts.keepers
 * @param {string} opts.outPath        Where to write the trimmed file
 * @param {string} [opts.keepersStatePath]  Path to cut-decisions.json — for cache freshness check
 * @param {object} opts.ffmpeg         Reference to lib/ffmpeg (cutSegment + concat)
 * @param {boolean} [opts.force]
 * @returns {Promise<{path: string, cached: boolean}>}
 */
async function trimToKeepers(opts) {
  const { inputPath, keepers, outPath, keepersStatePath, ffmpeg, force = false } = opts;
  if (!fs.existsSync(inputPath)) {
    throw new Error(`trimToKeepers: input not found: ${inputPath}`);
  }
  if (!Array.isArray(keepers) || keepers.length === 0) {
    throw new Error('trimToKeepers: keepers required');
  }

  if (!force && fs.existsSync(outPath)) {
    if (keepersStatePath && fs.existsSync(keepersStatePath)) {
      const outMtime = fs.statSync(outPath).mtimeMs;
      const stateMtime = fs.statSync(keepersStatePath).mtimeMs;
      if (outMtime >= stateMtime) return { path: outPath, cached: true };
    } else {
      return { path: outPath, cached: true };
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Work in a temp segment dir alongside the output so we don't pollute /tmp.
  const segDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-'));
  const segExt = path.extname(inputPath) || '.mp4';
  const segPaths = [];
  try {
    for (let i = 0; i < keepers.length; i++) {
      const seg = keepers[i];
      const segPath = path.join(segDir, `seg_${String(i + 1).padStart(4, '0')}${segExt}`);
      await ffmpeg.cutSegment(inputPath, seg.start_seconds, seg.end_seconds, segPath);
      segPaths.push(segPath);
    }
    // Concat stream-copy → outPath.
    await ffmpeg.concat(segPaths, outPath);
  } finally {
    // Clean up segment files but keep the output.
    for (const p of segPaths) { try { fs.unlinkSync(p); } catch {} }
    try { fs.rmdirSync(segDir); } catch {}
  }
  return { path: outPath, cached: false };
}

module.exports = { remapTranscriptToCut, trimToKeepers };
