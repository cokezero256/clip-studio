/**
 * The timeline's model — pure functions over the composition document.
 *
 * The timeline shows EDITED time: kept footage as blocks laid end to end, the way CapCut
 * and Premiere do, so what you see is what the export plays. Every operation here returns a
 * new document; nothing touches React or the DOM, which is what lets this file be tested in
 * plain Node (`node timelineModel.test.ts`).
 *
 * Boundaries between blocks come from three places: the clip's range, a cut (removed
 * footage), or a split (a marker the editor added so a piece can be trimmed or deleted on
 * its own). Splits change nothing in the render.
 */
import type { Cut, Doc, Pause } from './types';

export type Edge = 'range' | 'cut' | 'split';
export type Block = {
  key: string;
  a: number;       // source start
  b: number;       // source end
  outStart: number;
  outEnd: number;
  startsAt: Edge;
  endsAt: Edge;
};

const MIN_BLOCK_S = 0.2;
const EPS = 1e-6;

const snap = (t: number, fps: number) => Math.round(t * fps) / fps;

/** Sort, clamp to the range, merge overlaps, drop slivers — mirrors the server's normalizeCuts. */
export function normalizeCuts(cuts: Cut[], range: { start: number; end: number }): Cut[] {
  const list = cuts
    .map((c) => ({
      start: Math.min(range.end, Math.max(range.start, c.start)),
      end: Math.min(range.end, Math.max(range.start, c.end)),
      source: c.source || 'manual',
    }))
    .filter((c) => c.end - c.start > 0.005)
    .sort((a, b) => a.start - b.start);
  const merged: Cut[] = [];
  for (const c of list) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + EPS) {
      last.end = Math.max(last.end, c.end);
      if (last.source !== c.source) last.source = 'mixed';
    } else merged.push({ ...c });
  }
  return merged.map((c) => ({ start: +c.start.toFixed(3), end: +c.end.toFixed(3), source: c.source }));
}

/** Kept source spans: the range minus its cuts. */
export function keptSpans(doc: Doc): Array<{ start: number; end: number; startsAt: Edge; endsAt: Edge }> {
  const out: Array<{ start: number; end: number; startsAt: Edge; endsAt: Edge }> = [];
  let t = doc.range.start;
  let startsAt: Edge = 'range';
  // The walk below needs sorted, merged cuts. A cut the transcript just appended is neither,
  // and a first version silently dropped it here until the page reloaded.
  for (const c of normalizeCuts(doc.cuts, doc.range)) {
    if (c.start > t + EPS) out.push({ start: t, end: c.start, startsAt, endsAt: 'cut' });
    t = Math.max(t, c.end);
    startsAt = 'cut';
  }
  if (doc.range.end > t + EPS) out.push({ start: t, end: doc.range.end, startsAt, endsAt: 'range' });
  return out;
}

/** Blocks in edited time: kept spans, frame-snapped, divided at split markers. */
export function blocks(doc: Doc, fps: number): Block[] {
  const splits = [...(doc.splits || [])].sort((a, b) => a - b);
  const out: Block[] = [];
  let outT = 0;
  for (const sp of keptSpans(doc)) {
    const a0 = snap(sp.start, fps);
    const b0 = snap(sp.end, fps);
    if (b0 - a0 < 1 / fps - EPS) continue;
    const inner = splits.map((s) => snap(s, fps)).filter((s) => s > a0 + EPS && s < b0 - EPS);
    const edges = [a0, ...inner, b0];
    for (let k = 0; k + 1 < edges.length; k++) {
      const a = edges[k];
      const b = edges[k + 1];
      if (b - a < 1 / fps - EPS) continue;
      out.push({
        key: `${a.toFixed(3)}-${b.toFixed(3)}`,
        a, b,
        outStart: outT, outEnd: outT + (b - a),
        startsAt: k === 0 ? sp.startsAt : 'split',
        endsAt: k + 2 === edges.length ? sp.endsAt : 'split',
      });
      outT += b - a;
    }
  }
  return out;
}

