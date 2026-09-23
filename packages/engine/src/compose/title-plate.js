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

let _rendererVersion = null;
function rendererVersion() {
  if (_rendererVersion) return _rendererVersion;
  try {
    _rendererVersion = crypto.createHash('sha1').update(fs.readFileSync(SRC)).digest('hex').slice(0, 8);
  } catch { _rendererVersion = 'unknown'; }
  return _rendererVersion;
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
  const bin = ensureBinary();
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
    const dims = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' })
      .trim().split(',').map(Number);
    return { path: out, width: dims[0], height: dims[1], cached: true };
  }

  const stdout = execFileSync(bin, [], { input: JSON.stringify(spec), encoding: 'utf8' });
  const geo = JSON.parse(stdout);
  return { path: out, width: geo.width, height: geo.height, font: geo.font, cached: false };
}

module.exports = { renderPlate, ensureBinary, fontFiles, FONTS_DIR, BIN };
