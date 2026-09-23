/**
 * Re-compose a single 16:9 source into a filled 9:16 frame.
 *
 * A trading livestream is one landscape recording holding both the webcam and the charting
 * platform. Letterboxing it into 9:16 leaves the content in a thin strip with black bands
 * top and bottom, which reads as a reposted YouTube video. The reference reels re-stack it:
 * chart on top, trader below, captions over the trader. This builds that.
 *
 * One input, cropped twice — so there is no second file to sync and no drift.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');
const { seekPreroll, captionClipStart } = require('../clip-renderer');

/**
 * Always probe. Assuming 1920x1080 produced `crop=1320:1080` against a source that was
 * actually 640x360 — ffmpeg rejected it with "Invalid too big or non positive size".
 * Region boxes are normalised precisely so they can be applied to any resolution.
 */
function probeDimensions(videoPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', videoPath,
  ], { encoding: 'utf8' }).trim();
  const [w, h] = out.split(',').map((n) => parseInt(n, 10));
  if (!w || !h) throw new Error(`Could not probe dimensions of ${videoPath}`);
  return { width: w, height: h };
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Build the filter graph.
 *
 * Each pane is `crop -> scale(cover) -> crop(to box)`, which fills its band without
 * distortion. The crop instances are NAMED (`crop@screen`, `crop@cam`) so the sendcmd
 * motion compiler can drive them for keyframed pan/zoom — the reason that compiler emits
 * commands against named instances in the first place.
 */
/**
 * Resolve the two bands for the chosen pane order.
 *
 * Both orders exist in the references and they are not interchangeable: rp.profits cuts
 * chart-over-trader, pjtradesnq cuts trader-over-chart. Hardcoding either one is wrong for
 * half the work, so it is a setting.
 */
function resolveBands(layout, paneOrder) {
  const order = paneOrder || layout.paneOrder || 'screen-top';
  const set = layout.bands[order] || layout.bands['screen-top'] || layout.bands;
  return { order, screen: set.screen, camera: set.camera };
}

/** Overlay arrangements: one pane fills the frame, the other rides on top (or is dropped). */
function resolveOverlay(layout, paneOrder) {
  const modes = layout.overlayModes || {};
  return modes[paneOrder] || null;
}

/**
 * Build the graph for an overlay arrangement — full-bleed base, optional inset.
 * Kept separate from the stacked path because the compositing order differs.
 */
function buildOverlayGraph({ srcW, srcH, cam, screen, layout, mode, assPath, fontsDir, plate }) {
  const CW = layout.canvas.width;
  const CH = layout.canvas.height;
  const pick = (which) => (which === 'camera' ? cam : screen);
  const base = pick(mode.base);
  const bx = even(base.x * srcW), bw = even(base.w * srcW);
  const by = even(base.y * srcH), bh = even(base.h * srcH);

  const s = Math.max(CW / bw, CH / bh);
  const parts = [
    `color=c=${layout.background}:s=${CW}x${CH}:d=10000[bg]`,
    `[0:v]crop@base=${bw}:${bh}:${bx}:${by},scale=${even(bw * s)}:${even(bh * s)},` +
      `crop=${CW}:${CH}:(iw-${CW})/2:(ih-${CH})*0.35,setsar=1[base]`,
    `[bg][base]overlay=0:0[comp]`,
  ];
  let last = 'comp';

  if (mode.inset) {
    const ins = pick(mode.inset);
    const iw = even(ins.w * srcW), ih = even(ins.h * srcH);
    const ix = even(ins.x * srcW), iy = even(ins.y * srcH);
    const targetW = even(CW * (mode.insetWidth || 0.38));
    const targetH = even(targetW * (ih / iw));
    const margin = Math.round(CW * 0.035);
    const px = mode.corner && mode.corner.endsWith('left') ? margin : CW - targetW - margin;
    const py = CH - targetH - Math.round(CH * 0.12);
    parts.push(
      `[0:v]crop@cam=${iw}:${ih}:${ix}:${iy},scale=${targetW}:${targetH},setsar=1[inset]`,
      `[${last}][inset]overlay=${px}:${py}[withinset]`
    );
    last = 'withinset';
  }

  if (assPath && fs.existsSync(assPath)) {
    const esc = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const fd = fontsDir ? `:fontsdir=${fontsDir.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}` : '';
    parts.push(`[${last}]subtitles=${esc}${fd}[capped]`);
    last = 'capped';
  }
  if (plate && plate.path && fs.existsSync(plate.path)) {
    const x = Math.round(plate.x ?? (CW - plate.width) / 2);
    const y = Math.round(plate.y ?? 0);
    parts.push(`[${last}][1:v]overlay=${x}:${y}[v]`);
  } else {
    parts.push(`[${last}]null[v]`);
  }
  return parts.join(';');
}

/** Y of the boundary between the two panes — where the reference titles sit. */
function seamY(bands) {
  return bands.screen.y === 0 ? bands.screen.height : bands.camera.height;
}

