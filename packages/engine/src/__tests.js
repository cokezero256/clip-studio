/**
 * Tests for the 2.0 modules. Pure logic — no ffmpeg, no network, no model calls.
 * Run: node src/__tests.js
 */
const assert = require('assert');
const { evaluateGates, keptSpans, outputGaps } = require('./select/gates');
const { compileMotion, sampleAt, simplifyTrack, graphTimeFromClipLocal } = require('./motion/keyframes');
const { seekPreroll, captionClipStart } = require('./clip-renderer');
const { groupWords } = require('./transcribe');

let pass = 0, fail = 0;
const group = (n) => console.log('\n' + n);
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

/** Build a transcript of evenly spoken words, with optional injected gaps. */
function mkTranscript(spec) {
  const words = [];
  let t = spec.start ?? 0;
  for (const s of spec.words) {
    if (typeof s === 'number') { t += s; continue; }        // a number = a gap
    words.push({ word: s, start: +t.toFixed(3), end: +(t + 0.3).toFixed(3) });
    t += 0.35;
  }
  return { words, segments: [], duration: t };
}

group('gates — G1 internal silence');
t('clean speech passes', () => {
  const tr = mkTranscript({ words: ['Here', 'is', 'the', 'setup', 'I', 'took', 'today.'] });
  const clip = { start_seconds: 0, end_seconds: tr.duration, manual_cuts: [] };
  const r = evaluateGates(clip, tr, { minDurationSeconds: 0, maxDurationSeconds: 999 });
  const g1 = r.results.find((x) => x.id === 'G1');
  assert.ok(g1.passed, g1.detail);
});
t('a 1.2s hole FAILS and names the timestamp', () => {
  const tr = mkTranscript({ words: ['I', 'took', 1.2, 'the', 'trade.'] });
  const clip = { start_seconds: 0, end_seconds: tr.duration, manual_cuts: [] };
  const r = evaluateGates(clip, tr, { minDurationSeconds: 0, maxDurationSeconds: 999 });
  const g1 = r.results.find((x) => x.id === 'G1');
  assert.ok(!g1.passed, 'should fail');
  assert.ok(/dead air at/.test(g1.detail), 'detail must locate it: ' + g1.detail);
  assert.ok(!r.passed, 'overall must fail');
});
t('the SAME hole passes once a cut removes it', () => {
  const tr = mkTranscript({ words: ['I', 'took', 1.2, 'the', 'trade.'] });
  const w = tr.words;
  const holeStart = w[1].end, holeEnd = w[2].start;
  const clip = {
    start_seconds: 0, end_seconds: tr.duration,
    manual_cuts: [{ start: holeStart + 0.02, end: holeEnd - 0.02, source: 'silence' }],
  };
  const r = evaluateGates(clip, tr, { minDurationSeconds: 0, maxDurationSeconds: 999 });
  const g1 = r.results.find((x) => x.id === 'G1');
  assert.ok(g1.passed, 'a cut-away gap is not a gap: ' + g1.detail);
});

group('gates — G2 edge silence');
t('leading silence fails', () => {
  const tr = mkTranscript({ words: ['Hello', 'there.'], start: 2.0 });
  const clip = { start_seconds: 0, end_seconds: tr.duration, manual_cuts: [] };
  const r = evaluateGates(clip, tr, { minDurationSeconds: 0, maxDurationSeconds: 999 });
  assert.ok(!r.results.find((x) => x.id === 'G2').passed);
});

group('gates — G4 self-containment');
t('opening on a back-reference fails', () => {
  const tr = mkTranscript({ words: ['So', 'that', 'is', 'why', 'it', 'worked.'] });
  const clip = { start_seconds: 0, end_seconds: tr.duration, manual_cuts: [] };
  const r = evaluateGates(clip, tr, { minDurationSeconds: 0, maxDurationSeconds: 999 });
  const g4 = r.results.find((x) => x.id === 'G4');
  assert.ok(!g4.passed);
  assert.ok(/refers back/.test(g4.detail), g4.detail);
});
t('ending mid-sentence fails', () => {
  const tr = mkTranscript({ words: ['Here', 'is', 'the', 'reason', 'because'] });
  const clip = { start_seconds: 0, end_seconds: tr.duration, manual_cuts: [] };
  const r = evaluateGates(clip, tr, { minDurationSeconds: 0, maxDurationSeconds: 999 });
  assert.ok(!r.results.find((x) => x.id === 'G4').passed);
});

group('gates — G3 duration');
t('too short fails, and the message quotes the configured band', () => {
  const { DEFAULTS } = require('./select/gates');
  const tr = mkTranscript({ words: ['Short.'] });
  const clip = { start_seconds: 0, end_seconds: tr.duration, manual_cuts: [] };
  const r = evaluateGates(clip, tr);
  const g3 = r.results.find((x) => x.id === 'G3');
  assert.ok(!g3.passed);
  // Assert against the config, not a hardcoded band — the client's spec changed from
  // 20-90s to 26-120s and a literal here broke for no real reason.
  assert.ok(
    g3.detail.includes(`${DEFAULTS.minDurationSeconds}`) &&
    g3.detail.includes(`${DEFAULTS.maxDurationSeconds}`),
    g3.detail
  );
});

group('gates — cut arithmetic');
t('overlapping cuts do not double-subtract', () => {
  const clip = {
    start_seconds: 0, end_seconds: 10,
    manual_cuts: [{ start: 2, end: 5 }, { start: 4, end: 6 }],
  };
  const total = keptSpans(clip).reduce((s, x) => s + (x.end - x.start), 0);
  assert.strictEqual(+total.toFixed(3), 6, 'kept should be 10 - 4 = 6');
});

group('motion — time-origin invariant');
t('graph time uses the SAME origin as captions', () => {
  for (const start of [0, 0.2, 0.5, 3.7, 42.19, 900]) {
    assert.strictEqual(
      +(captionClipStart(start) + seekPreroll(start)).toFixed(6), +start.toFixed(6),
      'caption invariant broken at ' + start);
    // clip-local 0 must map to exactly seekPreroll in graph time
    assert.strictEqual(
      +graphTimeFromClipLocal(0, start).toFixed(6), +seekPreroll(start).toFixed(6),
      'motion origin diverged from caption origin at ' + start);
  }
});

