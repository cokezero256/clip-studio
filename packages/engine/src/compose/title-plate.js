/**
 * Title plate rendering via the CoreText helper.
 *
 * The title used to be drawn inside the ASS subtitle stream, which meant libass had to
 * render it — and libass cannot draw Apple Color Emoji. Every reference reel's title has
 * one, and they came out as tofu boxes. So the plate is rasterised by CoreText to a
 * transparent PNG and composited as an overlay instead.
 *
 * Two things fall out of that, both useful:
 *   - exact text metrics, replacing the ASS path's 0.6-char-width guess
 *   - known plate geometry, which a drag-to-move/resize editor needs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { binPath, configPath } = require('../paths');
const BIN = binPath('title-plate');
const SRC = binPath('src', 'TitlePlate.swift');

/**
 * Which renderer draws plates on this machine. CoreText (the Swift helper) on macOS —
 * pixel-identical to what every clip so far was made with — and a bundled Skia canvas
 * (@napi-rs/canvas) on Windows and Linux, or wherever swiftc is missing. TITLE_RENDERER=canvas
 * forces the canvas path for testing.
 */
function rendererKind() {
  if (process.env.TITLE_RENDERER === 'canvas') return 'canvas';
  if (process.platform !== 'darwin') return 'canvas';
  try { ensureBinary(); return 'coretext'; } catch { return 'canvas'; }
}

/**
 * Compile on first use, and again whenever the Swift source is newer than the binary — a
 * stale binary would silently ignore every option added to the spec since it was built.
 */
function ensureBinary() {
  if (!fs.existsSync(SRC)) throw new Error(`Title plate source missing: ${SRC}`);
  const fresh = fs.existsSync(BIN) && fs.statSync(BIN).mtimeMs >= fs.statSync(SRC).mtimeMs;
  if (fresh) return BIN;
  execFileSync('swiftc', ['-O', '-o', BIN, SRC], { stdio: ['ignore', 'pipe', 'pipe'] });
  return BIN;
}

const CANVAS_RENDERER_VERSION = 'canvas-v2';   // bump when renderPlateCanvas changes how it draws
let _rendererVersion = null;
function rendererVersion() {
  if (rendererKind() === 'canvas') return CANVAS_RENDERER_VERSION;
  if (_rendererVersion) return _rendererVersion;
  try {
    _rendererVersion = crypto.createHash('sha1').update(fs.readFileSync(SRC)).digest('hex').slice(0, 8);
  } catch { _rendererVersion = 'unknown'; }
  return _rendererVersion;
}

