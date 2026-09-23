/**
 * Silence measured from the AUDIO, not inferred from word timings.
 *
 * WHY THIS EXISTS — a real failure found by gating a rendered file:
 * whisper.cpp with `--max-len 1 --split-on-word` does NOT measure per-word boundaries. It
 * distributes each segment's duration across its words, so consecutive words tile with
 * exactly 0ms between them even across long silences. Observed on a real trading video:
 *
 *   transcript  24.61 → 29.46  sixteen words, EVERY gap 0ms
 *   real audio  26.12 → 27.74  1.62 SECONDS of silence inside that span
 *
 * A transcript-derived gate reported a 160ms worst gap on that clip; `silencedetect` on
 * the rendered MP4 found nine silences ≥350ms, the largest 1.62s. Word gaps are therefore
 * useful for STRUCTURE (sentences, candidate boundaries) and useless for SILENCE.
 *
 * Everything that decides what to cut, or whether a clip is clean, measures the waveform.
 */

const { detectSilenceByAmplitude, SILENCE_PRESETS_AMPLITUDE } = require('../silence-detector');

/** Measured silence regions overlapping [start,end], in source time. */
async function measureSilence(audioPath, startSeconds, endSeconds, options = {}) {
  const preset = SILENCE_PRESETS_AMPLITUDE[options.mode] || SILENCE_PRESETS_AMPLITUDE.faster;
  const noiseDb = options.noiseDb ?? preset.noiseDb;
  // Detect well below the cut threshold so short pauses are visible and we decide what to
  // do with them here, rather than never seeing them.
  const minDurationS = options.minDurationS ?? 0.18;

  const regions = await detectSilenceByAmplitude(audioPath, {
    noiseDb,
    minDurationS,
    seekSec: Math.max(0, startSeconds),
    durationSec: Math.max(0.1, endSeconds - startSeconds),
  });

  /**
   * Normalise to ABSOLUTE source time.
   *
   * ffmpeg's reported silencedetect timestamps under an input seek are not consistently
   * relative or absolute, and guessing wrong is silent: offsetting already-absolute times
   * pushed every region past the end of the clip, so zero cuts were produced while the
   * planner still cheerfully reported "13 silences measured". Decide from the data.
   */
  const span = Math.max(0.1, endSeconds - startSeconds);
  const maxEnd = regions.length ? Math.max(...regions.map((r) => r.end)) : 0;
  // Absolute if the values already reach past the requested window length.
  const isAbsolute = maxEnd > span + 1;
  const offset = isAbsolute ? 0 : Math.max(0, startSeconds);

  return regions
    .map((r) => ({
      start: +(r.start + offset).toFixed(3),
      end: +(r.end + offset).toFixed(3),
    }))
    .filter((r) => r.end > r.start)
    .filter((r) => r.end > startSeconds - 0.001 && r.start < endSeconds + 0.001)
    .map((r) => ({ ...r, seconds: +(r.end - r.start).toFixed(3) }));
}

/**
 * Build cuts from measured silence.
 * Padding keeps a little air either side so speech isn't clipped; a region that would
 * yield a cut shorter than minCutMs is left alone.
 */
function cutsFromSilence(regions, {
  maxInternalGapMs = 300, keepHeadMs = 70, keepTailMs = 90, minCutMs = 60,
  clipStart, clipEnd,
} = {}) {
  const cuts = [];
  for (const r of regions) {
    if (r.seconds * 1000 <= maxInternalGapMs) continue;
    const start = Math.max(clipStart, r.start + keepHeadMs / 1000);
    const end = Math.min(clipEnd, r.end - keepTailMs / 1000);
    if ((end - start) * 1000 < minCutMs) continue;
    cuts.push({ start: +start.toFixed(3), end: +end.toFixed(3), source: 'silence' });
  }
  return cuts;
}

/**
 * Tighten clip edges onto real speech using measured silence, so a clip opens and closes
 * on a word even when the transcript claims otherwise.
 */
function tightenToSpeech(regions, clipStart, clipEnd, { edgeKeepMs = 60 } = {}) {
  let start = clipStart;
  let end = clipEnd;
  const head = regions.find((r) => r.start <= clipStart + 0.05 && r.end > clipStart);
  if (head) start = Math.min(end - 0.5, head.end - edgeKeepMs / 1000);
  const tail = regions.find((r) => r.end >= clipEnd - 0.05 && r.start < clipEnd);
  if (tail) end = Math.max(start + 0.5, tail.start + edgeKeepMs / 1000);
  return { start: +Math.max(0, start).toFixed(3), end: +end.toFixed(3) };
}

