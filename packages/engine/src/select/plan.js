/**
 * Clip planning — turn a raw candidate span into a shippable, gate-passing clip.
 *
 * THIS IS WHERE "clips must never contain silence" actually becomes true.
 *
 * Candidate generation permits interior gaps up to 1.2s, because a natural pause is often
 * exactly where a good clip lives. The gates then demand no gap over 350ms. Those two are
 * reconciled here: every qualifying gap becomes a CUT, so the dead air is removed rather
 * than the clip being thrown away. Without this step every candidate fails G1 and the
 * pipeline yields nothing — silence removal is not a post-hoc tidy-up, it is the step that
 * makes clips viable.
 */

const { evaluateGates } = require('./gates');
const { sentenceEndIndices } = require('./boundaries');
const { cutsFromSilence, tightenToSpeech } = require('./measure');
const { measurePauses } = require('./pauses');

/**
 * CALIBRATED against real material, not guessed. Measured on a 36-minute recording (25
 * candidate spans) and on a published rp.profits reel:
 *
 *   published viral reel .............. 100% speech, 0 residual gaps  ← the target
 *   raw recording, no cuts ............ median 87.1%, worst 77.9%
 *   raw recording, auto-cut @350ms .... median 91.7%
 *   raw recording, auto-cut @300ms .... median 91.9%
 *   raw recording, auto-cut @250ms .... median 92.1%  ← plateau
 *
 * Below ~250ms the threshold stops mattering: keepHead + keepTail + minCut sets a floor on
 * what a cut can remove, so tighter thresholds find gaps they cannot act on. The padding,
 * not the threshold, is the binding constraint — which is why it's tuned here too.
 */
const DEFAULTS = {
  maxInternalGapMs: 300,
  // Air retained either side of a cut so speech doesn't sound clipped. v1's padWordCut used
  // −80/+120ms; 70/90 is slightly tighter, still well clear of the consonant onsets that
  // cause audible chopping.
  keepHeadMs: 70,
  keepTailMs: 90,
  minCutMs: 60,        // below this a cut costs more in artefacts than it saves
  edgeTrimMs: 40,      // tiny breath left at clip head/tail
};

/**
 * Build the cut list that removes interior dead air.
 * Returns cuts in SOURCE time, the same shape the renderer already consumes.
 */
function autoCuts(startSeconds, endSeconds, transcript, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const words = (transcript.words || []).filter(
    (w) => w.end > startSeconds && w.start < endSeconds
  );
  const cuts = [];
  for (let i = 1; i < words.length; i++) {
    const gapStart = words[i - 1].end;
    const gapEnd = words[i].start;
    const gapMs = (gapEnd - gapStart) * 1000;
    if (gapMs <= o.maxInternalGapMs) continue;

    const cutStart = gapStart + o.keepHeadMs / 1000;
    const cutEnd = gapEnd - o.keepTailMs / 1000;
    if ((cutEnd - cutStart) * 1000 < o.minCutMs) continue;
    cuts.push({ start: +cutStart.toFixed(3), end: +cutEnd.toFixed(3), source: 'silence' });
  }
  return cuts;
}

/**
 * Snap clip bounds onto the first and last spoken word, so the clip opens on speech and
 * ends on speech. This is what satisfies G2 without any manual trimming.
 */
function tightenBounds(startSeconds, endSeconds, transcript, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const words = (transcript.words || []).filter(
    (w) => w.end > startSeconds && w.start < endSeconds
  );
  if (!words.length) return { start: startSeconds, end: endSeconds };
  return {
    start: +Math.max(0, words[0].start - o.edgeTrimMs / 1000).toFixed(3),
    end: +(words[words.length - 1].end + o.edgeTrimMs / 1000).toFixed(3),
  };
}

/**
 * Full plan for one candidate: tighten the edges, remove the dead air, then gate.
 * A clip that still fails afterwards is genuinely unusable and says why.
 */
function planClip(candidate, transcript, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const sentenceEnds = o.sentenceEnds || sentenceEndIndices(transcript);

  const { start, end } = tightenBounds(candidate.startSeconds, candidate.endSeconds, transcript, o);
  const cuts = autoCuts(start, end, transcript, o);

  const clip = {
    start_seconds: start,
    end_seconds: end,
    manual_cuts: cuts,
    hook: candidate.hookText,
    prescore: candidate.prescore,
    signals: candidate.signals,
    text: candidate.text,
  };

  const gate = evaluateGates(clip, transcript, { ...o, sentenceEnds });
  const removedMs = cuts.reduce((s, c) => s + (c.end - c.start), 0) * 1000;

  return {
    ...clip,
    gate,
    ready: gate.passed,
    cutsApplied: cuts.length,
    silenceRemovedMs: Math.round(removedMs),
    finalDurationSeconds: gate.duration,
  };
}

