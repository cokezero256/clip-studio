/**
 * Layout composer — builds the ffmpeg -filter_complex graph for the four locked layouts.
 *
 *   layout-1  9:16 Single   (camera only, banded header/A-roll/footer)
 *   layout-2  9:16 Split    (camera top + screen bottom, caption gap)
 *   layout-3  16:9 Single   (camera only, banded)
 *   layout-4  16:9 Split    (screen fills content, circular camera PIP bottom-right)
 *
 * Geometry comes from config/layouts/*.json so it can be tweaked without touching code.
 *
 * Input convention (matches clip-renderer's arg builder):
 *   input 0 = Camera (always; provides audio)
 *   input 1 = Screen (split layouts only)
 *
 * Returns { videoFilter, frameDims, audioMapFromInputIndex }. videoFilter is a
 * filter_complex graph that ends in the [v] label.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = require('../paths').configPath('layouts');

const LAYOUT_FILES = {
  'layout-1': 'layout-1-vertical-single.json',
  'layout-2': 'layout-2-vertical-split.json',
  'layout-3': 'layout-3-horizontal-single.json',
  'layout-4': 'layout-4-horizontal-split.json',
};

const _cache = {};
function loadLayout(layoutId) {
  if (_cache[layoutId]) return _cache[layoutId];
  const file = LAYOUT_FILES[layoutId];
  if (!file) throw new Error(`Unknown layoutId "${layoutId}"`);
  const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf-8'));
  _cache[layoutId] = cfg;
  return cfg;
}

/** Map an aspect + composition choice to a layout id. */
function pickLayout(aspect, composition) {
  const vert = aspect === '9:16' || aspect === 'vertical';
  const split = composition === 'split';
  if (vert) return split ? 'layout-2' : 'layout-1';
  return split ? 'layout-4' : 'layout-3';
}

function escapeFilterPath(p) {
  return p
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function subFilter(captionAssPath, fontsDir) {
  if (!captionAssPath) return null;
  return `subtitles=${escapeFilterPath(captionAssPath)}` +
    (fontsDir ? `:fontsdir=${escapeFilterPath(fontsDir)}` : '');
}

function screenPrefix(black) {
  // Drop a black first frame from a screen recording and clone the next one back,
  // preserving timing. (Same guard as the legacy split-screen builder.)
  return black ? 'select=gte(n\\,1),tpad=start=1:start_mode=clone,' : '';
}

/**
 * @param {object} o
 * @param {string} o.layoutId
 * @param {string|null} [o.cameraCropExpr]  ffmpeg x-expression for the camera crop; null = center
 * @param {string|null} [o.captionAssPath]
 * @param {string|null} [o.fontsDir]
 * @param {boolean} [o.screenHasBlackFirstFrame=false]
 */
function buildLayoutGraph(o) {
  const {
    layoutId,
    cameraCropExpr = null,
    captionAssPath = null,
    fontsDir = null,
    screenHasBlackFirstFrame = false,
  } = o;
  const cfg = loadLayout(layoutId);
  const W = cfg.canvas.width;
  const H = cfg.canvas.height;
  const camX = cameraCropExpr || '(in_w-1080)/2';
  const sub = subFilter(captionAssPath, fontsDir);
  const sp = screenPrefix(screenHasBlackFirstFrame);

  let chain;

  if (layoutId === 'layout-1') {
    const c = cfg.camera;
    // LETTERBOX the full landscape video at full width (no crop), centered horizontally,
    // pinned just below the title band. Black fills above (title) and below (IG UI zone).
    // Matches the "video window with borders + title band" reference look.
    chain = [
      `[0:v]scale=${W}:-2,setsar=1[cam]`,
      `color=c=black:s=${W}x${H}:d=10000[bg]`,
      `[bg][cam]overlay=(W-w)/2:${c.y}[comp]`,
    ];
  } else if (layoutId === 'layout-2') {
    const c = cfg.camera, s = cfg.screen;
    chain = [
      `[0:v]scale=${c.crop.w}:${c.crop.h}:force_original_aspect_ratio=increase,crop=${c.crop.w}:${c.crop.h}:${camX}:0,setsar=1[cam]`,
      `[1:v]${sp}scale=${s.fit.w}:${s.fit.h}:force_original_aspect_ratio=decrease,pad=${s.fit.w}:${s.fit.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[scr]`,
      `color=c=black:s=${W}x${H}:d=10000[bg]`,
      `[bg][cam]overlay=0:${c.y}[t1]`,
      `[t1][scr]overlay=0:${s.y}[comp]`,
    ];
  } else if (layoutId === 'layout-3') {
    const c = cfg.camera;
    // Scale-to-cover the full-width A-roll band, crop vertically centred.
    chain = [
      `[0:v]scale=${c.crop.w}:${c.crop.h}:force_original_aspect_ratio=increase,crop=${c.crop.w}:${c.crop.h}:(in_w-${c.crop.w})/2:(in_h-${c.crop.h})/2,setsar=1[cam]`,
      `color=c=black:s=${W}x${H}:d=10000[bg]`,
      `[bg][cam]overlay=0:${c.y}[comp]`,
    ];
  } else if (layoutId === 'layout-4') {
    const s = cfg.screen, fh = cfg.floatingHead;
    const d = fh.diameter, r = d / 2;
    const ox = fh.centerX - r, oy = fh.centerY - r;
    // Circular alpha mask via geq (commas escaped for the filtergraph parser).
    const circle =
      `format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':` +
      `a='if(lte((X-${r})*(X-${r})+(Y-${r})*(Y-${r})\\,${r}*${r})\\,255\\,0)'`;
    // Screen COVERS the whole canvas (fill + crop, no black borders); circular head floats on top.
    chain = [
      `[1:v]${sp}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[scr]`,
      `[0:v]scale=${d}:${d}:force_original_aspect_ratio=increase,crop=${d}:${d},${circle},setsar=1[head]`,
      `color=c=black:s=${W}x${H}:d=10000[bg]`,
      `[bg][scr]overlay=0:0[c1]`,
      `[c1][head]overlay=${ox}:${oy}[comp]`,
    ];
  } else {
    throw new Error(`buildLayoutGraph: unhandled layoutId "${layoutId}"`);
  }

  // Burn captions last (or just relabel [comp] → [v]).
  if (sub) chain.push(`[comp]${sub}[v]`);
  else chain.push(`[comp]null[v]`);

  return {
    videoFilter: chain.join(';'),
    frameDims: { width: W, height: H },
    audioMapFromInputIndex: 0,
  };
}

module.exports = { buildLayoutGraph, pickLayout, loadLayout, LAYOUT_FILES };