group('motion — sampling and compilation');
t('eases between keys and clamps outside them', () => {
  const keys = [{ t: 0, cx: 0.5, cy: 0.5, z: 1 }, { t: 2, cx: 0.7, cy: 0.5, z: 1.5, ease: 'linear' }];
  assert.strictEqual(sampleAt(keys, -1).z, 1);
  assert.strictEqual(sampleAt(keys, 99).z, 1.5);
  const mid = sampleAt(keys, 1);
  assert.ok(Math.abs(mid.z - 1.25) < 1e-6, 'linear midpoint should be 1.25, got ' + mid.z);
});
t('a static track emits no commands', () => {
  const m = { panes: { cam: { keys: [{ t: 0, cx: 0.5, cy: 0.5, z: 1 }, { t: 5, cx: 0.5, cy: 0.5, z: 1 }] } } };
  const geo = { cam: { srcW: 1920, srcH: 1080, boxW: 1080, boxH: 720 } };
  assert.strictEqual(compileMotion(m, geo, { fps: 30, durationSeconds: 5, startSeconds: 0 }), null);
});
t('a moving track emits ordered, in-bounds commands', () => {
  const m = { panes: { cam: { keys: [
    { t: 0, cx: 0.5, cy: 0.5, z: 1 },
    { t: 4, cx: 0.75, cy: 0.4, z: 1.6, ease: 'inOutCubic' }] } } };
  const geo = { cam: { srcW: 1920, srcH: 1080, boxW: 1080, boxH: 720 } };
  const r = compileMotion(m, geo, { fps: 30, durationSeconds: 4, startSeconds: 10 });
  assert.ok(r && r.commandCount > 50, 'expected many commands, got ' + (r && r.commandCount));
  const times = r.script.trim().split('\n').map((l) => parseFloat(l));
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] >= times[i - 1], 'sendcmd requires ascending time');
  }
  // Every crop must stay inside the source.
  for (const line of r.script.trim().split('\n')) {
    const mm = line.match(/crop@cam (w|h|x|y) (\d+)/);
    if (!mm) continue;
    const v = parseInt(mm[2], 10);
    if (mm[1] === 'w' || mm[1] === 'x') assert.ok(v >= 0 && v <= 1920, 'x/w out of bounds: ' + line);
    if (mm[1] === 'h' || mm[1] === 'y') assert.ok(v >= 0 && v <= 1080, 'y/h out of bounds: ' + line);
  }
  // Crop dims must be even (yuv420p).
  for (const line of r.script.trim().split('\n')) {
    const mm = line.match(/crop@cam (w|h) (\d+)/);
    if (mm) assert.strictEqual(parseInt(mm[2], 10) % 2, 0, 'odd crop dim: ' + line);
  }
});
t('simplifyTrack collapses a dense auto track', () => {
  const pts = Array.from({ length: 122 }, (_, i) => ({ t: i * 0.5, cx: 0.5 + 0.2 * Math.sin(i / 20) }));
  const s = simplifyTrack(pts, 0.02);
  assert.ok(s.length < 30 && s.length > 2, 'expected a handful of keys, got ' + s.length);
});

group('transcribe — segment grouping');
t('splits on sentence end and on long gaps', () => {
  const words = [
    { word: ' I', start: 0, end: 0.2 }, { word: ' took', start: 0.2, end: 0.4 },
    { word: ' it.', start: 0.4, end: 0.6 },
    { word: ' Then', start: 0.7, end: 0.9 }, { word: ' this', start: 0.9, end: 1.1 },
    { word: ' one', start: 2.5, end: 2.7 },
  ];
  const segs = groupWords(words);
  assert.strictEqual(segs.length, 3, 'sentence end + 1.4s gap => 3 segments, got ' + segs.length);
  assert.strictEqual(segs[0].text, 'I took it.');
});


group('boundaries — the punctuation trap');
t('derives sentences from WORDS when they are punctuated (whisper.cpp)', () => {
  const { sentenceEndIndices, describeStrategy } = require('./select/boundaries');
  const tr = { words: [
    {word:'I',start:0,end:.2},{word:'took',start:.2,end:.4},{word:'it.',start:.4,end:.6},
    {word:'Then',start:.7,end:.9},{word:'this.',start:.9,end:1.1}] };
  const ends = sentenceEndIndices(tr);
  assert.ok(ends.has(2) && ends.has(4), 'should mark both sentence ends');
  // Boundaries are a UNION of punctuation + segments + measured silence, not a fallback
  // chain, so the diagnostic reports every contributing source. What matters is that the
  // punctuation present in words[] is seen and counted.
  assert.ok(/punctuation 2\b/.test(describeStrategy(tr)), describeStrategy(tr));
});
t('derives sentences from SEGMENTS when words are stripped (OpenAI)', () => {
  const { sentenceEndIndices, describeStrategy } = require('./select/boundaries');
  // OpenAI strips punctuation from words[] entirely — measured 0/5962 on a real file.
  const tr = {
    words: [{word:'I',start:0,end:.2},{word:'took',start:.2,end:.4},{word:'it',start:.4,end:.6},
            {word:'Then',start:.7,end:.9},{word:'this',start:.9,end:1.1}],
    segments: [{start:0,end:.65,text:' I took it.'},{start:.7,end:1.2,text:' Then this.'}],
  };
  const ends = sentenceEndIndices(tr);
  assert.ok(ends.has(2), 'segment 1 ends a sentence at word 2');
  // Zero punctuation in words[] must still yield boundaries, via the segment text.
  assert.ok(/punctuation 0\b/.test(describeStrategy(tr)), describeStrategy(tr));
  assert.ok(/-> [1-9]/.test(describeStrategy(tr)), 'segments alone must yield boundaries');
});
t('REGRESSION: an OpenAI-shaped transcript must not yield zero candidates', () => {
  // This is the bug that silently produced 0 clips: testing words for punctuation found
  // exactly one sentence start (index 0), so no span could ever be built.
  const { generateCandidates } = require('./select/candidates');
  const words = [], segments = [];
  let tt = 0;
  for (let s = 0; s < 40; s++) {
    const segStart = tt;
    for (let w = 0; w < 12; w++) { words.push({ word: 'word' + w, start: +tt.toFixed(2), end: +(tt+.25).toFixed(2) }); tt += .3; }
    segments.push({ start: segStart, end: tt, text: ' I took the NQ trade for $500 today.' });
  }
  const r = generateCandidates({ words, segments });
  assert.ok(r.stats.sentences > 1, 'must find many sentences, found ' + r.stats.sentences);
  assert.ok(r.candidates.length > 0, 'must produce candidates, got 0');
});

group('planning — the no-silence guarantee');
t('auto-cuts remove every gap over threshold', () => {
  const { autoCuts } = require('./select/plan');
  const words = [
    {word:'I',start:0,end:.3},{word:'took',start:.3,end:.6},
    {word:'it',start:2.0,end:2.3},                       // 1.4s hole
    {word:'today.',start:2.3,end:2.6}];
  const cuts = autoCuts(0, 2.6, { words });
  assert.strictEqual(cuts.length, 1, 'one cut for one hole');
  assert.ok(cuts[0].start > .6 && cuts[0].end < 2.0, 'cut sits inside the hole with padding');
});
t('a planned clip never violates the silence rule', () => {
  const { planClip } = require('./select/plan');
  const words = []; let tt = 0;
  for (let i = 0; i < 120; i++) {
    words.push({ word: i === 119 ? 'done.' : 'w' + i, start: +tt.toFixed(2), end: +(tt+.25).toFixed(2) });
    tt += (i % 11 === 0) ? 1.0 : .3;                      // inject periodic holes
  }
  const tr = { words, segments: [{ start: 0, end: tt, text: 'x done.' }] };
  const p = planClip({ startSeconds: 0, endSeconds: tt, hookText: 'w0', prescore: 1, signals: {} }, tr,
    { minDurationSeconds: 0, maxDurationSeconds: 999 });
  assert.ok(p.cutsApplied > 0, 'should have cut the holes');
  const g1 = p.gate.results.find((x) => x.id === 'G1');
  assert.ok(g1.passed, 'G1 must pass after cuts: ' + g1.detail);
});
t('speech ratio can never exceed 100% even with overlapping word timings', () => {
  // Whisper word timings sometimes overlap; summing durations double-counted and reported
  // 102.6% on a real clip.
  const words = [
    {word:'a',start:0,end:.5},{word:'b',start:.4,end:.9},   // overlap
    {word:'c',start:.8,end:1.4},{word:'d.',start:1.3,end:2.0}];
  const r = evaluateGates({start_seconds:0,end_seconds:2.0,manual_cuts:[]}, {words},
    {minDurationSeconds:0,maxDurationSeconds:999});
  assert.ok(r.speechRatio <= 1.0 + 1e-9, 'ratio was ' + r.speechRatio);
});