function buildGraph({ srcW, srcH, cam, screen, layout, assPath, fontsDir, paneOrder, plate }) {
  const CW = layout.canvas.width;
  const CH = layout.canvas.height;
  const bands = resolveBands(layout, paneOrder);
  const sBand = bands.screen;
  const cBand = bands.camera;

  // Source pixel rectangles for each region.
  const sx = even(screen.x * srcW), sw = even(screen.w * srcW);
  const sy = even(screen.y * srcH), sh = even(screen.h * srcH);
  const cx = even(cam.x * srcW), cw = even(cam.w * srcW);
  const cy = even(cam.y * srcH), ch = even(cam.h * srcH);

  // Scale each region to COVER its band, then centre-crop to the band exactly.
  const coverScale = (rw, rh, bw, bh) => {
    const s = Math.max(bw / rw, bh / rh);
    return { w: even(rw * s), h: even(rh * s) };
  };
  const sCover = coverScale(sw, sh, CW, sBand.height);
  const cCover = coverScale(cw, ch, CW, cBand.height);

  // Composite the lower band first so the upper one paints over the seam cleanly.
  const parts = [
    `color=c=${layout.background}:s=${CW}x${CH}:d=10000[bg]`,
    // screen pane
    `[0:v]crop@screen=${sw}:${sh}:${sx}:${sy},scale=${sCover.w}:${sCover.h},` +
      `crop=${CW}:${sBand.height}:(iw-${CW})/2:(ih-${sBand.height})/2,setsar=1[screen]`,
    // camera pane — anchored slightly above centre so heads aren't cropped at the chin
    `[0:v]crop@cam=${cw}:${ch}:${cx}:${cy},scale=${cCover.w}:${cCover.h},` +
      `crop=${CW}:${cBand.height}:(iw-${CW})/2:(ih-${cBand.height})*0.35,setsar=1[cam]`,
    `[bg][screen]overlay=0:${sBand.y}[a]`,
    `[a][cam]overlay=0:${cBand.y}[comp]`,
  ];

  // Captions burn first, then the title plate composites on top — the plate is an opaque
  // card and must not have word captions drawn over it.
  let last = 'comp';
  if (assPath && fs.existsSync(assPath)) {
    const esc = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const fd = fontsDir ? `:fontsdir=${fontsDir.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}` : '';
    parts.push(`[${last}]subtitles=${esc}${fd}[capped]`);
    last = 'capped';
  }

  if (plate && plate.path && fs.existsSync(plate.path)) {
    const x = Math.round(plate.x ?? (CW - plate.width) / 2);
    const y = Math.round(plate.y ?? 0);
    const enable = plate.until != null ? `:enable='lte(t,${plate.until})'` : '';
    parts.push(`[${last}][1:v]overlay=${x}:${y}${enable}[v]`);
  } else {
    parts.push(`[${last}]null[v]`);
  }
  return parts.join(';');
}

function runFfmpeg(args) {
  const FFMPEG = process.env.FFMPEG_BIN || require('ffmpeg-static');
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-1500)}`))
    );
  });
}

/**
 * Render one span of a source as a re-composed 9:16 clip.
 * Uses the same hybrid-seek origin as the caption path, so burned captions stay in sync.
 */
async function renderRecomposedSpan({
  inputPath, startSeconds, endSeconds, outputPath,
  srcW, srcH, cam, screen, layout, assPath, fontsDir, paneOrder, plate = null,
  fadeIn = true, fadeOut = true, motionScript = null,
}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (!srcW || !srcH) {
    const d = probeDimensions(inputPath);
    srcW = d.width; srcH = d.height;
  }
  const PREROLL = seekPreroll(startSeconds);
  const duration = endSeconds - startSeconds;

  const overlayMode = resolveOverlay(layout, paneOrder);
  let graph = overlayMode
    ? buildOverlayGraph({ srcW, srcH, cam, screen, layout, mode: overlayMode, assPath, fontsDir, plate })
    : buildGraph({ srcW, srcH, cam, screen, layout, assPath, fontsDir, paneOrder, plate });
  if (motionScript && fs.existsSync(motionScript)) {
    // sendcmd must precede the filters it drives, on the same chain.
    const esc = motionScript.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
    graph = graph.replace('[0:v]crop@screen', `[0:v]sendcmd=f=${esc},crop@screen`);
  }

  const afades = [];
  if (fadeIn) afades.push('afade=t=in:st=0:d=0.04');
  if (fadeOut) afades.push(`afade=t=out:st=${Math.max(0, duration - 0.04).toFixed(3)}:d=0.04`);

  const tmp = `${outputPath}.partial.mp4`;
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', Math.max(0, captionClipStart(startSeconds)).toFixed(3),
    '-i', inputPath,
  ];
  // The plate is input 1 — a still image looped for the clip's length.
  if (plate && plate.path && fs.existsSync(plate.path)) {
    args.push('-loop', '1', '-i', plate.path);
  }
  args.push(
    '-ss', PREROLL.toFixed(3),
    '-t', duration.toFixed(3),
    '-filter_complex', graph,
    '-map', '[v]', '-map', '0:a?',
  );
  if (afades.length) args.push('-af', afades.join(','));
  args.push(
    '-c:v', process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264',
    '-b:v', '5M', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    tmp
  );

  await runFfmpeg(args);
  fs.renameSync(tmp, outputPath);
  return outputPath;
}

module.exports = {
  renderRecomposedSpan, buildGraph, buildOverlayGraph, probeDimensions,
  resolveBands, resolveOverlay, seamY,
};