/**
 * THE GATE THAT COUNTS: run against the produced MP4, after everything.
 * No upstream mistake — bad word timings, a mis-applied cut, a concat artefact — can get
 * past this, because it listens to the actual file.
 */
async function verifyRenderedFile(mp4Path, {
  maxInternalGapMs = 350, maxEdgeSilenceMs = 400, noiseDb = -32,
} = {}) {
  const probe = await detectSilenceByAmplitude(mp4Path, {
    noiseDb,
    minDurationS: maxInternalGapMs / 1000,
  });

  const { execFileSync } = require('child_process');
  const duration = parseFloat(
    execFileSync(require('../ffmpeg').FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', mp4Path], { encoding: 'utf8' }).trim()
  );

  const interior = [];
  let headMs = 0;
  let tailMs = 0;
  for (const r of probe) {
    const atHead = r.start <= 0.05;
    const atTail = r.end >= duration - 0.05;
    if (atHead) headMs = Math.max(headMs, (r.end - r.start) * 1000);
    else if (atTail) tailMs = Math.max(tailMs, (r.end - r.start) * 1000);
    else interior.push({ at: +r.start.toFixed(2), ms: Math.round((r.end - r.start) * 1000) });
  }

  const worst = interior.reduce((m, g) => (g.ms > m.ms ? g : m), { ms: 0, at: null });
  const passed = worst.ms <= maxInternalGapMs && headMs <= maxEdgeSilenceMs && tailMs <= maxEdgeSilenceMs;

  return {
    passed,
    durationSeconds: +duration.toFixed(2),
    worstInteriorGapMs: worst.ms,
    worstInteriorGapAt: worst.at,
    interiorGaps: interior,
    headSilenceMs: Math.round(headMs),
    tailSilenceMs: Math.round(tailMs),
    threshold: { maxInternalGapMs, maxEdgeSilenceMs, noiseDb },
    detail: passed
      ? `Clean: largest interior gap ${worst.ms}ms, head ${Math.round(headMs)}ms, tail ${Math.round(tailMs)}ms.`
      : `${worst.ms}ms of dead air at ${worst.at}s (limit ${maxInternalGapMs}ms); head ${Math.round(headMs)}ms, tail ${Math.round(tailMs)}ms.`,
  };
}

/**
 * Trim trailing silence off a rendered clip.
 *
 * Needed because the clip's end comes from a word timestamp, and whisper stretches the
 * final word to meet the next one — observed: "short." reported as 31.26→31.86 when the
 * speech actually stops around 31.2. Add the renderer's fade-out and the file ends with
 * ~0.5s of nothing. Rather than excuse it, measure the produced file and cut the end.
 *
 * Re-encodes only if needed; a stream copy would land on the nearest keyframe and is not
 * accurate enough at half-second granularity.
 */
async function trimTrailingSilence(mp4Path, { maxTailMs = 250, noiseDb = -32 } = {}) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const FFMPEG = process.env.FFMPEG_BIN || require('ffmpeg-static');

  const duration = parseFloat(
    execFileSync(require('../ffmpeg').FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', mp4Path], { encoding: 'utf8' }).trim()
  );

  const regions = await detectSilenceByAmplitude(mp4Path, { noiseDb, minDurationS: 0.15 });
  const tail = regions.find((r) => r.end >= duration - 0.06);
  if (!tail) return { trimmed: false, tailMs: 0 };

  const tailMs = (duration - tail.start) * 1000;
  if (tailMs <= maxTailMs) return { trimmed: false, tailMs: Math.round(tailMs) };

  // Keep a short breath after the last word rather than cutting flush.
  const newDuration = Math.max(1, tail.start + maxTailMs / 1000);
  const tmp = path.join(path.dirname(mp4Path), `.trim-${path.basename(mp4Path)}`);
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', mp4Path, '-t', newDuration.toFixed(3),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', tmp,
  ]);
  fs.renameSync(tmp, mp4Path);
  return {
    trimmed: true,
    tailMs: Math.round(tailMs),
    removedMs: Math.round(duration * 1000 - newDuration * 1000),
    newDurationSeconds: +newDuration.toFixed(2),
  };
}

module.exports = {
  measureSilence, cutsFromSilence, tightenToSpeech, verifyRenderedFile, trimTrailingSilence,
};