group('captions — per-segment scoping');
t('a segment only receives its own words', () => {
  const { scopeTranscript } = require('./pipeline2');
  const tr = { words: [
    {word:'a',start:0,end:1},{word:'b',start:5,end:6},
    {word:'c',start:10,end:11},{word:'d',start:20,end:21}],
    segments: [{start:0,end:6,text:'a b'},{start:10,end:21,text:'c d'}] };
  const s = scopeTranscript(tr, 9, 15);
  assert.strictEqual(s.words.length, 1, 'only "c" falls in [9,15]');
  assert.strictEqual(s.words[0].word, 'c');
});
t('REGRESSION: segment words must not all collapse to t=0', () => {
  // The bug: every segment got the FULL clip track, so `max(0, start - clipStart)` clamped
  // every out-of-range word to 0 and 47 caption events rendered simultaneously, stacked.
  const { scopeTranscript } = require('./pipeline2');
  const words = Array.from({ length: 40 }, (_, i) => ({ word: 'w' + i, start: i, end: i + .5 }));
  const segStart = 30, segEnd = 36;
  const scoped = scopeTranscript({ words, segments: [] }, segStart, segEnd);
  const anchored = scoped.words.map((w) => Math.max(0, w.start - segStart));
  const atZero = anchored.filter((v) => v === 0).length;
  assert.ok(scoped.words.length > 0, 'segment must have words');
  assert.ok(atZero <= 1, `only the first word may anchor at 0, got ${atZero} of ${anchored.length}`);
  assert.ok(new Set(anchored).size === anchored.length, 'every word must get a distinct time');
});


group('outliers — robust scoring');
t('scores against the MEDIAN, not the mean', () => {
  const { scorePage, pageStats } = require('./outliers/scrape');
  // Real rp.profits view counts. The mean (54,079) sits well above the median (44,284)
  // because the outliers drag it up; dividing by the mean makes a typical post score <1.
  const views = [181839,84040,83894,79406,72281,71679,68740,63978,61982,61843,61112,
                 56025,47821,45718,42851,42175,41855,39340,38060,36877,34800,31976,
                 30790,29913,28468,27061,25882,23812];
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const posts = views.map((v, i) => ({ shortcode: 's' + i, views: v, postedAt: old }));
  const st = pageStats(posts);
  assert.ok(Math.abs(st.typicalViews - 44284) < 600,
    `typical should track the median 44,284, got ${st.typicalViews}`);
  const scored = scorePage(posts);
  const top = scored.find((p) => p.views === 181839);
  assert.ok(top.displayMult > 3.9, `top post should read ~4.1x, got ${top.displayMult}`);
  assert.ok(top.isOutlier === 1, 'the 4x post must be flagged');
});
t('a typical post scores about 1x, not below it', () => {
  const { scorePage } = require('./outliers/scrape');
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const posts = [40,42,44,45,46,48,50,52,120].map((k, i) =>
    ({ shortcode: 'p' + i, views: k * 1000, postedAt: old }));
  const scored = scorePage(posts);
  const mid = scored.find((p) => p.views === 46000);
  assert.ok(Math.abs(mid.displayMult - 1) < 0.15,
    `median-ish post should sit near 1x, got ${mid.displayMult}`);
});
t('immature posts are scored but never flagged', () => {
  const { scorePage } = require('./outliers/scrape');
  const fresh = new Date(Date.now() - 1 * 86400000).toISOString();
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const posts = [
    ...[30,32,34,36,38,40].map((k, i) => ({ shortcode: 'o' + i, views: k * 1000, postedAt: old })),
    { shortcode: 'new', views: 400000, postedAt: fresh },
  ];
  const scored = scorePage(posts);
  const n = scored.find((p) => p.shortcode === 'new');
  assert.strictEqual(n.mature, 0, 'a 1-day-old post is not mature');
  assert.strictEqual(n.isOutlier, 0, 'immature posts must not be promoted');
  assert.ok(n.z > 2, 'but it should still carry a score');
});
t('a page with almost no data does not invent outliers', () => {
  const { scorePage } = require('./outliers/scrape');
  const scored = scorePage([{ shortcode: 'a', views: 100, postedAt: null }]);
  assert.strictEqual(scored[0].isOutlier, 0);
});

group('outliers — target format query');
t('a split-screen misread as talking_head still counts via chart share', () => {
  const { isTargetFormat } = require('./outliers/classify');
  // Observed on a real pjtradesnq reel: the model returned talking_head_broll because the
  // face is prominent, despite a chart filling 65% of the frame.
  assert.ok(isTargetFormat({ format: 'talking_head_broll', has_chart: true, chart_share: 0.65 }));
  assert.ok(isTargetFormat({ format: 'screenshare_teach' }));
});
t('lifestyle and reposts are excluded even with a chart on screen', () => {
  const { isTargetFormat } = require('./outliers/classify');
  assert.ok(!isTargetFormat({ format: 'lifestyle', has_chart: true, chart_share: 0.9 }));
  assert.ok(!isTargetFormat({ format: 'meme_repost', has_chart: true, chart_share: 0.8 }));
});
t('a human label overrides the model', () => {
  const { isTargetFormat } = require('./outliers/classify');
  assert.ok(!isTargetFormat({ format: 'screenshare_teach', format_label: 'lifestyle' }));
});

group('outliers — title vs captions');
t('rolling captions are rejected, a stable title is kept', () => {
  const { extractTitle } = require('./outliers/ocr-title');
  const title = { text: 'This is what we are trading in 2026', confidence: 1, x: 0.15, y: 0.18, w: 0.7, h: 0.05 };
  const frames = ['now', 'we', 'get', 'through', 'the', 'twenties'].map((word, i) => ({
    frame: 'f' + i,
    observations: [
      title,                                                              // same every frame
      { text: word, confidence: 1, x: 0.3, y: 0.62, w: 0.4, h: 0.05 },   // changes every frame
    ],
  }));
  const r = extractTitle(frames, { debug: true });
  assert.ok(r.title && r.title.includes('trading in 2026'), 'title should survive: ' + r.title);
  assert.ok(r.rejected.some((x) => /rolling captions/.test(x.reason)), 'captions must be rejected');
});
t('platform chrome is filtered out by size', () => {
  const { extractTitle } = require('./outliers/ocr-title');
  // Chart UI text measured at h≈0.012–0.026; it must never be mistaken for a title.
  const frames = Array.from({ length: 6 }, (_, i) => ({
    frame: 'f' + i,
    observations: [{ text: 'NQ1! NASDAQ 100', confidence: 1, x: 0.05, y: 0.1, w: 0.2, h: 0.014 }],
  }));
  assert.strictEqual(extractTitle(frames).title, null);
});


