/**
 * The "band" treatment: the whole 16:9 source sits as a strip on a black 9:16 canvas,
 * with the title plate in the space above it.
 *
 * This is deliberately NOT the re-composed layout. Some reference reels — rp.profits among
 * them — keep the source frame intact, webcam inset and all, and use the surrounding black
 * as negative space for the headline. Cropping or re-stacking those would destroy the look.
 *
 * The band is full canvas width, so its height follows from the source aspect: a 16:9
 * source on a 1080-wide canvas is 608px tall.
 */

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function resolveVariant(layout, name) {
  const v = layout.variants || {};
  return v[name] || v['band-title-top'];
}

/** Where the video band sits, and how tall it is for this source. */
function bandGeometry(layout, variantName, srcW, srcH) {
  const CW = layout.canvas.width;
  const variant = resolveVariant(layout, variantName);
  const bandH = even(Math.round(CW * (srcH / srcW)));
  return {
    x: 0,
    y: even(variant.videoY ?? Math.round((layout.canvas.height - bandH) / 2)),
    w: CW,
    h: bandH,
    titleY: variant.titleY,
    captionY: variant.captionY,
  };
}

// Rendering lives in band-clip.js (single pass). The per-span renderer that used to be
// here drifted audio 23 ms per join and ran the canvas at 25 fps; it has no callers.
module.exports = { bandGeometry, resolveVariant };