/** Plan every candidate; ready clips first, then the rest with their reasons. */
function planAll(candidates, transcript, options = {}) {
  const sentenceEnds = sentenceEndIndices(transcript);
  const planned = candidates.map((c) => planClip(c, transcript, { ...options, sentenceEnds }));
  planned.sort((a, b) => (b.ready - a.ready) || (b.prescore - a.prescore));
  return planned;
}

/**
 * The real planner: cuts derived from MEASURED audio, not word timings.
 *
 * `planClip` (transcript-only) is kept for tests and for planning without an audio file,
 * but it cannot be trusted for the silence guarantee — whisper's `--max-len 1` word
 * timings tile with 0ms gaps straight through multi-second silences. Anything that ships
 * goes through here.
 */
async function planClipMeasured(candidate, transcript, audioPath, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const sentenceEnds = o.sentenceEnds || sentenceEndIndices(transcript, o.silenceRegions);

  // Look slightly beyond the span so an edge silence is visible and trimmable.
  const probeStart = Math.max(0, candidate.startSeconds - 1);
  const probeEnd = candidate.endSeconds + 1;
  // Pauses from the RMS envelope, relative to the speaker's level (select/pauses.js). The
  // sample-peak detector this replaced let one keyboard click split a silence into pieces
  // too short to cut, and left word-less slivers between the pieces it did cut.
  const regions = await measurePauses(audioPath, probeStart, probeEnd, {
    minPause: 0.15, protect: (transcript.words || []).map((w) => w.start),
  });

  const tight = tightenToSpeech(regions, candidate.startSeconds, candidate.endSeconds, o);
  const cuts = cutsFromSilence(regions, { ...o, clipStart: tight.start, clipEnd: tight.end })
    .filter((c) => c.start >= tight.start && c.end <= tight.end);

  const clip = {
    start_seconds: tight.start,
    end_seconds: tight.end,
    manual_cuts: cuts,
    hook: candidate.hookText,
    prescore: candidate.prescore,
    signals: candidate.signals,
    text: candidate.text,
  };

  // Structural gates (duration, self-containment) still come from the transcript; the
  // silence gates are re-derived from the measured regions below.
  const gate = evaluateGates(clip, transcript, { ...o, sentenceEnds });

  const kept = clip.end_seconds - clip.start_seconds
    - cuts.reduce((s, c) => s + (c.end - c.start), 0);
  /**
   * How much of each measured silence SURVIVES into the output.
   *
   * A cut is deliberately inset inside its silence region by keepHead/keepTail, so it
   * never covers the region exactly. An earlier "is this region covered by a cut" test
   * therefore matched nothing and reported every cut region as fully residual — the
   * planner rejected clips it had already fixed. What matters is the UNCOVERED remainder.
   */
  const residual = regions
    .filter((r) => r.end > tight.start && r.start < tight.end)
    .map((r) => {
      const lo = Math.max(r.start, tight.start);
      const hi = Math.min(r.end, tight.end);
      let covered = 0;
      for (const c of cuts) {
        const a = Math.max(lo, c.start);
        const b = Math.min(hi, c.end);
        if (b > a) covered += b - a;
      }
      return Math.max(0, (hi - lo - covered)) * 1000;
    });
  const worstResidualMs = residual.length ? Math.round(Math.max(...residual)) : 0;

  // Replace the transcript-derived silence verdicts with measured ones.
  const measuredResults = gate.results.map((g) => {
    if (g.id !== 'G1') return g;
    const ok = worstResidualMs <= o.maxInternalGapMs + 50;
    return {
      ...g, passed: ok,
      detail: ok
        ? `Largest measured gap ${worstResidualMs}ms after ${cuts.length} cuts.`
        : `${worstResidualMs}ms of measured dead air remains after ${cuts.length} cuts.`,
    };
  });

  return {
    ...clip,
    gate: { ...gate, results: measuredResults, passed: measuredResults.every((r) => r.passed) },
    ready: measuredResults.every((r) => r.passed),
    cutsApplied: cuts.length,
    silenceRemovedMs: Math.round(cuts.reduce((s, c) => s + (c.end - c.start), 0) * 1000),
    finalDurationSeconds: +kept.toFixed(2),
    measuredSilenceRegions: regions.length,
    worstResidualGapMs: worstResidualMs,
  };
}

async function planAllMeasured(candidates, transcript, audioPath, options = {}) {
  /**
   * The gate must judge sentence ends against the SAME boundary set generation used.
   *
   * Generation derives boundaries with measured audio silences (845 on a real stream);
   * the gate was deriving its own without them (165) and then rejecting 52 of 57
   * candidates for "ending mid-sentence" at points generation had deemed legal.
   */
  const sentenceEnds = sentenceEndIndices(transcript, options.silenceRegions);
  const out = [];
  for (const c of candidates) {
    out.push(await planClipMeasured(c, transcript, audioPath, { ...options, sentenceEnds }));
  }
  out.sort((a, b) => (b.ready - a.ready) || (b.prescore - a.prescore));
  return out;
}

module.exports = {
  planClip, planAll, planClipMeasured, planAllMeasured, autoCuts, tightenBounds, DEFAULTS,
};