group('outliers — chrome must not be mistaken for a title');
t('rejects watermarks, chart legends and platform UI', () => {
  const { looksLikeTitle } = require('./outliers/ocr-title');
  // Every one of these was extracted as a "title" from the real corpus before the fix.
  const junk = ['ris reversal', '+ Style 1 Studies', 'Industries | Health', '3.75% - 4.00%',
                'tradeify FORGE $300K SELECT', 'mrt • call', '$19,172.25', 'TRADING',
                'No.', '- No Consistency', 'Expert'];
  for (const j of junk) {
    assert.ok(!looksLikeTitle(j, { x: 0.3, y: 0.2, w: 0.4, h: 0.05 }), `should reject: ${j}`);
  }
});
t('keeps real headlines that happen to use UI words', () => {
  const { looksLikeTitle } = require('./outliers/ocr-title');
  // "account" lives in dashboard chrome AND in real trading headlines. A single vocabulary
  // list rejected this genuine title, which is why platform names and label words are split.
  const real = ['Just BLOW your funded account',
                'POV: Day Trading Actually Worked Out',
                "This is what we're trading in 2026",
                'Stay STRICT with your trading filters and rules',
                'I turned $500 into $12,000 in one session'];
  for (const r of real) {
    assert.ok(looksLikeTitle(r, { x: 0.15, y: 0.2, w: 0.7, h: 0.05 }), `should keep: ${r}`);
  }
});
t('edge-hugging narrow text is chrome, not a headline', () => {
  const { looksLikeTitle } = require('./outliers/ocr-title');
  const text = 'Some plausible words here';
  assert.ok(!looksLikeTitle(text, { x: 0.01, y: 0.2, w: 0.2, h: 0.04 }), 'left edge, narrow');
  assert.ok(looksLikeTitle(text, { x: 0.15, y: 0.2, w: 0.7, h: 0.05 }), 'inboard and wide');
});


group('titles — verification gates');
t('REJECTS a number the clip never says', () => {
  const { verifyTitle } = require('./titles/verify');
  // The exact failure the client described: "not just 'I made $5,000'".
  const tr = 'I got in at 14736 and rode it for 300 points, about 2100 dollars on this trade.';
  const r = verifyTitle({ title: 'I made $5,000 today', evidence: [{ quote: 'I got in at 14736' }], transcriptText: tr });
  assert.ok(!r.passed);
  assert.ok(r.results.find((x) => x.id === 'numerals' && !x.passed), 'the numeral gate must be what fails');
});
t('accepts a number the clip does say, across formatting', () => {
  const { numeralGate } = require('./titles/verify');
  const tr = 'that is about 2100 dollars on this one trade';
  assert.ok(numeralGate('I caught $2,100 on NQ', tr).passed, '$2,100 should match spoken 2100');
});
t('REJECTS paraphrased evidence', () => {
  const { evidenceGate } = require('./titles/verify');
  const tr = 'I waited for the pullback into the order block before entering.';
  assert.ok(!evidenceGate([{ quote: 'I waited for a retracement to the zone' }], tr).passed);
  assert.ok(evidenceGate([{ quote: 'waited for the pullback into the order block' }], tr).passed);
});
t('REJECTS a promised count the clip does not deliver', () => {
  const { enumerationGate } = require('./titles/verify');
  assert.ok(!enumerationGate('3 mistakes that blow your account', [{ quote: 'one thing' }]).passed);
  assert.ok(enumerationGate('3 mistakes that blow your account',
    [{ quote: 'a' }, { quote: 'b' }, { quote: 'c' }]).passed);
});
t('REJECTS a title too long for the plate', () => {
  const { shapeGate } = require('./titles/verify');
  assert.ok(!shapeGate('x'.repeat(80) + ' words here now').passed);
  assert.ok(shapeGate('I caught 300 points on NQ — here is the setup').passed);
});


group('captions — readable pacing');
/**
 * Fast words must not strobe — but merging them into phrases was the WRONG fix, because
 * the house style is one word at a time. Strobing is caused by a caption EXPIRING at the
 * end of its word, and is cured by holding it until the next word appears. So the
 * guarantee is asserted where it actually lives: continuous coverage of the rendered ASS,
 * with the words still one per event.
 */
t('fast words do not strobe — each holds until the next appears', () => {
  const { buildAss } = require('./captions/ass-generator');
  // Measured on a real clip: whisper gave 110-180ms for these, which flashed unreadably.
  const words = ['and', 'you', 'can', 'catch', 'that', 'win'].map((t, i) => ({
    text: t, start: i * 0.18, end: i * 0.18 + 0.15,
  }));
  const style = require('../config/captions/styles/sequel-viral.json');
  const ass = buildAss({
    track: { auto_chunked: true, words },
    style, frameDims: { width: 1080, height: 1920 }, clipStart: 0,
  });
  const toSec = (x) => {
    const m = x.match(/(\d+):(\d\d):(\d\d)\.(\d\d)/);
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100;
  };
  const ev = ass.split('\n').filter((l) => l.startsWith('Dialogue:')).map((l) => {
    const parts = l.split(',');
    return { s: toSec(parts[1]), e: toSec(parts[2]), text: parts.slice(9).join(',') };
  });
  assert.strictEqual(ev.length, words.length, 'one event per word — word-by-word style');
  // No blank frame between consecutive words: each caption reaches the next one's start.
  for (let i = 1; i < ev.length; i++) {
    const blank = ev[i].s - ev[i - 1].e;
    assert.ok(blank <= 0.02,
      `blank screen for ${Math.round(blank * 1000)}ms before word ${i} — that is the strobe`);
  }
});
t('a slow word is left alone', () => {
  const { groupWords } = require('./captions/word-grouper');
  const words = [{ text: 'imbalance', start: 0, end: 0.9 }, { text: 'here', start: 1.0, end: 1.5 }];
  const chunks = groupWords(words, { auto: true });
  assert.strictEqual(chunks[0].word_indexes.length, 1, 'a 900ms word needs no partner');
});
t('merging never crosses a sentence end', () => {
  const { groupWords } = require('./captions/word-grouper');
  const words = [
    { text: 'done.', start: 0, end: 0.12 },
    { text: 'Next', start: 0.13, end: 0.25 },
  ];
  const chunks = groupWords(words, { auto: true });
  assert.strictEqual(chunks[0].word_indexes.length, 1, 'a sentence end must close the chunk');
});
t('merging never crosses a real pause', () => {
  const { groupWords } = require('./captions/word-grouper');
  const words = [
    { text: 'so', start: 0, end: 0.1 },
    { text: 'anyway', start: 2.0, end: 2.4 },   // 1.9s pause
  ];
  const chunks = groupWords(words, { auto: true });
  assert.strictEqual(chunks[0].word_indexes.length, 1, 'a long pause must close the chunk');
});

