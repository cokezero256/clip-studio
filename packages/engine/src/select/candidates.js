/**
 * Candidate generation — the deterministic SEARCH half of selection.
 *
 * Produces a few dozen structurally-valid spans from a transcript of any length, in
 * milliseconds, with no model call. The model then only has to JUDGE a short list rather
 * than search a 40,000-token haystack, which is what it was bad at.
 */

const {
  deadZones, inZones, scoreSpan, rankScore,
  DANGLING_OPEN, SENTENCE_END, RESULT_CLAIM,
} = require('./signals');
const { sentenceEndIndices, sentenceStartIndices, describeStrategy } = require('./boundaries');

/**
 * Length band. Measured from the reference reels the client actually wants to imitate:
 * 29.7, 33.3, 48.4, 49.4, 57.4, 71.1s. v1's "stream" preset asked for 2–4 MINUTE segments,
 * which is simply the wrong shape for this niche and guaranteed bad picks.
 */
/**
 * Length band, set by the client rather than inferred:
 *   "at least 25-30 seconds and not more than 120; between 60 and 120 is good."
 * The earlier 22-78s band came from measuring reference reels, but those are the FINISHED
 * posts — a livestream cut wants more room to set up a trade and then pay it off.
 */
const DEFAULTS = {
  minSeconds: 26,
  maxSeconds: 120,
  idealMin: 60,
  idealMax: 120,
  maxCandidates: 60,
  maxAnchors: 150,
  overlapIoU: 0.45,
  // A span mostly inside one already kept is the same moment, whatever its IoU says.
  overlapContainment: 0.6,
  maxInteriorGap: 1.2,   // a wall this big can't be inside a clip even after cuts
};

/**
 * Sentence boundaries come from ./boundaries, which handles the fact that OpenAI strips
 * punctuation from words[] while whisper.cpp keeps it. Testing words directly finds one
 * sentence on an OpenAI transcript and yields zero candidates with no error.
 */
function sentenceStarts(transcript, silences) {
  return [...sentenceStartIndices(transcript, silences)].sort((a, b) => a - b);
}
function sentenceEnds(transcript, silences) {
  return [...sentenceEndIndices(transcript, silences)].sort((a, b) => a - b);
}

function intersection(a, b) {
  const lo = Math.max(a.startSeconds, b.startSeconds);
  const hi = Math.min(a.endSeconds, b.endSeconds);
  return Math.max(0, hi - lo);
}

function iou(a, b) {
  const inter = intersection(a, b);
  const union = (a.endSeconds - a.startSeconds) + (b.endSeconds - b.startSeconds) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * How much of the SHORTER span sits inside the other.
 *
 * IoU alone cannot see containment, and that is how the same moment reached the editor
 * twice: a 33s clip nested entirely inside a 99s one scores IoU 33/99 = 0.37, under the
 * 0.45 suppression threshold, so both survived and took two of only four final picks.
 * Measured on a real run — identical hook text, identical opening, one a strict subset of
 * the other. Containment catches exactly this case and leaves genuinely distinct
 * neighbouring moments alone.
 */
function containment(a, b) {
  const inter = intersection(a, b);
  const shorter = Math.min(a.endSeconds - a.startSeconds, b.endSeconds - b.startSeconds);
  return shorter > 0 ? inter / shorter : 0;
}

/**
 * Generate ranked candidate spans.
 *
 * Hard structural rules applied here, so nothing downstream can violate them:
 *   - must start at a sentence start that is not a dangling back-reference
 *   - must end at a sentence end
 *   - must not contain a >1.2s wall of silence
 *   - must not overlap a masked dead zone
 *   - must fall inside the length band
 */
function generateCandidates(transcript, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const words = transcript.words || [];
  if (words.length < 20) return { candidates: [], deadZones: [], stats: { words: words.length } };

  const zones = deadZones(words);
  const starts = sentenceStarts(transcript, o.silenceRegions);
  const ends = sentenceEnds(transcript, o.silenceRegions);
  const endSet = ends.slice();
  const endLookup = new Set(ends);

  // Rank anchors so we evaluate the most promising openings first on very long sources.
  const anchors = starts
    .filter((i) => !DANGLING_OPEN.test(words[i].word.trim()))
    .filter((i) => !inZones(words[i].start, zones))
    .map((i) => {
      const look = words.slice(i, i + 14).map((w) => w.word).join(' ');
      let pri = 0;
      if (RESULT_CLAIM.test(look)) pri += 3;
      if (/\$\s?\d|\b\d+\s?%|\b\d+\s?(points?|pips?|R)\b/.test(look)) pri += 2;
      if (/^(what|why|how|when|the (biggest|number one|worst)|here'?s|this is)/i.test(look)) pri += 1.5;
      return { i, pri };
    })
    .sort((a, b) => b.pri - a.pri)
    .slice(0, o.maxAnchors);

  const out = [];
  for (const { i: s } of anchors) {
    const t0 = words[s].start;
    // Only sentence-ends inside the legal length band are possible payoffs.
    for (const e of endSet) {
      if (e <= s) continue;
      const dur = words[e].end - t0;
      /**
       * Generate against the RAW duration, allowing for what silence removal will take.
       *
       * Candidates were being built at exactly 26-120s and then failing the duration gate
       * because cutting the dead air shrank them below the floor — 17 of 22 died this way.
       * Real cuts removed 4-8% of a span, so the raw window starts proportionally higher.
       */
      if (dur < o.minSeconds * 1.12) continue;
      if (dur > o.maxSeconds * 1.05) break;

      // Reject any span containing a wall of silence or crossing a dead zone.
      let bad = false;
      for (let k = s + 1; k <= e; k++) {
        if (words[k].start - words[k - 1].end > o.maxInteriorGap) { bad = true; break; }
      }
      if (bad) continue;
      if (inZones(words[e].end, zones)) continue;

      const scored = scoreSpan(words, s, e, { sentenceEnds: endLookup });
      if (!scored) continue;
      if (scored.signals.openPenalty || scored.signals.endPenalty) continue;

      let score = rankScore(scored);
      // Prefer the length band the reference reels actually live in.
      if (dur >= o.idealMin && dur <= o.idealMax) score += 1;
      out.push({ ...scored, startIndex: s, endIndex: e, prescore: +score.toFixed(3) });
    }
  }

  // Non-max suppression so we don't hand the model 20 variants of the same moment.
  out.sort((a, b) => b.prescore - a.prescore);
  const kept = [];
  for (const c of out) {
    if (kept.some((k) => iou(k, c) > o.overlapIoU || containment(k, c) > o.overlapContainment)) continue;
    kept.push(c);
    if (kept.length >= o.maxCandidates) break;
  }

  return {
    candidates: kept,
    deadZones: zones,
    stats: {
      words: words.length,
      durationSeconds: words[words.length - 1].end,
      deadZoneSeconds: zones.reduce((s, z) => s + (z.end - z.start), 0),
      anchors: anchors.length,
      sentences: ends.length,
      boundaryStrategy: describeStrategy(transcript, o.silenceRegions),
      rawSpans: out.length,
      kept: kept.length,
    },
  };
}

module.exports = { generateCandidates, sentenceStarts, sentenceEnds, iou, DEFAULTS , __testables: { iou, containment }};
