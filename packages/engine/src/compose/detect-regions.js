/**
 * Find the webcam pane and the screen-share pane inside a single 16:9 frame.
 *
 * WHY: a trading livestream is ONE landscape recording containing both the trader's
 * webcam and their charting platform. Letterboxing that into 9:16 wastes most of the
 * canvas and reads as a reposted YouTube video. The reference reels (rp.profits, tjr)
 * re-compose it: chart on top, trader below, captions over the trader. To do that
 * automatically we have to know where each region is.
 *
 * HOW: temporal variance, no new dependencies. A person talking produces continuous
 * low-magnitude motion across a contiguous area; a chart is static except for occasional
 * candle ticks and cursor moves. Sample frames, measure per-tile variance over time, and
 * the webcam is the dense high-variance blob.
 *
 * Deliberately NOT face detection: opencv isn't installed, the YuNet path needs a venv
 * and a 100MB dependency, and a face gives a point when what's needed is a rectangle.
 */

const { execFileSync } = require('child_process');

const GRID_W = 64;   // analysis resolution — coarse is fine and fast
const GRID_H = 36;

function ffmpegBin() {
  return process.env.FFMPEG_BIN || require('ffmpeg-static');
}

/** Decode N evenly-spaced frames as raw 8-bit grayscale at GRID_W×GRID_H. */
function sampleFrames(videoPath, { count = 24, startSeconds = 0, durationSeconds = null } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', videoPath);
  if (durationSeconds) args.push('-t', String(durationSeconds));
  args.push(
    '-vf', `fps=2,scale=${GRID_W}:${GRID_H}`,
    '-frames:v', String(count),
    '-pix_fmt', 'gray', '-f', 'rawvideo', '-'
  );
  const buf = execFileSync(ffmpegBin(), args, { maxBuffer: 64 * 1024 * 1024 });
  const frameSize = GRID_W * GRID_H;
  const frames = [];
  for (let i = 0; i + frameSize <= buf.length; i += frameSize) {
    frames.push(buf.subarray(i, i + frameSize));
  }
  return frames;
}

/** Per-cell temporal variance across the sampled frames, normalised 0..1. */
function varianceMap(frames) {
  const n = frames.length;
  const size = GRID_W * GRID_H;
  const mean = new Float64Array(size);
  for (const f of frames) for (let i = 0; i < size; i++) mean[i] += f[i];
  for (let i = 0; i < size; i++) mean[i] /= n;

  const vari = new Float64Array(size);
  for (const f of frames) {
    for (let i = 0; i < size; i++) {
      const d = f[i] - mean[i];
      vari[i] += d * d;
    }
  }
  let max = 0;
  for (let i = 0; i < size; i++) { vari[i] = Math.sqrt(vari[i] / n); if (vari[i] > max) max = vari[i]; }
  if (max > 0) for (let i = 0; i < size; i++) vari[i] /= max;
  return vari;
}

/** Largest 4-connected component of cells above `threshold`. */
function largestBlob(map, threshold) {
  const seen = new Uint8Array(GRID_W * GRID_H);
  let best = null;
  const idx = (x, y) => y * GRID_W + x;

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const i = idx(x, y);
      if (seen[i] || map[i] < threshold) continue;
      const stack = [[x, y]];
      seen[i] = 1;
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        count++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          const ni = idx(nx, ny);
          if (seen[ni] || map[ni] < threshold) continue;
          seen[ni] = 1;
          stack.push([nx, ny]);
        }
      }
      if (!best || count > best.count) best = { count, minX, maxX, minY, maxY };
    }
  }
  return best;
}

/**
 * Locate the webcam rectangle. Returns normalised coordinates (0..1) plus a confidence,
 * or null when nothing looks like a webcam (a full-screen chart with no camera, say).
 */
