/**
 * Deterministic detection of "no transcribed speech" regions.
 *
 * The LLM only cuts where there's text to reason about. Long opening silences before
 * the speaker starts, mid-video pauses, and trailing silence after the speaker stops
 * all leave the LLM no anchor — so they survive into the output. This module finds
 * those regions directly from the transcript's word timing and emits silence cuts.
 *
 * Returns objects shaped like the LLM cut-decider's outputs so they merge cleanly.
 */

function detectSilenceRegions(transcript, sourceDuration, opts = {}) {
  // Two thresholds, tuned for short-form vertical:
  //  - edgeMinDuration: how much leading/trailing silence to cut (very aggressive — 0.4s)
  //  - midMinDuration: how big an inter-thought gap before we cut it. 0.5s is the
  //    short-form sweet spot — anything longer feels draggy on TikTok/Reels/Shorts.
  //    For long-form (podcasts, interviews) override via client config (silence_mid_min_s)
  //    to a more conservative value like 1.5s so natural pacing survives.
  const {
    minDuration = 0.6,
    edgeMinDuration = 0.4,
    midMinDuration = 0.5,
    padding = 0.1,
  } = opts;

  const words = (transcript.words || [])
    .slice()
    .sort((a, b) => a.start - b.start);

  // No words at all = entire file is silence (defensive).
  if (words.length === 0) {
    return [
      {
        start_seconds: 0,
        end_seconds: sourceDuration,
        action: 'drop',
        reason: 'silence',
        note: 'no transcribed speech in source',
        confidence: 0.95,
        source: 'silence-detector',
      },
    ];
  }

  const cuts = [];

  // 1. Leading silence — from t=0 to the start of the first transcribed word.
  //    Apply a small padding so we don't cut the breath/onset right before the first word.
  const firstStart = words[0].start;
  if (firstStart >= edgeMinDuration) {
    cuts.push({
      start_seconds: 0,
      end_seconds: Math.max(0, firstStart - padding),
      action: 'drop',
      reason: 'silence',
      note: `${firstStart.toFixed(2)}s of silence before speech starts`,
      confidence: 0.97,
      source: 'silence-detector',
    });
  }

  // 2. Inter-word gaps that span across segments — these are real silent pauses
  //    the speaker took, often where they thought, restarted, or moved between thoughts.
  //    (Within-segment gaps are handled by the stutter-detector since those typically
  //    contain Whisper-suppressed half-words.)
  const segments = transcript.segments || [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap < midMinDuration) continue;

    // Skip gaps WITHIN a single segment — those are stutter-detector territory.
    const inSameSegment = segments.some(
      (s) => words[i - 1].end >= s.start - 0.05 && words[i].start <= s.end + 0.05,
    );
    if (inSameSegment) continue;

    cuts.push({
      start_seconds: words[i - 1].end + padding,
      end_seconds: Math.max(words[i - 1].end + padding + 0.05, words[i].start - padding),
      action: 'drop',
      reason: 'silence',
      note: `${gap.toFixed(2)}s pause between thoughts`,
      confidence: 0.92,
      source: 'silence-detector',
    });
  }

  // 3. Trailing silence — from the end of the last transcribed word to source end.
  const lastEnd = words[words.length - 1].end;
  if (sourceDuration - lastEnd >= edgeMinDuration) {
    cuts.push({
      start_seconds: lastEnd + padding,
      end_seconds: sourceDuration,
      action: 'drop',
      reason: 'silence',
      note: `${(sourceDuration - lastEnd).toFixed(2)}s of trailing silence`,
      confidence: 0.97,
      source: 'silence-detector',
    });
  }

  return cuts.filter((c) => c.end_seconds - c.start_seconds >= 0.1);
}

// ─── Word-derived cut padding ──────────────────────────────────────────────
//
// Whisper timestamps are coarse: the actual audio onset is typically 50-150ms
// before Whisper's word.start, and the offset is 50-150ms after word.end.
// Without padding, deleted words leave audible remnants at cut boundaries.
//
// These constants are applied whenever a manual cut is derived from word
// boundaries (script selection, filler removal). They are NOT applied to
// silence-based cuts (which are already boundary-snapped by ffmpeg).

const CUT_PADDING = {
  startPadMs: 80,   // shave this many ms BEFORE Whisper's start
  endPadMs:   120,  // extend this many ms AFTER Whisper's end
  // Absorb trailing gap: if the next word starts within maxAbsorbMs after
  // our padded end, extend to just before that next word — cleans up the
  // breath/pause that naturally follows a filler or mistake.
  maxAbsorbMs: 250,
};

/**
 * Build a padded manual cut from a word range, optionally absorbing surrounding
 * silence from the transcript's word timing.
 *
 * @param {number} wordStart   - word.start of the first word in the selection
 * @param {number} wordEnd     - word.end of the last word in the selection
 * @param {object[]} allWords  - full flat word array (sorted by start)
 *                               used to absorb the gap to the next word
 * @param {object} [opts]      - override CUT_PADDING values
 * @returns {{ start: number, end: number }}
 */
