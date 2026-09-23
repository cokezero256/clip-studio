/**
 * Where every pane of a 9:16 composition comes from and goes to — as numbers.
 *
 * WHY. The re-composed layouts (chart over trader, trader over chart, full chart + inset)
 * used to exist only as ffmpeg filter strings, so the browser could not preview them and
 * the editor's title/caption positions had nowhere to come from. This module computes the
 * SAME crop → cover-scale → centre-crop the filter chain performs, but returns rectangles:
 * the export builds its filters from them, and the preview draws the video onto a canvas
 * with them. One arithmetic, two consumers.
 *
 * Pure: no disk, no ffmpeg.
 */

const path = require('path');
const fs = require('fs');
const { configPath } = require('../paths');
const { bandGeometry } = require('./band');

const LAYOUT5_PATH = configPath('layouts', 'layout-5-vertical-recompose.json');
const LAYOUT6_PATH = configPath('layouts', 'layout-6-band-title.json');

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

let cache = null;
function layouts() {
  if (cache) return cache;
  cache = {
    band: JSON.parse(fs.readFileSync(LAYOUT6_PATH, 'utf-8')),
    recompose: JSON.parse(fs.readFileSync(LAYOUT5_PATH, 'utf-8')),
  };
  return cache;
}

/** Every format the editor offers, with the group it belongs to. */
function listVariants() {
  const l = layouts();
  const band = Object.keys(l.band.variants).map((id) => ({ id, group: 'band' }));
  const stacked = Object.keys(l.recompose.bands).map((id) => ({ id, group: 'stacked' }));
  const overlay = Object.keys(l.recompose.overlayModes || {}).map((id) => ({ id, group: 'overlay' }));
  return [...band, ...stacked, ...overlay];
}

const isBandVariant = (v) => String(v || '').startsWith('band-');

/**
 * Cover-scale a source region (px) into a destination box and centre-crop, with a vertical
 * anchor (0.5 = centre, 0.35 = a little above centre so a face is not cropped at the chin).
 * Returns the ffmpeg chain numbers AND the part of the region that ends up visible.
 */
function cover(region, box, anchorY) {
  const s = Math.max(box.w / region.w, box.h / region.h);
  const scaled = { w: even(region.w * s), h: even(region.h * s) };
  const offX = Math.round((scaled.w - box.w) / 2);
  const offY = Math.round((scaled.h - box.h) * anchorY);
  // The visible part of the region, in source pixels.
  const visible = {
    x: region.x + offX / s,
    y: region.y + offY / s,
    w: box.w / s,
    h: box.h / s,
  };
  return { scaled, offX, offY, visible };
}

const toPx = (r, srcW, srcH) => ({
  x: even(r.x * srcW), y: even(r.y * srcH), w: even(r.w * srcW), h: even(r.h * srcH),
});

/**
 * The full geometry of one variant.
 *
 * @returns {{
 *   kind: 'band'|'panes', canvas:{width,height},
 *   band?: {x,y,w,h},
 *   panes?: Array<{id:'screen'|'cam', region:{x,y,w,h}, scaled:{w,h}, crop?:{w,h,x,y}, visible:{x,y,w,h}, dst:{x,y,w,h}}>,
 *   titleY:number|null, captionY:number, titleFontSize:number, captionFontSize:number
 * }}
 */