export const duration = (bl: Block[]) => (bl.length ? bl[bl.length - 1].outEnd : 0);

export function outToSrc(t: number, bl: Block[]): number {
  if (!bl.length) return 0;
  for (const b of bl) if (t >= b.outStart - EPS && t < b.outEnd) return b.a + (t - b.outStart);
  const last = bl[bl.length - 1];
  return t < bl[0].outStart ? bl[0].a : last.b - 1e-3;
}
export function srcToOut(s: number, bl: Block[]): number | null {
  for (const b of bl) if (s >= b.a - EPS && s < b.b) return b.outStart + (s - b.a);
  return null;
}
export const blockAt = (t: number, bl: Block[]) => bl.find((b) => t >= b.outStart - EPS && t < b.outEnd) || null;

/** Split the block under an edited-time position. No-op within a frame of an existing edge. */
export function splitAt(doc: Doc, outT: number, fps: number): Doc {
  const bl = blocks(doc, fps);
  const b = blockAt(outT, bl);
  if (!b) return doc;
  const s = snap(b.a + (outT - b.outStart), fps);
  if (s <= b.a + 1 / fps - EPS || s >= b.b - 1 / fps + EPS) return doc;
  const splits = [...(doc.splits || []), +s.toFixed(3)].sort((a, c) => a - c);
  return { ...doc, splits: [...new Set(splits)] };
}

/** Remove a block from the clip: its footage becomes a cut. Splits inside it are dropped. */
export function deleteBlock(doc: Doc, b: Block): Doc {
  const cuts = normalizeCuts([...doc.cuts, { start: b.a, end: b.b, source: 'manual' }], doc.range);
  // A split on either edge of the deleted piece now sits on a cut boundary and means nothing.
  const splits = (doc.splits || []).filter((s) => s < b.a - EPS || s > b.b + EPS);
  return { ...doc, cuts, splits };
}

/** Remove several blocks at once (a marquee selection). Never removes the last one. */
export function deleteBlocks(doc: Doc, keys: string[], fps: number): Doc {
  let d = doc;
  for (const key of keys) {
    const bl = blocks(d, fps);
    if (bl.length <= 1) break;
    const b = bl.find((x) => x.key === key);
    if (b) d = deleteBlock(d, b);
  }
  return d;
}

/**
 * Cut the footage under these words (the transcript's ⌫). Abutting words merge into one cut,
 * and a pause that touches the run goes with it — otherwise deleting a word leaves its
 * breath behind as dead air. Air is kept at the join (80 ms after the previous word, 120 ms
 * before the next) so speech never butts against speech.
 */
export function cutWords(doc: Doc, words: Array<{ start: number; end: number }>, pauses: Pause[] = []): Doc {
  if (!words.length) return doc;
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const runs: Array<{ start: number; end: number }> = [];
  for (const w of sorted) {
    const last = runs[runs.length - 1];
    if (last && w.start - last.end <= 0.05) last.end = Math.max(last.end, w.end);
    else runs.push({ start: w.start, end: w.end });
  }
  const added: Cut[] = runs.map((r) => {
    let start = r.start - 0.02;
    let end = r.end + 0.02;
    const before = pauses.find((p) => p.start < r.start && p.end >= r.start - 0.25 && p.end <= r.start + 0.05);
    if (before) start = Math.min(start, before.start + 0.08);
    const after = pauses.find((p) => p.end > r.end && p.start >= r.end - 0.05 && p.start <= r.end + 0.25);
    if (after) end = Math.max(end, after.end - 0.12);
    return { start, end, source: 'manual' };
  });
  return { ...doc, cuts: normalizeCuts([...doc.cuts, ...added], doc.range) };
}

/** Hide (or show) these words' captions; the audio is untouched. */
export function hideWords(doc: Doc, is: number[], hidden = true): Doc {
  const words = { ...doc.words };
  for (const i of is) words[String(i)] = { ...(doc.words[String(i)] || {}), hidden };
  return { ...doc, words };
}

