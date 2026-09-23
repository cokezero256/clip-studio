#!/usr/bin/env node

/**
 * Pure-logic smoke tests. No API keys, no ffmpeg, no Dropbox.
 * Run: node test/smoke.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { rational, buildFcpxml } = require('./fcpxml');
const { invertDrops } = require('./pipeline');
const { buildAudit } = require('./audit');
const { loadDefault } = require('./config');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ─── rational() — frame-rate math ───
console.log('\nrational()');
test('29.97 (30000/1001) — 1 frame', () => {
  assert.strictEqual(rational(1001 / 30000, 30000, 1001), '1001/30000s');
});
test('29.97 — 100 frames', () => {
  assert.strictEqual(rational(100 * 1001 / 30000, 30000, 1001), '100100/30000s');
});
test('30 fps — integer second', () => {
  assert.strictEqual(rational(1, 30, 1), '1s');
});
test('24 fps — 1 frame', () => {
  assert.strictEqual(rational(1 / 24, 24, 1), '1/24s');
});
test('60 fps — 5 seconds = 300 frames', () => {
  assert.strictEqual(rational(5, 60, 1), '5s');
});
test('zero seconds', () => {
  assert.strictEqual(rational(0, 30000, 1001), '0s');
});

// ─── invertDrops() ───
console.log('\ninvertDrops()');
test('no drops → single keep covering full duration', () => {
  const r = invertDrops([], 100);
  assert.deepStrictEqual(r, [{ start_seconds: 0, end_seconds: 100 }]);
});
test('one drop in middle → two keeps', () => {
  const r = invertDrops([{ start_seconds: 30, end_seconds: 35 }], 100);
  assert.deepStrictEqual(r, [
    { start_seconds: 0, end_seconds: 30 },
    { start_seconds: 35, end_seconds: 100 },
  ]);
});
test('drop at start → keep starts at drop end', () => {
  const r = invertDrops([{ start_seconds: 0, end_seconds: 5 }], 100);
  assert.deepStrictEqual(r, [{ start_seconds: 5, end_seconds: 100 }]);
});
test('drop at end → keep ends at drop start', () => {
  const r = invertDrops([{ start_seconds: 95, end_seconds: 100 }], 100);
  assert.deepStrictEqual(r, [{ start_seconds: 0, end_seconds: 95 }]);
});
test('overlapping drops merge', () => {
  const r = invertDrops(
    [
      { start_seconds: 10, end_seconds: 20 },
      { start_seconds: 15, end_seconds: 25 },
    ],
    100,
  );
  assert.deepStrictEqual(r, [
    { start_seconds: 0, end_seconds: 10 },
    { start_seconds: 25, end_seconds: 100 },
  ]);
});
test('adjacent drops merge', () => {
  const r = invertDrops(
    [
      { start_seconds: 10, end_seconds: 15 },
      { start_seconds: 15, end_seconds: 20 },
    ],
    100,
  );
  assert.deepStrictEqual(r, [
    { start_seconds: 0, end_seconds: 10 },
    { start_seconds: 20, end_seconds: 100 },
  ]);
});
test('three non-overlapping drops → four keeps', () => {
  const r = invertDrops(
    [
      { start_seconds: 10, end_seconds: 15 },
      { start_seconds: 30, end_seconds: 32 },
      { start_seconds: 50, end_seconds: 51 },
    ],
    100,
  );
  assert.strictEqual(r.length, 4);
  assert.strictEqual(r[0].end_seconds, 10);
  assert.strictEqual(r[1].start_seconds, 15);
  assert.strictEqual(r[1].end_seconds, 30);
  assert.strictEqual(r[3].end_seconds, 100);
});

// ─── buildFcpxml() ───
console.log('\nbuildFcpxml()');
test('emits well-formed XML with rational frameDuration', () => {
  const xml = buildFcpxml({
    projectName: 'Test',
    sourceFileName: 'source.mp4',
    probe: {
      fps_num: 30000,
      fps_den: 1001,
      width: 1920,
      height: 1080,
      duration_seconds: 60,
      audio_sample_rate: 48000,
      audio_channels: 2,
    },
    keepSegments: [
      { start_seconds: 0, end_seconds: 10 },
      { start_seconds: 20, end_seconds: 30 },
    ],
  });
  assert.match(xml, /<\?xml version="1.0"/);
  assert.match(xml, /<fcpxml version="1.10">/);
  assert.match(xml, /frameDuration="1001\/30000s"/);
  assert.match(xml, /width="1920"/);
  assert.match(xml, /src="file:\/\/\.\/source\.mp4"/);
  assert.match(xml, /<asset-clip [^>]+ name="seg1"/);
  assert.match(xml, /<asset-clip [^>]+ name="seg2"/);
});
test('escapes special chars in project name', () => {
  const xml = buildFcpxml({
    projectName: 'Acme <Q3> "Interview" & co',
    sourceFileName: 'source.mp4',
    probe: { fps_num: 30, fps_den: 1, width: 1920, height: 1080, duration_seconds: 10, audio_sample_rate: 48000, audio_channels: 2 },
    keepSegments: [{ start_seconds: 0, end_seconds: 10 }],
  });
  assert.match(xml, /Acme &lt;Q3&gt; &quot;Interview&quot; &amp; co/);
  assert.doesNotMatch(xml, /Acme <Q3>/);
});
test('refuses empty keepSegments', () => {
  assert.throws(
    () =>
      buildFcpxml({
        projectName: 'Test',
        sourceFileName: 'source.mp4',
        probe: { fps_num: 30, fps_den: 1, width: 1920, height: 1080, duration_seconds: 10, audio_sample_rate: 48000, audio_channels: 2 },
        keepSegments: [],
      }),
    /keepSegments is empty/,
  );
});

// ─── buildAudit() ───
console.log('\nbuildAudit()');
test('renders summary, hooks, b-roll, applied + suggested', () => {
  const md = buildAudit({
    sourceName: 'interview.mp4',
    client: 'acme',
    probe: { duration_seconds: 600 },
    cuts: [],
    appliedCuts: [
      { start_seconds: 12.4, end_seconds: 14.5, reason: 'silence', confidence: 0.99, note: '' },
      { start_seconds: 90, end_seconds: 90.8, reason: 'filler', confidence: 0.94, note: '"um you know"' },
    ],
    suggestedCuts: [
      { start_seconds: 200, end_seconds: 201.6, reason: 'repetition', confidence: 0.71, note: 'maybe rhetorical' },
    ],
    highlights: [
      { start_seconds: 30, end_seconds: 45, reason: 'hook', confidence: 0.92, note: 'If you only remember one thing' },
      { start_seconds: 120, end_seconds: 121, reason: 'b_roll_cue', confidence: 0.85, note: 'imagine a warehouse full of...' },
    ],
    finalDuration: 350,
    clientConfig: loadDefault(),
  });
  assert.match(md, /# Auto-edit audit — interview\.mp4/);
  assert.match(md, /\*\*Client:\*\* acme/);
  assert.match(md, /Source:.+10m\s*00s/);
  assert.match(md, /Output:.+5m\s*50s/);
  assert.match(md, /Hook candidates/);
  assert.match(md, /B-roll cues/);
  assert.match(md, /Cuts applied/);
  assert.match(md, /Suggested but NOT applied/);
  assert.match(md, /If you only remember one thing/);
});

// ─── config loading ───
console.log('\nconfig.loadDefault()');
test('loads _default.json with expected keys', () => {
  const c = loadDefault();
  assert.ok(Array.isArray(c.filler_words));
  assert.ok(typeof c.silence_threshold_seconds === 'number');
  assert.ok(typeof c.j_cut_ms === 'number');
  assert.ok(typeof c.style_guide === 'string');
});

// ─── caption sync invariant ───
// Guards the regression where the black-frame hybrid seek made captions ~0.5s early.
// The caption timeline must be anchored to the same origin as the input seek, i.e.
// captionClipStart(s) + seekPreroll(s) === s for every clip start s.
console.log('\nclip-renderer caption-sync invariant');
const { seekPreroll, captionClipStart } = require('./clip-renderer');
test('captionClipStart + seekPreroll === start (captions stay in sync)', () => {
  for (const s of [0, 0.1, 0.3, 0.5, 0.5001, 1, 5, 42.7, 769.0]) {
    const preroll = seekPreroll(s);
    assert.ok(preroll >= 0 && preroll <= s + 1e-9, `preroll out of range for s=${s}: ${preroll}`);
    assert.ok(preroll <= 0.5 + 1e-9, `preroll exceeds cap for s=${s}: ${preroll}`);
    assert.ok(
      Math.abs(captionClipStart(s) + preroll - s) < 1e-9,
      `caption anchor drifted for s=${s}: ${captionClipStart(s)} + ${preroll} !== ${s}`,
    );
  }
});
test('seekPreroll caps at 0.5s and never seeks negative on short clips', () => {
  assert.strictEqual(seekPreroll(5), 0.5);
  assert.strictEqual(seekPreroll(0.2), 0.2);
  assert.strictEqual(seekPreroll(0), 0);
});

// ─── summary ───
console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