function padWordCut(wordStart, wordEnd, allWords = [], opts = {}) {
  const { startPadMs, endPadMs, maxAbsorbMs } = { ...CUT_PADDING, ...opts };

  let cutStart = Math.max(0, wordStart - startPadMs / 1000);
  let cutEnd   = wordEnd + endPadMs / 1000;

  // Absorb the gap between our cut end and the NEXT spoken word, up to maxAbsorbMs.
  // This removes the audible breath/pause that follows a filler or mistake word.
  const nextWord = allWords.find((w) => w.start > wordEnd + 0.01);
  if (nextWord) {
    const gapToNext = nextWord.start - wordEnd;
    const absorbed  = Math.min(gapToNext, maxAbsorbMs / 1000);
    cutEnd = wordEnd + absorbed;
  }

  // Snap cut start back to the previous word boundary if there's a short gap.
  const prevWord = [...allWords].reverse().find((w) => w.end < wordStart - 0.01);
  if (prevWord) {
    const gapFromPrev = wordStart - prevWord.end;
    if (gapFromPrev < startPadMs / 1000) {
      // Gap is smaller than our pad — keep the pad so we don't eat into kept audio
    }
    // else: there's real audio before the cut, just use the pad
  }

  return { start: Math.max(0, cutStart), end: cutEnd };
}

// ─── ffmpeg amplitude-based silence detection ──────────────────────────────
//
// Uses ffmpeg's silencedetect audio filter to find regions where audio amplitude
// stays below a dB threshold for at least minDurationS. This catches actual audio
// silence regardless of what Whisper transcribed — unlike the word-gap approach
// above which only finds gaps between words in the transcript.

const SILENCE_PRESETS_AMPLITUDE = {
  // auto: picks threshold based on the clip's noise floor (not yet adaptive; uses natural for now)
  auto:    { noiseDb: -32, minDurationS: 0.6  }, // balanced default
  natural: { noiseDb: -32, minDurationS: 0.8  }, // real pauses between sentences
  fast:    { noiseDb: -30, minDurationS: 0.4  }, // pauses ≥ 0.4s
  faster:  { noiseDb: -28, minDurationS: 0.25 }, // micro-pauses ≥ 0.25s
};

/**
 * Detect silence regions in a media file via ffmpeg's silencedetect filter.
 *
 * @param {string} sourcePath    - Path to source MP4/MOV
 * @param {object} [opts]
 * @param {number} [opts.noiseDb=-30]       - Amplitude threshold in dBFS. Below this = silence.
 * @param {number} [opts.minDurationS=0.4]  - Minimum contiguous silence to report.
 * @param {number} [opts.seekSec=0]         - Start analysis at this offset (seconds).
 * @param {number} [opts.durationSec]       - Analyse only this many seconds.
 * @returns {Promise<Array<{start:number, end:number}>>}
 */
function detectSilenceByAmplitude(sourcePath, opts = {}) {
  const noiseDb   = opts.noiseDb    ?? -30;
  const minDur    = opts.minDurationS ?? 0.4;
  const seekSec   = opts.seekSec    ?? 0;
  const durSec    = opts.durationSec ?? null;

  const { spawn } = require('child_process');
  const FFMPEG = process.env.FFMPEG_BIN || require('ffmpeg-static');

  const args = [
    '-hide_banner', '-loglevel', 'info',
  ];
  if (seekSec > 0) args.push('-ss', seekSec.toFixed(3));
  args.push('-i', sourcePath);
  if (durSec != null) args.push('-t', durSec.toFixed(3));
  args.push(
    '-af', `silencedetect=n=${noiseDb}dB:d=${minDur}`,
    '-vn', '-f', 'null', '-',
  );

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', () => {
      const regions = [];
      let currentStart = null;
      for (const line of stderr.split('\n')) {
        const sm = line.match(/silence_start:\s*(-?[\d.]+)/);
        const em = line.match(/silence_end:\s*(-?[\d.]+)/);
        if (sm) {
          // timestamps are relative to seekSec when -ss is before -i
          currentStart = Math.max(0, parseFloat(sm[1]) + seekSec);
        } else if (em && currentStart !== null) {
          const end = parseFloat(em[1]) + seekSec;
          if (end > currentStart) regions.push({ start: currentStart, end });
          currentStart = null;
        }
      }
      // Handle trailing silence with no end tag (clip ended while silent)
      if (currentStart !== null) {
        const end = (seekSec + (durSec ?? 0)) || currentStart + minDur;
        if (end > currentStart) regions.push({ start: currentStart, end });
      }
      resolve(regions);
    });
    setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('silencedetect timeout')); }, 120_000);
  });
}

/**
 * Detect silences within a clip's time range using amplitude analysis.
 * Returns regions in SOURCE-TIMELINE coordinates.
 */
async function detectSilencesForClip(sourcePath, clip, mode = 'natural') {
  const preset = SILENCE_PRESETS_AMPLITUDE[mode] || SILENCE_PRESETS_AMPLITUDE.natural;
  const start = clip.start_seconds;
  const end   = clip.end_seconds;
  const dur   = end - start;

  const regions = await detectSilenceByAmplitude(sourcePath, {
    noiseDb:     preset.noiseDb,
    minDurationS: preset.minDurationS,
    seekSec:     start,
    durationSec: dur,
  });

  // Filter to clip boundaries and drop sub-threshold survivors
  return regions
    .filter((r) => r.end > start && r.start < end)
    .map((r) => ({ start: Math.max(r.start, start), end: Math.min(r.end, end) }))
    .filter((r) => r.end - r.start >= preset.minDurationS * 0.9);
}

module.exports = {
  detectSilenceRegions,
  CUT_PADDING,
  padWordCut,
  SILENCE_PRESETS_AMPLITUDE,
  detectSilenceByAmplitude,
  detectSilencesForClip,
};
