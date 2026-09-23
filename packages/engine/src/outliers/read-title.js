/**
 * Read a reel's burned-in headline with a vision model.
 *
 * A REPAIR PASS, not the primary path. macOS Vision OCR plus the persistence/stability
 * rules handles most reels and is free — and critically it returns bounding boxes, which is
 * the only mechanical way to separate a title from rolling captions. But it misses roughly
 * 45% of the titles the format classifier can plainly see: stylised type, heavy outlines,
 * text over busy chart backgrounds.
 *
 * So: when the classifier says a title is present and OCR came back empty, look at the
 * frames and read it. A few frames, one cheap call, cached forever.
 */

const fs = require('fs');
const path = require('path');
const { structured } = require('../llm/provider');

const SCHEMA = {
  type: 'object',
  properties: {
    has_title: {
      type: 'boolean',
      description: 'True only if a burned-in HEADLINE is present — not captions, not platform UI.',
    },
    title: { type: 'string', description: 'The headline verbatim, or empty.' },
    confidence: { type: 'number', description: '0-1' },
  },
  required: ['has_title', 'title', 'confidence'],
};

const SYSTEM = `You read the burned-in HEADLINE from frames of a trading reel.

A headline is the editor's caption-card text — the hook, usually large, often in a box or
with a heavy outline, and it stays the SAME across frames.

Do NOT return:
- rolling word-by-word subtitles (they change every frame)
- the trading platform's own interface: ticker symbols, prices, axis labels, menu items,
  order-book numbers, account balances, window titles
- watermarks or channel handles
- anything you can only read on one frame

If there is no such headline, set has_title false. A wrong title is worse than none.`;

/** Pick frames most likely to carry the title — headlines usually appear early. */
function pickFrames(framesDir, n = 4) {
  if (!fs.existsSync(framesDir)) return [];
  const all = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
  if (!all.length) return [];
  const idx = [0, 1, 2, Math.min(5, all.length - 1)].filter((i) => i < all.length);
  return [...new Set(idx)].slice(0, n).map((i) => path.join(framesDir, all[i]));
}

async function readTitle(mediaDir) {
  const files = pickFrames(path.join(mediaDir, 'frames'));
  if (!files.length) return { has_title: false, title: null };

  const images = files.map((f) => fs.readFileSync(f).toString('base64'));
  const r = await structured({
    system: SYSTEM,
    schema: SCHEMA,
    toolName: 'read_title',
    images,
    userText: 'Read the burned-in headline from these frames, if there is one.',
  });

  const d = r.data;
  const title = String(d.title || '').trim();
  // Guard against the model returning chrome anyway.
  if (!d.has_title || title.length < 8 || (d.confidence ?? 1) < 0.4) {
    return { has_title: false, title: null };
  }
  return { has_title: true, title, confidence: d.confidence };
}

module.exports = { readTitle };
