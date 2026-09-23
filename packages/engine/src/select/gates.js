/**
 * Clip gates — hard, mechanical quality checks.
 *
 * WHY THIS EXISTS: the standing complaint about hand-cut clips is dead air. Editors know
 * the rule and still ship clips with silence in them, because "check for silence" is a
 * habit rather than a step. So silence-freedom is not advice here and not a setting —
 * a clip cannot reach `ready` unless it passes. The UI shows the failing gate and why.
 *
 * Every gate is a pure function of (clip, transcript). No ffmpeg, no model calls — so the
 * whole set runs in microseconds and is exhaustively unit-testable.
 */

const DEFAULTS = {
  maxInternalGapMs: 350,   // a beat is fine; a pause is not
  maxEdgeSilenceMs: 150,   // clips must start ON the word and end ON the word
  // Reference reels measure 29.7–71.1s; v1's stream preset asked for 2–4 MINUTE segments,
  // which is the wrong shape for this niche entirely.
  minDurationSeconds: 26,
  maxDurationSeconds: 120,
  /**
   * MEASURED, not aspirational. After auto-cuts, real tight speech from a raw recording
   * lands at 88–93%; the same spans uncut run 78–91%. An earlier 0.95 here was calibrated
   * against a broken ratio that double-counted overlapping word timings and reported >100%.
   * 0.85 passes genuine tight speech and still rejects spans that remain >15% dead air
   * after cutting — i.e. rambling the cuts can't rescue.
   */
  minSpeechRatio: 0.85,
};

