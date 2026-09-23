// Run with: node apps/web/app/clips/[id]/timelineModel.test.ts   (Node 24 strips the types)
import assert from 'node:assert/strict';
import {
  blocks, duration, splitAt, deleteBlock, trimBlockStart, trimBlockEnd, restoreCut,
  outToSrc, srcToOut, setWordTiming, normalizeCuts, moveWord, moveWordEdge, deleteBlocks, cutWords, hideWords,
} from './timelineModel.ts';
import type { Doc } from './types.ts';

const FPS = 30;
const base = (): Doc => ({
  v: 1,
  range: { start: 100, end: 130 },
  cuts: [{ start: 110, end: 112, source: 'silence' }],
  splits: [],
  format: { variant: 'band-title-top' },
  title: { text: '', font: 'x', size: 66, color: '#111111', box: true, boxColor: '#FFFFFF', outline: false, outlineColor: '#000000', hold: null, x: null, y: null },
  captions: { enabled: true, mode: 'word', font: 'x', size: 84, color: '#FFFFFF', highlightColor: '#FFE500', case: 'as-spoken', x: null, y: null },
  words: {},
});

let pass = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n      ${(e as Error).message}`); process.exitCode = 1; } };

t('blocks are kept spans in edited time, end to end', () => {
  const bl = blocks(base(), FPS);
  assert.equal(bl.length, 2);
  assert.deepEqual([bl[0].a, bl[0].b, bl[1].a, bl[1].b], [100, 110, 112, 130]);
  assert.equal(bl[0].outStart, 0);
  assert.ok(Math.abs(bl[1].outStart - 10) < 1e-9, 'the second block starts where the first ends — no gap');
  assert.ok(Math.abs(duration(bl) - 28) < 1e-9);
  assert.deepEqual([bl[0].startsAt, bl[0].endsAt, bl[1].startsAt, bl[1].endsAt], ['range', 'cut', 'cut', 'range']);
});

t('time maps both ways across a cut', () => {
  const bl = blocks(base(), FPS);
  assert.ok(Math.abs(outToSrc(15, bl) - 117) < 1e-9);
  assert.ok(Math.abs((srcToOut(117, bl) as number) - 15) < 1e-9);
  assert.equal(srcToOut(111, bl), null, 'inside the cut has no edited time');
});

t('split divides a block without changing what renders', () => {
  const d = splitAt(base(), 5, FPS);
  const bl = blocks(d, FPS);
  assert.equal(bl.length, 3);
  assert.ok(Math.abs(duration(bl) - 28) < 1e-9, 'duration unchanged');
  assert.equal(bl[0].endsAt, 'split');
  assert.equal(splitAt(d, 5.01, FPS), d, 'splitting on an existing edge is a no-op');
});

t('deleting a block becomes a cut and merges with its neighbour', () => {
  const d0 = splitAt(base(), 5, FPS);
  const d = deleteBlock(d0, blocks(d0, FPS)[1]);   // 105..110, adjacent to the 110..112 cut
  assert.equal(d.cuts.length, 1, 'adjacent cuts merge');
  assert.deepEqual([d.cuts[0].start, d.cuts[0].end], [105, 112]);
  assert.equal(d.splits.length, 0, 'the split inside the deleted piece is gone');
  assert.ok(Math.abs(duration(blocks(d, FPS)) - 23) < 1e-9);
});

t('trimming the first block start moves the clip range, bounded by the window', () => {
  const b = blocks(base(), FPS)[0];
  const d = trimBlockStart(base(), b, 95, { windowStart: 90, fps: FPS });
  assert.equal(d.range.start, 95);
  const d2 = trimBlockStart(base(), b, 80, { windowStart: 90, fps: FPS });
  assert.equal(d2.range.start, 90, 'cannot leave the preview footage');
});

t('trimming an edge at a cut resizes the cut but never removes it', () => {
  const b = blocks(base(), FPS)[1];              // starts at the cut's end (112)
  const d = trimBlockStart(base(), b, 111, { windowStart: 90, fps: FPS });
  assert.deepEqual([d.cuts[0].start, d.cuts[0].end], [110, 111]);
  const d2 = trimBlockStart(base(), b, 100, { windowStart: 90, fps: FPS });
  assert.ok(d2.cuts[0].end > 110, 'the cut keeps at least one frame — restore is explicit');
  const e = trimBlockEnd(base(), blocks(base(), FPS)[0], 109, { windowEnd: 140, fps: FPS });
  assert.deepEqual([e.cuts[0].start, e.cuts[0].end], [109, 112]);
});

t('trimming at a split opens a gap (the split becomes a cut)', () => {
  const d0 = splitAt(base(), 5, FPS);
  const b = blocks(d0, FPS)[1];                   // 105..110, starts at the split
  const d = trimBlockStart(d0, b, 106, { windowStart: 90, fps: FPS });
  assert.equal(d.splits.length, 0);
  assert.ok(d.cuts.some((c) => Math.abs(c.start - 105) < 1e-6 && Math.abs(c.end - 106) < 1e-6));
});

t('restoring a cut removes exactly that cut', () => {
  const d = restoreCut(base(), base().cuts[0]);
  assert.equal(d.cuts.length, 0);
  assert.ok(Math.abs(duration(blocks(d, FPS)) - 30) < 1e-9);
});

t('word timing is bounded by its neighbours and keeps a minimum length', () => {
  const d = setWordTiming(base(), 7, { start: 100.9 }, { prevEnd: 101.0, nextStart: 102.0, origStart: 101.2, origEnd: 101.6 });
  assert.equal(d.words['7'].start, 101.0, 'cannot start before the previous word ends');
  const d2 = setWordTiming(base(), 7, { end: 100.5 }, { prevEnd: 101.0, nextStart: 102.0, origStart: 101.2, origEnd: 101.6 });
  assert.ok(d2.words['7'].end > d2.words['7'].start, 'end stays after start');
});

t('moving a word between abutting neighbours keeps its length and drags the shared boundaries', () => {
  const prev = { i: 1, start: 100.0, end: 100.3 };
  const w = { i: 2, start: 100.3, end: 100.8 };
  const next = { i: 3, start: 100.8, end: 101.0 };
  const d = moveWord(base(), w, 0.5, prev, next);
  // The next word must keep 40 ms, so the shift stops at 0.16.
  assert.deepEqual([d.words['2'].start, d.words['2'].end], [100.46, 100.96]);
  assert.equal(d.words['1'].end, 100.46, 'the previous word ends where this one now starts');
  assert.equal(d.words['3'].start, 100.96, 'the next word starts where this one now ends');
  const back = moveWord(base(), w, -0.4, prev, next);
  assert.deepEqual([back.words['2'].start, back.words['2'].end], [100.04, 100.54]);
  assert.equal(back.words['1'].end, 100.04);
});

t('a word after a real pause moves alone and stops at the pause edges', () => {
  const prev = { i: 1, start: 100.0, end: 100.2 };
  const w = { i: 2, start: 100.5, end: 100.8 };
  const d = moveWord(base(), w, -1, prev, null);
  assert.deepEqual([d.words['2'].start, d.words['2'].end], [100.2, 100.5]);
  assert.equal(d.words['1'], undefined, 'the previous word is untouched');
});

t('dragging a shared boundary moves both words; the edge cannot cross either word', () => {
  const w = { i: 2, start: 100.3, end: 100.8 };
  const next = { i: 3, start: 100.8, end: 101.0 };
  const d = moveWordEdge(base(), w, 'end', 100.6, null, next);
  assert.equal(d.words['2'].end, 100.6);
  assert.equal(d.words['3'].start, 100.6);
  const far = moveWordEdge(base(), w, 'end', 105, null, next);
  assert.equal(far.words['2'].end, 100.96, 'the next word keeps its 40 ms');
  const start = moveWordEdge(base(), w, 'start', 100.79, null, null);
  assert.equal(start.words['2'].start, 100.76, 'a word keeps 40 ms of its own');
});

t('a cut appended out of order still divides the timeline (the transcript appends, never sorts)', () => {
  const d = { ...base(), cuts: [{ start: 110, end: 112, source: 'silence' }, { start: 120, end: 122, source: 'silence' }] };
  const before = blocks(d, FPS).length;
  const after = blocks({ ...d, cuts: [...d.cuts, { start: 115, end: 116, source: 'manual' }] }, FPS).length;
  assert.equal(after, before + 1, 'the unsorted cut must split a block right away');
});

t('deleteBlocks removes several clips and never the last one', () => {
  const d = { ...base(), splits: [103, 106] };
  const bl = blocks(d, FPS);
  assert.equal(bl.length, 4);
  const d2 = deleteBlocks(d, [bl[0].key, bl[1].key], FPS);
  assert.equal(blocks(d2, FPS).length, 2);
  const all = deleteBlocks(d, bl.map((b) => b.key), FPS);
  assert.equal(blocks(all, FPS).length, 1, 'one clip always survives');
});

t('cutWords merges abutting words into one cut; hideWords only flags captions', () => {
  const d = cutWords(base(), [{ start: 101.0, end: 101.3 }, { start: 101.3, end: 101.6 }]);
  const manual = d.cuts.filter((c) => c.source === 'manual');
  assert.equal(manual.length, 1);
  assert.deepEqual([manual[0].start, manual[0].end], [100.98, 101.62]);
  const h = hideWords(base(), [4, 5]);
  assert.deepEqual([h.words['4'].hidden, h.words['5'].hidden, h.cuts.length], [true, true, 1]);
});

t('cutting a word eats the pause next to it, leaving air at the join', () => {
  const d = cutWords(base(), [{ start: 103.0, end: 103.3 }], [{ start: 102.0, end: 102.95, seconds: 0.95 }, { start: 103.32, end: 104.5, seconds: 1.18 }]);
  const m = d.cuts.filter((c) => c.source === 'manual');
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].start, m[0].end], [102.08, 104.38]);
});

t('normalizeCuts merges overlaps and drops slivers', () => {
  const cuts = normalizeCuts([{ start: 5, end: 6, source: 'a' }, { start: 5.5, end: 7, source: 'b' }, { start: 8, end: 8.001, source: 'c' }], { start: 0, end: 10 });
  assert.equal(cuts.length, 1);
  assert.deepEqual([cuts[0].start, cuts[0].end, cuts[0].source], [5, 7, 'mixed']);
});

console.log(`\n${pass} passed${process.exitCode ? ' · FAILURES above' : ''}`);