// ── the canvas renderer: same spec in, same PNG + geometry out ──
const hexToRgba = (hex, fallback) => {
  let h = String(hex || '').replace('#', '');
  if (h.length !== 6 && h.length !== 8) return fallback;
  const v = parseInt(h, 16);
  const a = h.length === 8 ? (v & 0xff) / 255 : 1;
  const r = h.length === 8 ? (v >>> 24) & 0xff : (v >>> 16) & 0xff;
  const g = h.length === 8 ? (v >>> 16) & 0xff : (v >>> 8) & 0xff;
  const b = h.length === 8 ? (v >>> 8) & 0xff : v & 0xff;
  return `rgba(${r},${g},${b},${a})`;
};
let canvasFontsRegistered = false;
function registerCanvasFonts(GlobalFonts) {
  if (canvasFontsRegistered) return;
  canvasFontsRegistered = true;
  // Register every catalog font under its full name, which is what the editor stores.
  try {
    const cat = JSON.parse(fs.readFileSync(configPath('captions', 'fonts', 'catalog.json'), 'utf-8'));
    for (const f of cat.fonts || []) {
      const p = path.join(FONTS_DIR, f.file);
      if (fs.existsSync(p)) { try { GlobalFonts.registerFromPath(p, f.name); } catch { /* skip a bad file */ } }
    }
  } catch { /* no catalog */ }
  // Emoji: Skia does not fall back to the system emoji font on its own (measured: 🚀 came out
  // as a tofu box). A bundled colour emoji font (Twemoji Mozilla, CC-BY 4.0) is registered as
  // the fallback family so every platform draws the same glyphs.
  const emoji = path.join(FONTS_DIR, 'emoji', 'TwemojiMozilla.ttf');
  if (fs.existsSync(emoji)) { try { GlobalFonts.registerFromPath(emoji, 'Twemoji Mozilla'); } catch { /* optional */ } }
}
function wrapLines(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).split(/\n/)) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cand = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(cand).width <= maxW) { cur = cand; continue; }
      if (cur) lines.push(cur);
      // A single word wider than the plate is broken by character.
      if (ctx.measureText(word).width > maxW) {
        let piece = '';
        for (const ch of word) {
          if (piece && ctx.measureText(piece + ch).width > maxW) { lines.push(piece); piece = ch; } else piece += ch;
        }
        cur = piece;
      } else cur = word;
    }
    lines.push(cur);
  }
  return lines.length ? lines : [''];
}
/** Mirrors TitlePlate.swift: padding, radius and line layout from the font size. */
function renderPlateCanvas(spec) {
  const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
  registerCanvasFonts(GlobalFonts);
  const scale = spec.scale ?? 1;
  const fontSize = (spec.fontSize ?? 62) * scale;
  const padX = spec.padX ?? fontSize * 0.55;
  const padY = spec.padY ?? fontSize * 0.34;
  const radius = spec.radius ?? fontSize * 0.32;
  const maxWidth = (spec.maxWidth ?? 1080) * scale;
  const textMax = Math.max(40, maxWidth - padX * 2);
  const family = spec.fontName || 'Sequel Sans Bold Head';
  const font = `${fontSize}px "${family}", "Twemoji Mozilla", "Segoe UI Emoji", "Apple Color Emoji", "Segoe UI", "Helvetica Neue", Arial, sans-serif`;

  const m = createCanvas(8, 8).getContext('2d');
  m.font = font;
  const lines = wrapLines(m, spec.text, textMax);
  const lineH = fontSize * 1.2;
  const lineSpacing = (spec.lineSpacing ?? 0) * scale;
  const strokePad = ((spec.strokeWidth ?? 0) / 100) * fontSize;
  const shadowPad = ((spec.shadowBlur ?? 0) + Math.abs(spec.shadowOffsetY ?? 0)) * scale;
  const extra = Math.ceil(strokePad + shadowPad);
  const textW = Math.ceil(Math.max(...lines.map((l) => m.measureText(l).width))) + extra * 2;
  const textH = Math.ceil(lines.length * lineH + (lines.length - 1) * lineSpacing) + extra * 2;
  const boxW = Math.ceil(textW + padX * 2);
  const boxH = Math.ceil(textH + padY * 2);

  const canvas = createCanvas(boxW, boxH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = hexToRgba(spec.fill, 'rgba(255,255,255,1)');
  ctx.beginPath(); ctx.roundRect(0, 0, boxW, boxH, radius); ctx.fill();

  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = boxW / 2;
  const top = padY + extra;
  const each = (fn) => lines.forEach((l, i) => fn(l, cx, top + i * (lineH + lineSpacing) + lineH / 2));
  const shadow = spec.shadowColor && (spec.shadowBlur ?? 0) > 0;
  const setShadow = (on) => {
    ctx.shadowColor = on ? hexToRgba(spec.shadowColor, 'rgba(0,0,0,0.6)') : 'transparent';
    ctx.shadowBlur = on ? (spec.shadowBlur ?? 0) * scale : 0;
    ctx.shadowOffsetY = on ? (spec.shadowOffsetY ?? 0) * scale : 0;
  };
  const outlined = (spec.strokeWidth ?? 0) > 0;
  if (outlined) {
    // Stroke first, at double width, then fill on top — the outline stays outside the glyphs.
    setShadow(shadow);
    ctx.lineJoin = 'round';
    ctx.lineWidth = fontSize * ((spec.strokeWidth * 2) / 100);
    ctx.strokeStyle = hexToRgba(spec.strokeColor, 'rgba(0,0,0,1)');
    each((l, x, y) => ctx.strokeText(l, x, y));
    setShadow(false);
  } else setShadow(shadow);
  ctx.fillStyle = hexToRgba(spec.textColor, 'rgba(0,0,0,1)');
  each((l, x, y) => ctx.fillText(l, x, y));

  fs.writeFileSync(spec.out, canvas.toBuffer('image/png'));
  return { width: boxW, height: boxH, textWidth: textW, textHeight: textH, fontSize, scale, font: family };
}

/** Every font file the editor offers — registered with CoreText so plates are portable. */
const FONTS_DIR = configPath('captions', 'fonts');
function fontFiles() {
  try {
    return fs.readdirSync(FONTS_DIR)
      .filter((f) => /\.(ttf|otf|ttc)$/i.test(f))
      .map((f) => path.join(FONTS_DIR, f));
  } catch { return []; }
}

/**
 * Render a plate PNG. Returns { path, width, height, font }.
 * Cached by content hash — the same title at the same size is rendered once.
 */
function renderPlate({
  text, outDir, fontName = 'Sequel Sans Bold Head', fontSize = 62,
  textColor = '#111111', fill = '#FFFFFF', radius = 22,
  padX = null, padY = null, maxWidth = 980, scale = 1, lineSpacing = 0,
  strokeColor = null, strokeWidth = 0, shadowColor = null, shadowBlur = 0, shadowOffsetY = 0,
}) {
  if (!text || !String(text).trim()) return null;
  const kind = rendererKind();
  fs.mkdirSync(outDir, { recursive: true });

  const spec = {
    text: String(text).trim(), fontName, fontSize, textColor, fill, radius, maxWidth, scale, lineSpacing,
    fontFiles: fontFiles(),
    strokeColor, strokeWidth, shadowColor, shadowBlur, shadowOffsetY,
  };
  if (padX != null) spec.padX = padX;
  if (padY != null) spec.padY = padY;

  // The renderer's own source is part of the key: plates are cached by content, so without it
  // a rebuilt renderer kept serving PNGs drawn by the old one (measured — an outline fix
  // appeared to do nothing because every plate was a cache hit).
  const key = crypto.createHash('sha1')
    .update(rendererVersion())
    .update(JSON.stringify(spec))
    .digest('hex').slice(0, 12);
  const out = path.join(outDir, `title-${key}.png`);
  spec.out = out;

  if (fs.existsSync(out)) {
    // Re-measure cheaply from the cached PNG rather than re-rendering.
    const dims = execFileSync(require('../ffmpeg').FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' })
      .trim().split(',').map(Number);
    return { path: out, width: dims[0], height: dims[1], cached: true };
  }

  const geo = kind === 'canvas'
    ? renderPlateCanvas(spec)
    : JSON.parse(execFileSync(ensureBinary(), [], { input: JSON.stringify(spec), encoding: 'utf8' }));
  return { path: out, width: geo.width, height: geo.height, font: geo.font, cached: false, renderer: kind };
}

module.exports = { renderPlate, ensureBinary, rendererKind, fontFiles, FONTS_DIR, BIN };