const SENTENCE_END = /[.!?]["')\]]?$/;
const { sentenceEndIndices } = require('./boundaries');
/**
 * Openers that prove the clip is NOT self-contained: they refer to something the viewer
 * never saw. This is the single most common reason a technically-fine clip flops.
 */
const BACK_REFERENCE = /^(so|and|but|then|also|because|which|that|this|it|they|he|she|there|here|those|these|anyway|again|plus|however)\b/i;

/** Spans of the clip that survive after the editor's/auto cuts are removed. */
function keptSpans(clip) {
  const cuts = (clip.manual_cuts || [])
    .map((c) => ({ start: Math.max(c.start, clip.start_seconds), end: Math.min(c.end, clip.end_seconds) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);

  // Merge overlaps so an overlapping pair can't double-subtract.
  const merged = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }

  const spans = [];
  let cursor = clip.start_seconds;
  for (const c of merged) {
    if (c.start > cursor) spans.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < clip.end_seconds) spans.push({ start: cursor, end: clip.end_seconds });
  return spans;
}

/** Words inside the clip, clipped to the kept spans, in output order. */
function clipWords(clip, transcript) {
  const spans = keptSpans(clip);
  const out = [];
  for (const w of transcript.words || []) {
    if (w.end <= clip.start_seconds || w.start >= clip.end_seconds) continue;
    if (spans.some((s) => w.start < s.end && w.end > s.start)) out.push(w);
  }
  return out;
}

/** Total kept duration — what the viewer actually watches. */
function effectiveDuration(clip) {
  return keptSpans(clip).reduce((sum, s) => sum + (s.end - s.start), 0);
}

/**
 * Gaps between consecutive words, measured in OUTPUT time: a gap that a cut removes is
 * not a gap. Without this, every clip with cuts would false-fail G1.
 */
function outputGaps(clip, transcript) {
  const spans = keptSpans(clip);
  const words = clipWords(clip, transcript);
  const gaps = [];

  // How much cut-away time lies between two source timestamps.
  const removedBetween = (a, b) => {
    let inside = 0;
    for (const s of spans) {
      const lo = Math.max(a, s.start);
      const hi = Math.min(b, s.end);
      if (hi > lo) inside += hi - lo;
    }
    return Math.max(0, b - a - inside);
  };

  for (let i = 1; i < words.length; i++) {
    const rawGap = words[i].start - words[i - 1].end;
    if (rawGap <= 0) continue;
    const real = rawGap - removedBetween(words[i - 1].end, words[i].start);
    if (real > 0) gaps.push({ at: words[i - 1].end, seconds: real, before: words[i].word });
  }
  return gaps;
}

function gate(id, name, passed, detail) {
  return { id, name, passed, detail };
}

/**
 * Run every gate. Returns `passed` plus a per-gate breakdown so the UI can say exactly
 * what is wrong rather than silently dropping the clip.
 */
function evaluateGates(clip, transcript, options = {}) {
  const o = { ...DEFAULTS, ...options };
  // Sentence-ness must come from the derived boundary set. OpenAI transcripts strip
  // punctuation from words[], so testing the last word directly fails EVERY clip.
  const endIdx = o.sentenceEnds || sentenceEndIndices(transcript);
  const words = clipWords(clip, transcript);
  const duration = effectiveDuration(clip);
  const results = [];

  if (!words.length) {
    results.push(gate('G0', 'Has speech', false, 'No transcript words fall inside this clip.'));
    return { passed: false, results, duration, wordCount: 0 };
  }

  // G1 — no internal dead air.
  const gaps = outputGaps(clip, transcript);
  const worst = gaps.reduce((m, g) => (g.seconds > m.seconds ? g : m), { seconds: 0 });
  const g1 = worst.seconds * 1000 <= o.maxInternalGapMs;
  results.push(gate('G1', 'No internal silence', g1,
    g1 ? `Largest gap ${Math.round(worst.seconds * 1000)}ms (limit ${o.maxInternalGapMs}ms).`
       : `${Math.round(worst.seconds * 1000)}ms of dead air at ${worst.at.toFixed(2)}s, before "${worst.before}". Limit is ${o.maxInternalGapMs}ms.`));

  // G2 — starts and ends on the word.
  const head = (words[0].start - clip.start_seconds) * 1000;
  const tail = (clip.end_seconds - words[words.length - 1].end) * 1000;
  const g2 = head <= o.maxEdgeSilenceMs && tail <= o.maxEdgeSilenceMs;
  results.push(gate('G2', 'No edge silence', g2,
    g2 ? `Head ${Math.round(head)}ms, tail ${Math.round(tail)}ms.`
       : `Head ${Math.round(head)}ms, tail ${Math.round(tail)}ms — limit ${o.maxEdgeSilenceMs}ms each.`));

  // G3 — duration.
  const g3 = duration >= o.minDurationSeconds && duration <= o.maxDurationSeconds;
  results.push(gate('G3', 'Duration in range', g3,
    `${duration.toFixed(1)}s (target ${o.minDurationSeconds}–${o.maxDurationSeconds}s).`));

  // G4 — self-contained: opens a sentence, closes a sentence, no dangling back-reference.
  const first = words[0].word.trim();
  const last = words[words.length - 1].word.trim();
  const lastGlobalIdx = (transcript.words || []).indexOf(words[words.length - 1]);
  const endsClean = SENTENCE_END.test(last) || endIdx.has(lastGlobalIdx);
  const opensClean = !BACK_REFERENCE.test(first);
  const g4 = endsClean && opensClean;
  results.push(gate('G4', 'Self-contained', g4,
    g4 ? `Opens on "${first}", closes on "${last}".`
       : [!opensClean && `Opens on "${first}" — refers back to something the viewer didn't see.`,
          !endsClean && `Ends mid-sentence on "${last}".`].filter(Boolean).join(' ')));

  // G5 — aggregate speech ratio. Catches death by a thousand small gaps that each pass G1
  // individually. Measured as (kept duration − all gap time) / kept duration.
  //
  // NOTE: do NOT compute this by summing word durations. Whisper word timings can overlap
  // slightly, so the sum double-counts and produces ratios above 100% — which is how this
  // was first written, and it reported 102.6% on a real clip.
  const totalGapSeconds = gaps.reduce((s, g) => s + g.seconds, 0);
  const ratio = duration > 0 ? Math.max(0, (duration - totalGapSeconds) / duration) : 0;
  const g5 = ratio >= o.minSpeechRatio;
  results.push(gate('G5', 'Speech coverage', g5,
    `${(ratio * 100).toFixed(1)}% of the clip is speech (need ${(o.minSpeechRatio * 100).toFixed(0)}%).`));

  return {
    passed: results.every((r) => r.passed),
    results,
    duration,
    wordCount: words.length,
    largestGapMs: Math.round(worst.seconds * 1000),
    speechRatio: ratio,
  };
}

module.exports = {
  evaluateGates, keptSpans, clipWords, effectiveDuration, outputGaps,
  DEFAULTS, SENTENCE_END, BACK_REFERENCE,
};