/** Bring a removed piece back. */
export function restoreCut(doc: Doc, cut: Cut): Doc {
  return { ...doc, cuts: doc.cuts.filter((c) => !(Math.abs(c.start - cut.start) < EPS && Math.abs(c.end - cut.end) < EPS)) };
}

/**
 * Drag a block's START edge to a new source time.
 *  - at the range start: the clip begins earlier/later (bounded by the preview window)
 *  - at a cut: the cut shrinks or grows (it never vanishes — restoring is explicit)
 *  - at a split: dragging right opens a gap, i.e. the split becomes a cut
 */
export function trimBlockStart(doc: Doc, b: Block, newSrc: number, limits: { windowStart: number; fps: number }): Doc {
  const maxStart = b.b - MIN_BLOCK_S;
  if (b.startsAt === 'range') {
    const s = Math.min(maxStart, Math.max(limits.windowStart, newSrc));
    return { ...doc, range: { ...doc.range, start: +snap(s, limits.fps).toFixed(3) }, cuts: normalizeCuts(doc.cuts, { start: s, end: doc.range.end }) };
  }
  if (b.startsAt === 'cut') {
    const cut = doc.cuts.find((c) => Math.abs(c.end - b.a) < 1 / limits.fps);
    if (!cut) return doc;
    const s = Math.min(maxStart, Math.max(cut.start + 1 / limits.fps, newSrc));
    const cuts = doc.cuts.map((c) => (c === cut ? { ...c, end: +snap(s, limits.fps).toFixed(3) } : c));
    return { ...doc, cuts: normalizeCuts(cuts, doc.range) };
  }
  // split → gap
  const s = Math.min(maxStart, Math.max(b.a, newSrc));
  if (s <= b.a + EPS) return doc;
  const splits = (doc.splits || []).filter((x) => Math.abs(x - b.a) > EPS);
  return { ...doc, splits, cuts: normalizeCuts([...doc.cuts, { start: b.a, end: +snap(s, limits.fps).toFixed(3), source: 'manual' }], doc.range) };
}

/** Drag a block's END edge — the mirror of trimBlockStart. */
export function trimBlockEnd(doc: Doc, b: Block, newSrc: number, limits: { windowEnd: number; fps: number }): Doc {
  const minEnd = b.a + MIN_BLOCK_S;
  if (b.endsAt === 'range') {
    const e = Math.max(minEnd, Math.min(limits.windowEnd, newSrc));
    return { ...doc, range: { ...doc.range, end: +snap(e, limits.fps).toFixed(3) }, cuts: normalizeCuts(doc.cuts, { start: doc.range.start, end: e }) };
  }
  if (b.endsAt === 'cut') {
    const cut = doc.cuts.find((c) => Math.abs(c.start - b.b) < 1 / limits.fps);
    if (!cut) return doc;
    const e = Math.max(minEnd, Math.min(cut.end - 1 / limits.fps, newSrc));
    const cuts = doc.cuts.map((c) => (c === cut ? { ...c, start: +snap(e, limits.fps).toFixed(3) } : c));
    return { ...doc, cuts: normalizeCuts(cuts, doc.range) };
  }
  const e = Math.max(minEnd, Math.min(b.b, newSrc));
  if (e >= b.b - EPS) return doc;
  const splits = (doc.splits || []).filter((x) => Math.abs(x - b.b) > EPS);
  return { ...doc, splits, cuts: normalizeCuts([...doc.cuts, { start: +snap(e, limits.fps).toFixed(3), end: b.b, source: 'manual' }], doc.range) };
}

/**
 * Words on the track.
 *
 * Whisper tiles the transcript: a word's end IS the next word's start, so the boundary
 * between two words is shared — dragging it moves when the next caption appears (the thing
 * that reads wrong when a caption runs ahead of the voice). Words separated by a real pause
 * keep their own edges. Every function takes the gesture's ORIGINAL positions and returns a
 * fresh document, so a drag is idempotent from any pointer position.
 */