function detectCamRegion(videoPath, opts = {}) {
  const frames = sampleFrames(videoPath, opts);
  if (frames.length < 4) return null;
  const map = varianceMap(frames);

  // Sweep the threshold: too low swallows the whole frame, too high fragments the person.
  for (const threshold of [0.55, 0.45, 0.35, 0.28]) {
    const blob = largestBlob(map, threshold);
    if (!blob) continue;
    const w = (blob.maxX - blob.minX + 1) / GRID_W;
    const h = (blob.maxY - blob.minY + 1) / GRID_H;
    const area = w * h;
    const fill = blob.count / ((blob.maxX - blob.minX + 1) * (blob.maxY - blob.minY + 1));

    // A webcam pane is a solid-ish rectangle occupying a minority of the frame.
    if (area > 0.02 && area < 0.6 && fill > 0.35) {
      return {
        x: blob.minX / GRID_W,
        y: blob.minY / GRID_H,
        w, h,
        confidence: +(fill * Math.min(1, area / 0.12)).toFixed(3),
        threshold,
      };
    }
  }
  return null;
}

/**
 * Mean variance per column — the profile that actually locates the split.
 *
 * Using the high-variance BLOB directly was wrong: variance peaks on the talking face
 * while the body, chair and background behind the trader are static, so the blob captured
 * only the head and the "camera pane" clipped everything below the chin. Verified against
 * a drawn overlay on real footage. The panes in a trading stream are full-height vertical
 * bands, so what matters is WHERE THE BAND ENDS, not where the motion is densest.
 */
function columnProfile(map) {
  const cols = new Float64Array(GRID_W);
  for (let x = 0; x < GRID_W; x++) {
    let sum = 0;
    for (let y = 0; y < GRID_H; y++) sum += map[y * GRID_W + x];
    cols[x] = sum / GRID_H;
  }
  return cols;
}

/**
 * Find the vertical boundary that best separates the camera band from the screen band,
 * by maximising the difference of means either side (a 1-D Otsu-style split).
 */
function bestVerticalSplit(cols) {
  const n = cols.length;
  let best = { x: -1, score: 0, camSide: 'left' };
  // Ignore the outer 15% — a split there would leave a band too thin to be a pane.
  for (let i = Math.floor(n * 0.15); i < Math.floor(n * 0.85); i++) {
    let lSum = 0, rSum = 0;
    for (let x = 0; x < i; x++) lSum += cols[x];
    for (let x = i; x < n; x++) rSum += cols[x];
    const lMean = lSum / i;
    const rMean = rSum / (n - i);
    const score = Math.abs(lMean - rMean);
    if (score > best.score) best = { x: i, score, camSide: lMean > rMean ? 'left' : 'right' };
  }
  return best;
}

/**
 * Find a webcam inset: a compact high-variance blob sitting against a frame corner.
 * Returns null when the moving region is too large or too central to be an inset.
 */
function detectCornerPip(map) {
  for (const threshold of [0.5, 0.4, 0.32, 0.26]) {
    const blob = largestBlob(map, threshold);
    if (!blob) continue;
    const x = blob.minX / GRID_W;
    const y = blob.minY / GRID_H;
    const w = (blob.maxX - blob.minX + 1) / GRID_W;
    const h = (blob.maxY - blob.minY + 1) / GRID_H;
    const area = w * h;
    const fill = blob.count / ((blob.maxX - blob.minX + 1) * (blob.maxY - blob.minY + 1));

    // An inset is small, solid, and touches a corner of the frame.
    const nearRight = x + w > 0.82;
    const nearLeft = x < 0.18;
    const nearBottom = y + h > 0.82;
    const nearTop = y < 0.18;
    const cornered = (nearLeft || nearRight) && (nearTop || nearBottom);

    if (area > 0.015 && area < 0.3 && fill > 0.4 && cornered) {
      // Pad slightly — the blob tracks the face, not the inset's border.
      const pad = 0.03;
      return {
        x: Math.max(0, x - pad), y: Math.max(0, y - pad),
        w: Math.min(1, w + pad * 2), h: Math.min(1, h + pad * 2),
        confidence: +Math.min(1, fill * (area / 0.06)).toFixed(3),
      };
    }
  }
  return null;
}