function layoutGeometry(variant, { composition = null, srcW, srcH }) {
  const l = layouts();
  if (isBandVariant(variant)) {
    const geo = bandGeometry(l.band, variant, srcW, srcH);
    return {
      kind: 'band', canvas: l.band.canvas,
      band: { x: geo.x, y: geo.y, w: geo.w, h: geo.h },
      titleY: geo.titleY, captionY: geo.captionY,
      titleFontSize: l.band.title.fontSize, captionFontSize: l.band.caption.fontSize,
    };
  }

  const L = l.recompose;
  const CW = L.canvas.width;
  const CH = L.canvas.height;
  if (!composition || !composition.screen) throw new Error('this format needs the webcam and chart regions — they have not been detected yet');
  const cam = composition.cam || { x: 0.7, y: 0.6, w: 0.3, h: 0.4 };
  const screen = composition.screen;
  const pick = (which) => (which === 'camera' || which === 'cam' ? cam : screen);

  const stacked = L.bands[variant];
  if (stacked) {
    const panes = [];
    for (const [id, which] of [['screen', 'screen'], ['cam', 'camera']]) {
      const band = stacked[which];
      const region = toPx(pick(which), srcW, srcH);
      const c = cover(region, { w: CW, h: band.height }, id === 'cam' ? 0.35 : 0.5);
      panes.push({
        id, region, scaled: c.scaled,
        crop: { w: CW, h: band.height, x: c.offX, y: c.offY },
        visible: c.visible,
        dst: { x: 0, y: band.y, w: CW, h: band.height },
      });
    }
    // Lower band first so the upper paints over the seam; keep the same order the export uses.
    panes.sort((a, b) => b.dst.y - a.dst.y);
    const seam = stacked.screen.y === 0 ? stacked.screen.height : stacked.camera.height;
    return {
      kind: 'panes', canvas: L.canvas, panes,
      titleY: seam, captionY: L.caption.y,
      titleFontSize: L.title.fontSize, captionFontSize: L.caption.fontSize,
    };
  }

  const mode = (L.overlayModes || {})[variant];
  if (!mode) throw new Error(`unknown format ${variant}`);
  const panes = [];
  const baseRegion = toPx(pick(mode.base), srcW, srcH);
  const cb = cover(baseRegion, { w: CW, h: CH }, 0.35);
  panes.push({
    id: mode.base === 'camera' ? 'cam' : 'screen', region: baseRegion, scaled: cb.scaled,
    crop: { w: CW, h: CH, x: cb.offX, y: cb.offY }, visible: cb.visible,
    dst: { x: 0, y: 0, w: CW, h: CH },
  });
  if (mode.inset) {
    const ins = toPx(pick(mode.inset), srcW, srcH);
    const targetW = even(CW * (mode.insetWidth || 0.38));
    const targetH = even(targetW * (ins.h / ins.w));
    const margin = Math.round(CW * 0.035);
    const px = mode.corner && mode.corner.endsWith('left') ? margin : CW - targetW - margin;
    const py = CH - targetH - Math.round(CH * 0.12);
    panes.push({
      id: mode.inset === 'camera' ? 'cam' : 'screen', region: ins, scaled: { w: targetW, h: targetH },
      crop: null, visible: { ...ins },
      dst: { x: px, y: py, w: targetW, h: targetH },
    });
  }
  return {
    kind: 'panes', canvas: L.canvas, panes,
    // No seam in an overlay layout: the headline sits in the upper part of the frame.
    titleY: 260, captionY: L.caption.y,
    titleFontSize: L.title.fontSize, captionFontSize: L.caption.fontSize,
  };
}

/** The ffmpeg video chain for pane layouts, from a labelled input stream to `[comp]`. */
function paneGraph(geo, inLabel, background) {
  const CW = geo.canvas.width;
  const CH = geo.canvas.height;
  const n = geo.panes.length;
  const parts = [`color=c=${background}:s=${CW}x${CH}:r=__FPS__[bg]`];
  parts.push(`[${inLabel}]split=${n}${geo.panes.map((_, i) => `[p${i}]`).join('')}`);
  geo.panes.forEach((p, i) => {
    const r = p.region;
    let chain = `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${p.scaled.w}:${p.scaled.h}`;
    if (p.crop) chain += `,crop=${p.crop.w}:${p.crop.h}:${p.crop.x}:${p.crop.y}`;
    parts.push(`[p${i}]${chain},setsar=1[pane${i}]`);
  });
  let last = 'bg';
  geo.panes.forEach((p, i) => {
    const out = i === n - 1 ? 'comp' : `c${i}`;
    parts.push(`[${last}][pane${i}]overlay=${p.dst.x}:${p.dst.y}${i === 0 ? ':shortest=1' : ''}[${out}]`);
    last = out;
  });
  return parts;
}

module.exports = { layoutGeometry, listVariants, isBandVariant, paneGraph, cover, LAYOUT5_PATH, LAYOUT6_PATH };