export type WordRef = { i: number; start: number; end: number };
const MIN_WORD_S = 0.04;
const ABUT_S = 0.02;
const r3 = (x: number) => +x.toFixed(3);
const abuts = (a: WordRef | null, b: WordRef | null) => !!a && !!b && Math.abs(a.end - b.start) <= ABUT_S;

/** Shift a whole word by `dt` seconds; neighbours that abut follow so no gap or overlap opens. */
export function moveWord(doc: Doc, w: WordRef, dt: number, prev: WordRef | null, next: WordRef | null): Doc {
  const prevAbuts = abuts(prev, w);
  const nextAbuts = abuts(w, next);
  const lo = prev ? (prevAbuts ? prev.start + MIN_WORD_S : prev.end) : w.start - 5;
  const hi = next ? (nextAbuts ? next.end - MIN_WORD_S : next.start) : w.end + 5;
  const shift = Math.max(lo - w.start, Math.min(hi - w.end, dt));
  const s = r3(w.start + shift);
  const e = r3(w.end + shift);
  const words: Doc['words'] = { ...doc.words, [w.i]: { ...(doc.words[String(w.i)] || {}), start: s, end: e } };
  if (prevAbuts && prev) words[String(prev.i)] = { ...(doc.words[String(prev.i)] || {}), end: s };
  if (nextAbuts && next) words[String(next.i)] = { ...(doc.words[String(next.i)] || {}), start: e };
  return { ...doc, words };
}

/** Drag one edge of a word to source time `t`; an abutting neighbour's edge moves with it. */
export function moveWordEdge(doc: Doc, w: WordRef, edge: 'start' | 'end', t: number, prev: WordRef | null, next: WordRef | null): Doc {
  const words: Doc['words'] = { ...doc.words };
  const cur = doc.words[String(w.i)] || {};
  if (edge === 'start') {
    const shared = abuts(prev, w);
    const lo = prev ? (shared ? prev.start + MIN_WORD_S : prev.end) : w.start - 5;
    const s = r3(Math.max(lo, Math.min(w.end - MIN_WORD_S, t)));
    words[String(w.i)] = { ...cur, start: s };
    if (shared && prev) words[String(prev.i)] = { ...(doc.words[String(prev.i)] || {}), end: s };
  } else {
    const shared = abuts(w, next);
    const hi = next ? (shared ? next.end - MIN_WORD_S : next.start) : w.end + 5;
    const e = r3(Math.min(hi, Math.max(w.start + MIN_WORD_S, t)));
    words[String(w.i)] = { ...cur, end: e };
    if (shared && next) words[String(next.i)] = { ...(doc.words[String(next.i)] || {}), start: e };
  }
  return { ...doc, words };
}

/** Move a word's start (and optionally end) in source time, bounded by its neighbours. */
export function setWordTiming(
  doc: Doc, wordIdx: number, patch: { start?: number; end?: number },
  bounds: { prevEnd: number; nextStart: number; origStart: number; origEnd: number },
): Doc {
  const cur = doc.words[String(wordIdx)] || {};
  const start = patch.start ?? cur.start ?? bounds.origStart;
  const end = patch.end ?? cur.end ?? bounds.origEnd;
  const s = Math.max(bounds.prevEnd, Math.min(end - 0.04, start));
  const e = Math.min(bounds.nextStart, Math.max(s + 0.04, end));
  const words = { ...doc.words, [wordIdx]: { ...cur, start: +s.toFixed(3), end: +e.toFixed(3) } };
  return { ...doc, words };
}

/** Candidate snap targets in edited time: block edges and word starts. */
export function snapTo(t: number, targets: number[], tolerance: number): number {
  let best = t;
  let d = tolerance;
  for (const x of targets) { const dd = Math.abs(x - t); if (dd < d) { d = dd; best = x; } }
  return best;
}