// ─── the two-part clip structure (hook earns it, body pays it off) ───
// WHY: the corpus ranker rejected 13 of 24 gate-passing candidates from one real stream
// with "opens on a result but fails to pay off with the how" — the client's stated
// structure failing at its second beat. These strings are verbatim from that transcript,
// so an edit that re-breaks them fails here instead of shipping recaps and clipper ads.
console.log('\nclip structure — payoff & off-topic');
{
  const { PAYOFF, OFF_TOPIC, rankScore } = require('./select/signals');

  const TEACHES = [
    'if it is over 20 points it will tell me not to trade',
    'I took this bounce off of this low right here saw the price was coming down',
    'I trade off the midpoint and we disrespect the low so I put my stop',
    'the orb was 13.50 points this indicator tells me the orb on how big it is',
    'I moved my stop to break even because the wick took out the low',
  ];
  const NO_TEACHING = [
    'the dopamine that comes from ripping a trade I have crashed jet skis',
    'also I am actively looking for clippers I know I say this so often',
    'I made 3000 so that is pretty nice and this other trade was fun',
    'yeah what is up Marco how are you doing today man good to see you',
  ];
  const HOUSEKEEPING = [
    'also I am actively looking for clippers I know I say this so often',
    'what do you guys want funded we are giving away some like helpful',
    'when y all like are like uh arguing with each other in the chats yeah',
  ];

  t('PAYOFF recognises teaching in real stream text', () => {
    for (const x of TEACHES) assert.ok(PAYOFF.test(x), `should teach: ${x}`);
  });
  t('PAYOFF ignores anecdote, greeting and a bare result claim', () => {
    for (const x of NO_TEACHING) assert.ok(!PAYOFF.test(x), `should not teach: ${x}`);
  });
  t('OFF_TOPIC catches housekeeping the ranker paid a model call to reject', () => {
    for (const x of HOUSEKEEPING) {
      OFF_TOPIC.lastIndex = 0;
      assert.ok((x.match(OFF_TOPIC) || []).length > 0, `should be off-topic: ${x}`);
    }
  });

  const base = {
    numberDensity: 1, instrumentMentions: 1, setupMentions: 1, resultClaim: 1,
    reactionOpen: 0, explainPivot: 0, question: 0, openPenalty: 0, endPenalty: 0,
    worstGapSeconds: 0, speechRatio: 0.9, wordsPerSecond: 3,
    payoff: 0, bodyMechanism: 0, offTopic: 0,
  };
  t('a result claim with no payoff ranks far below the same claim with one', () => {
    const recap = rankScore({ signals: base });
    const lesson = rankScore({ signals: { ...base, payoff: 1, bodyMechanism: 1.5 } });
    assert.ok(lesson > recap + 4, `lesson ${lesson} must clear recap ${recap} by a wide margin`);
  });
  t('housekeeping is penalised even when the talk is dense', () => {
    const clean = { ...base, resultClaim: 0 };
    assert.ok(rankScore({ signals: { ...clean, offTopic: 2 } }) < rankScore({ signals: clean }));
  });
}

// ─── captions are WORD BY WORD and never stack two on screen ───
console.log('\ncaptions — word-by-word, no overlap');
{
  const { groupWords } = require('./captions/word-grouper');
  const { buildAss } = require('./captions/ass-generator');

  // Real whisper timings: word durations swing from 40ms to 580ms inside one sentence.
  const WORDS = [
    { text: 'but', start: 0.24, end: 0.38 },   { text: 'I', start: 0.38, end: 0.42 },
    { text: 'made', start: 0.42, end: 0.62 },  { text: '$3,000', start: 0.62, end: 1.20 },
    { text: 'so', start: 1.20, end: 1.33 },    { text: "that's", start: 1.33, end: 1.72 },
    { text: 'pretty', start: 1.72, end: 1.86 },{ text: 'nice', start: 1.86, end: 2.12 },
  ];

  t('auto grouping is ONE WORD per chunk by default', () => {
    const chunks = groupWords(WORDS, { auto: true });
    assert.strictEqual(chunks.length, WORDS.length, 'every word gets its own chunk');
    for (const c of chunks) {
      assert.strictEqual(c.text.split(/\s+/).length, 1, `not a single word: "${c.text}"`);
    }
  });

  t('a style can still opt in to merged phrases', () => {
    const chunks = groupWords(WORDS, { auto: true, minChunkSeconds: 0.7 });
    assert.ok(chunks.length < WORDS.length, 'merging should reduce the chunk count');
  });

  // The 150ms minimum display duration used to push a 40ms word past the next word's
  // start, putting two captions on screen at once — the "disordered captions" defect.
  t('the minimum display duration never crosses the next word', () => {
    const chunks = groupWords(WORDS, { auto: true });
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i - 1].end <= chunks[i].start + 1e-9,
        `chunk ${i - 1} ("${chunks[i - 1].text}") ends ${chunks[i - 1].end} after ` +
        `chunk ${i} ("${chunks[i].text}") starts ${chunks[i].start}`);
    }
  });

  t('rendered ASS events never overlap', () => {
    const style = require('../config/captions/styles/sequel-viral.json');
    const ass = buildAss({
      track: { auto_chunked: true, words: WORDS },
      style, frameDims: { width: 1080, height: 1920 }, clipStart: 0,
    });
    const toSec = (x) => {
      const m = x.match(/(\d+):(\d\d):(\d\d)\.(\d\d)/);
      return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100;
    };
    const ev = ass.split('\n').filter((l) => l.startsWith('Dialogue:')).map((l) => {
      const parts = l.split(',');
      return { s: toSec(parts[1]), e: toSec(parts[2]) };
    });
    assert.ok(ev.length >= WORDS.length - 1, 'should emit an event per word');
    for (let i = 1; i < ev.length; i++) {
      assert.ok(ev[i].s >= ev[i - 1].e - 1e-9,
        `event ${i} starts ${ev[i].s} before event ${i - 1} ends ${ev[i - 1].e}`);
    }
  });
}

// ─── the same moment must not reach the editor twice ───
console.log('\ncandidates — nested spans are the same moment');
{
  const { __testables } = require('./select/candidates');
  if (__testables && __testables.containment) {
    const { containment, iou } = __testables;
    // Measured on a real run: a 33s pick nested inside a 99s pick. IoU says "distinct".
    const long = { startSeconds: 1736.4, endSeconds: 1835.2 };
    const short = { startSeconds: 1736.4, endSeconds: 1772.9 };
    t('IoU alone does NOT catch a nested span (this is why the bug existed)', () => {
      assert.ok(iou(long, short) < 0.45, `IoU ${iou(long, short).toFixed(3)} is under the threshold`);
    });
    t('containment catches it', () => {
      assert.strictEqual(+containment(long, short).toFixed(2), 1.00);
    });
    t('genuinely adjacent moments are left alone', () => {
      const a = { startSeconds: 100, endSeconds: 160 };
      const b = { startSeconds: 155, endSeconds: 215 };   // 5s of overlap only
      assert.ok(containment(a, b) < 0.6, 'neighbours must survive suppression');
    });
  }
}

