/**
 * Take the dead air out of a composition document.
 *
 * Given the measured pauses (see select/pauses.js) and the transcript words, this adds
 * `silence` cuts so that no pause inside the kept footage is longer than `maxPause`, and no
 * kept piece is a word-less sliver. It is what the pipeline should have produced in the
 * first place, so it runs on a new clip's default document, and the editor exposes it as
 * "Tighten pauses" for documents that already exist.
 *
 * Two things it will not do:
 *  - cut a quiet word. Unstressed words ("the", "this", "I") can sit 20 dB under the peaks
 *    and read as pause; any transcript word that starts inside a pause is fenced off.
 *  - leave a join with no air. A cut inside a pause keeps `keepBefore` after the previous
 *    word and `keepAfter` before the next one, so speech never butts up against speech.
 *
 * Pure: document in, document out.
 */

const { normalizeCuts } = require('./doc');

const DEFAULTS = { maxPause: 0.35, keepBefore: 0.08, keepAfter: 0.12, sliver: 0.4, wordFence: 0.05 };

/** Kept spans of a document, from normalised cuts. */
function keptSpans(doc) {
  const cuts = normalizeCuts(doc.cuts, doc.range);
  const spans = [];
  let t = doc.range.start;
  for (const c of cuts) {
    if (c.start > t + 1e-6) spans.push({ start: t, end: c.start });
    t = Math.max(t, c.end);
  }
  if (doc.range.end > t + 1e-6) spans.push({ start: t, end: doc.range.end });
  return spans;
}

/** Subtract the fenced word intervals from [a, b]; returns the free segments in order. */
function minusWords(a, b, words, fence) {
  let segs = [[a, b]];
  for (const w of words) {
    const wa = w.start - fence;
    const wb = w.end + fence;
    const next = [];
    for (const [s, e] of segs) {
      if (wb <= s || wa >= e) { next.push([s, e]); continue; }
      if (wa > s) next.push([s, wa]);
      if (wb < e) next.push([wb, e]);
    }
    segs = next;
  }
  return segs;
}

/**
 * @param {object} doc          a normalised composition document
 * @param {Array<{start:number,end:number}>} pauses   measured pauses, absolute seconds
 * @param {Array<{start:number,end:number}>} words    transcript words (absolute seconds)
 * @param {object} [opts]       see DEFAULTS
 * @returns {{ doc: object, added: Array, removedSeconds: number }}
 */
function tightenCuts(doc, pauses, words, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const spans = keptSpans(doc);
  const added = [];
  const sorted = [...(words || [])].sort((a, b) => a.start - b.start);

  for (const span of spans) {
    const inSpan = sorted.filter((w) => w.start >= span.start && w.start < span.end);
    const len = span.end - span.start;

    // A kept piece with no words in it: a sliver between two cuts, or a stretch of dead air
    // the old detector fragmented. If it is short, or nothing in it is voiced, it goes whole.
    if (!inSpan.length) {
      const covered = pauses
        .filter((p) => p.end > span.start && p.start < span.end)
        .reduce((s, p) => s + (Math.min(p.end, span.end) - Math.max(p.start, span.start)), 0);
      if (len < o.sliver || covered >= len - 0.05) {
        added.push({ start: span.start, end: span.end, source: 'silence' });
        continue;
      }
    }

    for (const p of pauses) {
      const a = Math.max(p.start, span.start);
      const b = Math.min(p.end, span.end);
      if (b - a <= o.maxPause) continue;
      // Words strictly inside the pause are fenced; the word the pause ends on is not — it
      // delimits the pause, and keepAfter already leaves the air in front of it.
      const fenced = inSpan.filter((w) => w.start > a + 0.02 && w.start < b - 0.02);
      for (const [s, e] of minusWords(a, b, fenced, o.wordFence)) {
        if (e - s <= o.maxPause) continue;
        // At a span edge there is already a cut; the air is kept on the other side only.
        const cs = s <= span.start + 1e-6 ? span.start : s + o.keepBefore;
        const ce = e >= span.end - 1e-6 ? span.end : e - o.keepAfter;
        if (ce - cs >= 0.06) added.push({ start: +cs.toFixed(3), end: +ce.toFixed(3), source: 'silence' });
      }
    }
  }

  const cuts = normalizeCuts([...doc.cuts, ...added], doc.range);
  const before = spans.reduce((s, x) => s + (x.end - x.start), 0);
  const after = keptSpans({ ...doc, cuts }).reduce((s, x) => s + (x.end - x.start), 0);
  return { doc: { ...doc, cuts }, added, removedSeconds: +(before - after).toFixed(3) };
}

/** Dead air that would still be in the output: pauses longer than `maxPause` inside kept spans. */
function deadAir(doc, pauses, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  for (const span of keptSpans(doc)) {
    for (const p of pauses) {
      const a = Math.max(p.start, span.start);
      const b = Math.min(p.end, span.end);
      if (b - a > o.maxPause) out.push({ start: +a.toFixed(3), end: +b.toFixed(3), seconds: +(b - a).toFixed(3) });
    }
  }
  return out;
}

module.exports = { tightenCuts, deadAir, keptSpans, DEFAULTS };