/**
 * Decide the composition for a source.
 *
 * Returns { mode, cam, screen } where mode is:
 *   'split'      — camera band beside the screen; re-compose into chart-over-trader
 *   'letterbox'  — no distinct camera band; keep the whole frame
 */
function planComposition(videoPath, opts = {}) {
  const frames = sampleFrames(videoPath, opts);
  if (frames.length < 4) {
    return { mode: 'letterbox', cam: null, screen: null, reason: 'not enough frames to analyse' };
  }
  const map = varianceMap(frames);
  const cols = columnProfile(map);
  const split = bestVerticalSplit(cols);

  // A weak separation means there is no distinct camera band — a full-screen chart, or a
  // face filling the frame. Letterbox rather than invent a split.
  if (split.x < 0 || split.score < 0.06) {
    return {
      mode: 'letterbox', cam: null, screen: null,
      reason: `no clear vertical split (separation ${split.score.toFixed(3)})`,
    };
  }

  /**
   * Before falling back to letterbox, check for a CORNER PIP.
   *
   * Many trading streams are a full-screen platform with the webcam as a small inset in a
   * corner — not a side-by-side split. The vertical-split test correctly rejects those, but
   * letterboxing a 16:9 chart into 9:16 leaves the content in a thin strip with most of the
   * canvas black. Finding the inset lets us re-compose instead: chart on top, webcam below.
   *
   * A PIP is exactly what the high-variance blob finds well — a compact moving rectangle
   * against a mostly-static background.
   */
  if (split.x < 0 || split.score < 0.06 || (split.x / GRID_W) < 0.15 || (split.x / GRID_W) > 0.85) {
    const pip = detectCornerPip(map);
    if (pip) {
      return {
        mode: 'pip',
        cam: pip,
        screen: { x: 0, y: 0, w: 1, h: 1 },   // the chart is the whole frame
        confidence: pip.confidence,
      };
    }
  }

  const at = split.x / GRID_W;
  /**
   * Inset the screen edge away from the seam. The analysis grid is 64 cells wide, so the
   * split lands on a ~1.6%-of-frame boundary and a sliver of the webcam bleeds into the
   * chart pane — visible as a dark strip down the left of the rendered chart. Pulling the
   * screen in by one cell costs nothing (charts have margin) and removes the artefact.
   */
  const INSET = 1 / GRID_W;
  const cam = split.camSide === 'left'
    ? { x: 0, y: 0, w: at, h: 1 }
    : { x: at, y: 0, w: 1 - at, h: 1 };
  const screen = split.camSide === 'left'
    ? { x: Math.min(0.9, at + INSET), y: 0, w: Math.max(0.1, 1 - at - INSET), h: 1 }
    : { x: 0, y: 0, w: Math.max(0.1, at - INSET), h: 1 };

  if (screen.w < 0.35 || cam.w < 0.12) {
    // Lopsided bands usually mean this is not a side-by-side layout at all — most often a
    // full-screen platform with the webcam inset in a corner. Try that before giving up.
    const pip = detectCornerPip(map);
    if (pip) {
      return { mode: 'pip', cam: pip, screen: { x: 0, y: 0, w: 1, h: 1 }, confidence: pip.confidence };
    }
    return {
      mode: 'letterbox', cam, screen,
      reason: `bands too lopsided (cam ${cam.w.toFixed(2)}, screen ${screen.w.toFixed(2)}) and no corner inset found`,
    };
  }
  return {
    mode: 'split', cam, screen,
    camSide: split.camSide,
    confidence: +Math.min(1, split.score / 0.2).toFixed(3),
  };
}

module.exports = { planComposition, detectCamRegion, varianceMap, columnProfile, bestVerticalSplit, sampleFrames, GRID_W, GRID_H };