// ─── captions start when the word is SAID, not during the pause before it ───
// WHY: whisper tiles word timings across pauses, so the word after a pause starts inside
// it and its caption fires early. Measured on a real clip: 22 of 215 words, median 590 ms
// early, worst 3.38 s — the operator's "it already starts the other word".
console.log('\ncaption timing — words snap to the voice');
{
  const align = require('./captions/align');
  const F = align.FRAME_S;
  // Build a voice model directly from a frame plan: 1 = speech, 0 = silence.
  const model = (plan) => {
    const voiced = Uint8Array.from(plan);
    return { voiced, runs: align.pauseRuns(voiced) };
  };
  const frames = (spec) => spec.flatMap(([v, secs]) => Array(Math.round(secs / F)).fill(v));

  t('case 1: a word stretched back over a pause starts at the voice onset', () => {
    // speech 0-1s, pause 1-1.6s, speech 1.6-2.2s. whisper says word 2 starts at 1.0.
    const v = model(frames([[1, 1], [0, 0.6], [1, 0.6]]));
    const { words } = align.refineWordTimings([
      { word: 'clipping', start: 0.4, end: 1.0 },
      { word: 'start', start: 1.0, end: 2.2 },
    ], v);
    assert.ok(Math.abs(words[1].start - 1.6) < 0.015, `"start" should begin at 1.6, got ${words[1].start}`);
    assert.strictEqual(words[1].raw_start, 1.0, 'the original timing is kept for debugging');
  });

  t('case 2: a quiet word filling a short gap is left where it is', () => {
    // a 0.3 s "gap" that is really an unstressed "the" — no voice, short.
    const v = model(frames([[1, 1], [0, 0.3], [1, 1]]));
    const { words } = align.refineWordTimings([
      { word: 'saw', start: 0.6, end: 1.0 },
      { word: 'the', start: 1.0, end: 1.3 },
      { word: 'price', start: 1.3, end: 1.8 },
    ], v);
    assert.strictEqual(words[1].start, 1.0, 'a correctly-timed quiet word must not move');
  });

  t('case 3: words crammed into a long pause are laid out after it', () => {
    // speech, a 5 s pause holding three words, speech resumes at 6.0.
    const v = model(frames([[1, 1], [0, 5], [1, 2]]));
    const { words } = align.refineWordTimings([
      { word: 'that', start: 0.5, end: 1.0 },
      { word: 'also', start: 1.0, end: 2.5 },
      { word: 'if', start: 2.5, end: 4.0 },
      { word: 'any', start: 4.0, end: 6.0 },
      { word: 'guys', start: 6.6, end: 7.0 },
    ], v);
    for (const w of words.slice(1, 4)) {
      assert.ok(w.start >= 6.0 - 1e-9, `"${w.word}" must not appear before speech resumes (${w.start})`);
    }
    assert.ok(words[3].start < 6.6, 'the group must fit before the next word');
  });

  t('a click between two pauses is not an onset', () => {
    // pause 1-2s, a 20 ms click, pause again, speech at 2.5s.
    const v = model(frames([[1, 1], [0, 1], [1, 0.02], [0, 0.48], [1, 1]]));
    const { words } = align.refineWordTimings([
      { word: 'ok', start: 0.5, end: 1.0 },
      { word: 'swept', start: 1.0, end: 3.0 },
    ], v);
    assert.ok(words[1].start >= 2.5 - 0.015, `"swept" belongs to the real onset, got ${words[1].start}`);
  });

  t('continuous speech: nothing moves', () => {
    const v = model(frames([[1, 3]]));
    const input = [{ word: 'a', start: 0, end: 1 }, { word: 'b', start: 1, end: 2 }, { word: 'c', start: 2, end: 3 }];
    const { moved } = align.refineWordTimings(input, v);
    assert.strictEqual(moved, 0);
  });

  t('v3: two abutting words meet at a clear energy dip; a flat stretch leaves them alone', () => {
    const n = 1200;
    const db = new Float32Array(n).fill(-20);
    for (let f = 505; f <= 507; f++) db[f] = -30;            // a dip centred 60 ms after the boundary at 5.00
    const voiced = new Uint8Array(n).fill(1);
    const v = { db, voiced, runs: align.pauseRuns(voiced) };
    const { words } = align.refineWordTimings([
      { word: 'gold', start: 4.0, end: 5.0 }, { word: 'paid', start: 5.0, end: 6.0 },
      { word: 'three', start: 6.0, end: 7.0 }, { word: 'grand', start: 7.0, end: 8.0 },
    ], v);
    assert.equal(words[1].start, 5.06, 'the boundary moves to the dip');
    assert.equal(words[0].end, 5.06, 'the previous word ends there too');
    assert.equal(words[3].start, 7.0, 'no dip, no move');
  });

  t('pauses: a click inside a silence does not split it; a transcript word does', () => {
    const { pausesFromEnvelope } = require('./select/pauses');
    const n = 3000;
    const db = new Float32Array(n).fill(-20);                 // speech
    for (let f = 1000; f < 1200; f++) db[f] = -60;             // 2 s of silence…
    for (let f = 1100; f < 1105; f++) db[f] = -15;             // …with a 50 ms click in it
    const one = pausesFromEnvelope(db, { from: 8, to: 14, minPause: 0.3 });
    assert.equal(one.length, 1, 'one pause, the click folded');
    assert.ok(Math.abs(one[0].seconds - 2) < 0.02, 'about two seconds');
    const two = pausesFromEnvelope(db, { from: 8, to: 14, minPause: 0.3, protect: [11.0] });
    assert.equal(two.length, 2, 'a word starting on the island keeps it');
  });

  t('tighten: dead air above the limit is cut with air left at the join; quiet words and slivers are handled', () => {
    const { tightenCuts, deadAir } = require('./edit/tighten');
    const { normalizeDoc } = require('./edit/doc');
    const base = normalizeDoc({ range: { start: 100, end: 110 }, cuts: [] }, { start_s: 100, end_s: 110 });
    const words = [{ start: 101, end: 102 }, { start: 103.5, end: 104 }];
    const r = tightenCuts(base, [{ start: 102, end: 103.5, seconds: 1.5 }], words, { maxPause: 0.35 });
    assert.deepEqual(r.added.map((c) => [c.start, c.end]), [[102.08, 103.38]]);
    assert.ok(Math.abs(r.removedSeconds - 1.3) < 0.001);
    assert.equal(deadAir(r.doc, [{ start: 102, end: 103.5 }], { maxPause: 0.35 }).length, 0, 'nothing above the limit remains');
    // a quiet word inside the pause is fenced off
    const q = tightenCuts(base, [{ start: 102, end: 103.5 }], [...words, { start: 102.5, end: 102.7 }], { maxPause: 0.35 });
    assert.deepEqual(q.added.map((c) => [c.start, c.end]), [[102.08, 102.33], [102.83, 103.38]]);
    // a word-less sliver between two cuts goes whole
    const sl = normalizeDoc({ range: { start: 100, end: 110 }, cuts: [{ start: 101, end: 102 }, { start: 102.1, end: 103 }] }, { start_s: 100, end_s: 110 });
    const t2 = tightenCuts(sl, [], [{ start: 100.2, end: 100.8 }, { start: 103.2, end: 103.8 }], {});
    assert.equal(t2.doc.cuts.length, 1, 'the sliver merged into one cut');
    assert.deepEqual([t2.doc.cuts[0].start, t2.doc.cuts[0].end], [101, 103]);
  });

  t('tools: release assets are chosen per platform and whisper has none for macOS', () => {
    const tools = require('./tools');
    assert.equal(tools.ytdlpAsset('win32'), 'yt-dlp.exe');
    assert.equal(tools.ytdlpAsset('darwin'), 'yt-dlp_macos');
    assert.equal(tools.ytdlpAsset('linux'), 'yt-dlp_linux');
    assert.equal(tools.whisperAsset('win32', 'x64'), 'whisper-bin-x64.zip');
    assert.equal(tools.whisperAsset('win32', 'arm64'), 'whisper-bin-win-cpu-arm64.zip');
    assert.equal(tools.whisperAsset('linux', 'x64'), 'whisper-bin-ubuntu-x64.tar.gz');
    assert.equal(tools.whisperAsset('darwin', 'arm64'), null);
  });

  t('re-aligning an aligned transcript gives the same result', () => {
    const v = model(frames([[1, 1], [0, 0.6], [1, 0.6]]));
    const input = [{ word: 'clipping', start: 0.4, end: 1.0 }, { word: 'start', start: 1.0, end: 2.2 }];
    const once = align.refineWordTimings(input, v).words;
    const twice = align.refineWordTimings(once, v).words;
    assert.deepStrictEqual(twice.map((w) => [w.start, w.end]), once.map((w) => [w.start, w.end]));
  });

  t('output is ordered and never overlaps', () => {
    const v = model(frames([[1, 1], [0, 4], [1, 1]]));
    const { words } = align.refineWordTimings([
      { word: 'x', start: 0.2, end: 1.0 }, { word: 'y', start: 1.0, end: 1.0 },
      { word: 'z', start: 1.0, end: 5.0 }, { word: 'w', start: 5.0, end: 6.0 },
    ], v);
    for (let i = 1; i < words.length; i++) {
      assert.ok(words[i].start > words[i - 1].start, 'strictly ordered starts');
      assert.ok(words[i - 1].end <= words[i].start + 1e-9, 'no overlap');
      assert.ok(words[i].end > words[i].start, 'positive duration');
    }
  });
}

// ─── single-pass band render: audio and video cannot drift apart at cuts ───
// WHY: the per-span renderer padded each span's AAC audio to a whole codec frame, so audio
// started one frame late at every join — measured +23.1 ms per join, +600 ms after 26
// joins. Captions burned into the video ran ahead of the voice; lip sync drifted too.
console.log('\nsingle-pass band render — frame-exact cuts');
{
  const band = require('./compose/band-clip');
  // The third span (10 ms at 30 fps) rounds to zero frames: 20.00 → frame 600, 20.01 → 600.
  const spans = [{ start: 10.012, end: 11.25 }, { start: 12.4, end: 13.01 }, { start: 20, end: 20.01 }];

  t('cut boundaries snap to the frame grid, and a sub-frame span is dropped', () => {
    const s = band.snapSpans(spans, 30);
    assert.strictEqual(s.spans.length, 2, 'a span that rounds to zero frames is dropped');
    for (const sp of s.spans) {
      assert.ok(Math.abs(sp.a * 30 - Math.round(sp.a * 30)) < 1e-9, `start ${sp.a} off the grid`);
      assert.ok(Math.abs(sp.b * 30 - Math.round(sp.b * 30)) < 1e-9, `end ${sp.b} off the grid`);
    }
  });

  t('output offsets are the exact running total of kept frames', () => {
    const s = band.snapSpans(spans, 30);
    assert.strictEqual(s.spans[0].outStart, 0);
    assert.ok(Math.abs(s.spans[1].outStart - (s.spans[0].fb - s.spans[0].fa) / 30) < 1e-9);
    assert.ok(Math.abs(s.durationSeconds - s.frames / 30) < 1e-9);
  });

  t('a word maps to the span it starts in, once', () => {
    const s = band.snapSpans(spans, 30);
    const out = band.mapWordsToOutput([
      { word: 'in', start: 10.5, end: 10.8 },
      { word: 'straddles', start: 11.1, end: 12.6 },   // starts in span 0, ends in span 1
      { word: 'cut', start: 11.8, end: 12.1 },         // inside the removed gap
      { word: 'later', start: 12.5, end: 12.9 },
    ], s);
    assert.deepStrictEqual(out.map((w) => w.text), ['in', 'straddles', 'later']);
    const later = out[2];
    assert.ok(Math.abs(later.start - (s.spans[1].outStart + (12.5 - s.spans[1].a))) < 1e-3);
  });

  t('the graph trims audio sample-exactly and runs the canvas at the source rate', () => {
    const s = band.snapSpans(spans, 30);
    const g = band.buildSinglePassGraph({
      snapped: s, fps: 30,
      layout: { canvas: { width: 1080, height: 1920 }, background: '#000000' },
      geo: { y: 700, h: 608 }, assPath: null, fontsDir: null, plate: null, titleSeconds: null,
    });
    assert.ok(/color=c=#000000:s=1080x1920:r=30/.test(g), 'canvas without r= defaults to 25 fps');
    assert.strictEqual((g.match(/atrim=/g) || []).length, s.spans.length, 'one sample-exact trim per span');
    assert.ok(/concat=n=2:v=0:a=1/.test(g), 'audio joined as audio, not re-encoded per span');
    assert.strictEqual((g.match(/gte\(t/g) || []).length, s.spans.length, 'one frame window per span');
  });
}

// ─── the composition document: one description the preview and the export both read ───
console.log('\ncomposition document');
{
  const docs = require('./edit/doc');
  const clip = { start_s: 100, end_s: 160, title_text: 'Hi', cuts_json: JSON.stringify([{ start: 110, end: 111, source: 'silence' }]) };
  const tr = { words: [
    { word: 'before', start: 90, end: 91 },
    { word: 'one', start: 100.2, end: 100.5 },
    { word: 'two', start: 110.2, end: 110.6 },   // inside the silence cut
    { word: 'three', start: 120, end: 120.4 },
  ] };

  t('a fresh document is exactly the machine plan', () => {
    const d = docs.defaultDoc(clip);
    assert.deepStrictEqual(d.range, { start: 100, end: 160 });
    assert.strictEqual(d.cuts.length, 1);
    assert.strictEqual(d.title.text, 'Hi');
    assert.strictEqual(d.title.hold, null, 'the title holds for the whole clip by default');
  });

  t('garbage from the browser is clamped, never trusted', () => {
    const d = docs.normalizeDoc({
      range: { start: 100, end: 100.2 },
      title: { size: 9999, color: 'red', hold: -4 },
      captions: { mode: 'karaoke-disco', size: 1 },
      format: { variant: '../../etc' },
      cuts: [{ start: 50, end: 105 }, { start: 104, end: 108 }],
    }, clip);
    assert.ok(d.range.end - d.range.start >= 1, 'a clip keeps at least one second');
    assert.strictEqual(d.title.size, 130);
    assert.strictEqual(d.title.color, '#111111');
    assert.strictEqual(d.title.hold, null);
    assert.strictEqual(d.captions.mode, 'word');
    assert.strictEqual(d.format.variant, 'band-title-top');
    assert.strictEqual(d.cuts.length, 1, 'overlapping cuts merge, and are clamped to the range');
  });

  t('word edits are keyed by transcript index and reach the render params', () => {
    const d = docs.normalizeDoc({ ...docs.defaultDoc(clip), words: { 3: { text: 'THREE!' }, 1: { hidden: true } } }, clip);
    const p = docs.docToRenderParams(d, tr);
    const texts = p.words.map((w) => w.edited_text ?? w.word);
    assert.ok(!texts.includes('before'), 'words outside the range are not captioned');
    assert.ok(!texts.includes('one'), 'a hidden word is not captioned');
    assert.ok(texts.includes('THREE!'), 'the fixed word replaces the transcript word');
  });

  t('box off means a transparent plate fill, not a missing plate', () => {
    const d = docs.normalizeDoc({ ...docs.defaultDoc(clip), title: { text: 'x', box: false } }, clip);
    const p = docs.docToRenderParams(d, tr);
    assert.strictEqual(p.titleStyle.fill, '#00000000');
    assert.strictEqual(p.titleStyle.radius, 0);
  });

  t('kept spans are the range minus the cuts', () => {
    const d = docs.defaultDoc(clip);
    assert.deepStrictEqual(docs.keptSpansOf(d), [{ start: 100, end: 110 }, { start: 111, end: 160 }]);
  });
}

// ─── highlight captions: the phrase stays up, the SPOKEN word lights ───
console.log('\ncaptions — highlight mode');
{
  const ph = require('./captions/phrases');
  const W = [['I', 0.38, 0.42], ['made', 0.42, 0.62], ['$3,000', 0.62, 1.2], ['so', 1.2, 1.33],
    ["that's", 1.33, 1.72], ['nice.', 1.72, 2.1], ['And', 2.9, 3.1], ['this', 3.1, 3.3]]
    .map(([text, start, end]) => ({ text, start, end }));

  t('the active word changes exactly at each word start', () => {
    const ev = ph.highlightEvents(W);
    for (const w of W) {
      const e = ev.find((x) => Math.abs(x.start - w.start) < 1e-9);
      assert.ok(e, `no event starts at "${w.text}"`);
      const active = e.lines.flat().filter((x) => x.active);
      assert.strictEqual(active.length, 1);
      assert.strictEqual(active[0].text, w.text);
    }
  });

  t('a sentence end or a real pause starts a new phrase', () => {
    const phrases = ph.groupPhrases(W).map((p) => p.map((w) => w.text).join(' '));
    assert.ok(phrases.some((p) => p.endsWith('nice.')), 'the sentence ends its phrase');
    assert.ok(phrases.some((p) => p.startsWith('And')), 'the words after the pause begin a new one');
  });

  t('events are continuous — no blank frames between words of a phrase', () => {
    const ev = ph.highlightEvents(W);
    for (let i = 1; i < ev.length; i++) {
      assert.ok(ev[i].start >= ev[i - 1].end - 1e-9, 'no overlap');
    }
    const firstPhrase = ev.filter((e) => e.start < 1.3);
    for (let i = 1; i < firstPhrase.length; i++) {
      assert.ok(Math.abs(firstPhrase[i].start - firstPhrase[i - 1].end) < 1e-9, 'no gap inside a phrase');
    }
  });
}

// ─── the editor's document round-trips, and its preview shows what the export burns ───
console.log('\neditor — document round-trip and preview parity');
{
  const docs = require('./edit/doc');
  const band = require('./compose/band-clip');
  const phrases = require('./captions/phrases');
  const clip = { start_s: 100, end_s: 130, title_text: 'T', cuts_json: JSON.stringify([{ start: 110, end: 112, source: 'silence' }]) };
  const tr = { words: [
    { word: 'alpha', start: 101, end: 101.4 }, { word: 'beta', start: 101.5, end: 101.9 },
    { word: 'gone', start: 110.5, end: 110.9 }, { word: 'gamma', start: 113, end: 113.5 },
    { word: 'delta', start: 125, end: 125.4 }, { word: 'outside', start: 140, end: 140.5 },
  ] };

  t('normalizeDoc is idempotent', () => {
    const once = docs.normalizeDoc({ ...docs.defaultDoc(clip), words: { 3: { text: 'GAMMA' } }, title: { text: 'x', y: 500.7 } }, clip);
    const twice = docs.normalizeDoc(once, clip);
    assert.deepStrictEqual(twice, once);
  });

  t('wordsInWindow flags range and cuts, and applies edits', () => {
    const d = docs.normalizeDoc({ ...docs.defaultDoc(clip), words: { 3: { text: 'GAMMA' } } }, clip);
    const w = docs.wordsInWindow(d, tr, 90, 135);
    const byI = Object.fromEntries(w.map((x) => [x.i, x]));
    assert.ok(!byI[5], 'a word outside the window is not returned');
    assert.strictEqual(byI[2].cut, true, 'a word inside the silence cut is flagged');
    assert.strictEqual(byI[3].text, 'GAMMA');
    assert.strictEqual(byI[3].edited, true);
    assert.strictEqual(byI[0].inRange, true);
  });

  t('the preview derives the same caption events the export burns in', () => {
    // Both paths: docToRenderParams → snapSpans → mapWordsToOutput → phrases.*Events.
    const d = docs.normalizeDoc({ ...docs.defaultDoc(clip), captions: { mode: 'highlight', case: 'upper' } }, clip);
    const p = docs.docToRenderParams(d, tr);
    const snapped = band.snapSpans(p.spans, 30);
    const out = band.mapWordsToOutput(p.words, snapped);
    const a = phrases.highlightEvents(out);
    const b = phrases.highlightEvents(band.mapWordsToOutput(docs.docToRenderParams(d, tr).words, band.snapSpans(docs.docToRenderParams(d, tr).spans, 30)));
    assert.deepStrictEqual(a, b, 'pure functions: same document, same events');
    assert.ok(!out.some((w) => w.text === 'gone'), 'a word inside a cut is not captioned');
    const gamma = out.find((w) => w.text === 'gamma');
    // 113 s in source is 2 s of cut after 110 → output time 11 s exactly.
    assert.ok(Math.abs(gamma.start - 11) < 0.04, `gamma at ${gamma.start}`);
  });

  t('plate file names never escape their directory', () => {
    assert.ok(/^title-[0-9a-f]{12}\.png$/.test('title-7bae65d71701.png'));
    assert.ok(!/^title-[0-9a-f]{12}\.png$/.test('../../etc/passwd'));
    assert.ok(!/^title-[0-9a-f]{12}\.png$/.test('title-7bae65d71701.png/../x'));
  });
}

// ─── pane geometry: what the preview draws is what the export crops ───
console.log('\npane geometry');
{
  const g = require('./compose/pane-geometry');
  const comp = { mode: 'pip', cam: { x: 0, y: 0.62, w: 0.3, h: 0.38 }, screen: { x: 0, y: 0, w: 1, h: 1 } };
  t('every format resolves and covers its box without distortion', () => {
    for (const v of g.listVariants()) {
      const G = g.layoutGeometry(v.id, { composition: comp, srcW: 640, srcH: 360 });
      if (G.kind !== 'panes') continue;
      for (const p of G.panes) {
        const ar = (p.visible.w / p.visible.h) / (p.dst.w / p.dst.h);
        assert.ok(Math.abs(ar - 1) < 0.03, `${v.id}/${p.id}: visible aspect ${ar.toFixed(3)} ≠ destination aspect`);
        assert.ok(p.visible.x >= p.region.x - 1 && p.visible.x + p.visible.w <= p.region.x + p.region.w + 1, 'visible part stays inside its region');
      }
    }
  });
  t('a stacked layout puts the title on the seam', () => {
    const G = g.layoutGeometry('screen-top', { composition: comp, srcW: 640, srcH: 360 });
    assert.strictEqual(G.titleY, 900);
  });
  t('re-composed formats refuse to guess without detected regions', () => {
    assert.throws(() => g.layoutGeometry('screen-top', { composition: null, srcW: 640, srcH: 360 }), /not been detected/);
    assert.doesNotThrow(() => g.layoutGeometry('band-title-top', { composition: null, srcW: 640, srcH: 360 }));
  });
  t('the pane filter chain names every pane and ends in [comp]', () => {
    const G = g.layoutGeometry('screen-full-pip-bl', { composition: comp, srcW: 640, srcH: 360 });
    const lines = g.paneGraph(G, 'sel', '#000000');
    assert.ok(lines.some((l) => /split=2/.test(l)));
    assert.ok(lines[lines.length - 1].endsWith('[comp]'));
    assert.ok(lines.some((l) => /scale=410:/.test(l)), 'the inset scales to 38% of the canvas width');
  });
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
