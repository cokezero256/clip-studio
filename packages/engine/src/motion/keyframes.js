/**
 * Keyframed camera moves (pan / push-in) per pane.
 *
 * THE ASK: in a split-screen trading clip the chart is a screen recording of a whole
 * monitor, and the action — the entry, the stop-loss label — sits off to one side. The
 * editor needs to move and scale the framing over time so the viewer is looking at the
 * thing being talked about. Same for pushing in on the talking head.
 *
 * WHY sendcmd AND NOT AN EXPRESSION: v1 built a nested
 * `if(lt(t,..), lerp(..), if(lt(t,..), ...))` crop expression and capped it at 30 control
 * points because ffmpeg's recursive-descent parser blew up (it failed at 122 points). The
 * cap was treated as a point-count limit, but the real problem is NESTING DEPTH.
 * `sendcmd` sidesteps it entirely: parameters are set as timed commands on a named filter
 * instance, so there is no expression to parse. Measured on the render binary: 604
 * commands driving crop w/h/x/y rendered 150 frames in 0.86s, and 30fps × 60s × 4 params
 * is only ~7.2k commands. No cap, and arbitrary easing becomes possible because the curve
 * is evaluated in JS rather than expressed in ffmpeg syntax.
 *
 * ZOOM IS A SHRINKING CROP over a constant-size output, so the encoder never sees a
 * dimension change and the pane always fills its box exactly.
 */

const EASINGS = {
  linear: (t) => t,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inCubic: (t) => t * t * t,
  hold: () => 0,
};

/** Crop dimensions must be even for yuv420p chroma siting. */
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * THE TIME-ORIGIN INVARIANT.
 *
 * The renderer uses a hybrid seek: it seeks the input to `start - PREROLL` and then trims
 * the output past PREROLL. So filter-graph t=0 is NOT the clip start — it is
 * `start - seekPreroll(start)`. Captions already depend on this (locked by a smoke test:
 * `captionClipStart(s) + seekPreroll(s) === s`). Motion commands run through the SAME
 * graph, so they must use the SAME origin, or camera moves would drift out of sync with
 * captions by up to 0.5s.
 */
function graphTimeFromClipLocal(clipLocalSeconds, startSeconds) {
  const { seekPreroll } = require('../clip-renderer');
  return clipLocalSeconds + seekPreroll(startSeconds);
}

/** Interpolate a pane's keys at clip-local time t. Keys are {t, cx, cy, z, ease}. */
function sampleAt(keys, t) {
  if (!keys.length) return null;
  if (t <= keys[0].t) return { cx: keys[0].cx, cy: keys[0].cy, z: keys[0].z };
  const last = keys[keys.length - 1];
  if (t >= last.t) return { cx: last.cx, cy: last.cy, z: last.z };

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  const raw = span <= 0 ? 1 : (t - a.t) / span;
  // Easing belongs to the segment being entered, so it is read from the DESTINATION key.
  const ease = EASINGS[b.ease || a.ease || 'inOutCubic'] || EASINGS.inOutCubic;
  const p = ease(clamp(raw, 0, 1));
  return {
    cx: a.cx + (b.cx - a.cx) * p,
    cy: a.cy + (b.cy - a.cy) * p,
    z: a.z + (b.z - a.z) * p,
  };
}

/**
 * Turn one pane's keys into timed crop commands.
 *
 * `srcW/srcH` are the source dimensions; `boxW/boxH` the pane's output box. The crop
 * window keeps the BOX aspect so the following `scale` never distorts.
 */
function compilePane(paneId, keys, { srcW, srcH, boxW, boxH, fps, durationSeconds, startSeconds }) {
  if (!keys || keys.length === 0) return { commands: [], static: true };

  // Static when nothing actually moves — emit no commands so the graph stays simple.
  const moves = keys.some(
    (k) => Math.abs(k.z - keys[0].z) > 1e-4 ||
           Math.abs(k.cx - keys[0].cx) > 1e-4 ||
           Math.abs(k.cy - keys[0].cy) > 1e-4
  );

  const boxAspect = boxW / boxH;
  const lines = [];
  let prev = null;
  const frames = Math.ceil(durationSeconds * fps);

  for (let f = 0; f <= frames; f++) {
    const tLocal = f / fps;
    const s = sampleAt(keys, tLocal);
    if (!s) continue;

    const z = Math.max(1, s.z);
    // Largest box-aspect rect that fits the source, then divided by zoom.
    let baseW = srcW;
    let baseH = srcW / boxAspect;
    if (baseH > srcH) { baseH = srcH; baseW = srcH * boxAspect; }

    const cw = even(clamp(baseW / z, 16, srcW));
    const ch = even(clamp(baseH / z, 16, srcH));
    const x = Math.round(clamp(s.cx * srcW - cw / 2, 0, srcW - cw));
    const y = Math.round(clamp(s.cy * srcH - ch / 2, 0, srcH - ch));

    // Only emit a command when a value actually changed — cuts the script by ~60% on
    // slow moves and costs nothing in fidelity.
    const tGraph = graphTimeFromClipLocal(tLocal, startSeconds).toFixed(4);
    if (!prev || prev.cw !== cw) lines.push(`${tGraph} crop@${paneId} w ${cw};`);
    if (!prev || prev.ch !== ch) lines.push(`${tGraph} crop@${paneId} h ${ch};`);
    if (!prev || prev.x !== x)   lines.push(`${tGraph} crop@${paneId} x ${x};`);
    if (!prev || prev.y !== y)   lines.push(`${tGraph} crop@${paneId} y ${y};`);
    prev = { cw, ch, x, y };
  }

  const first = sampleAt(keys, 0);
  return { commands: lines, static: !moves, initial: first };
}

/**
 * Compile every pane's motion into a single sendcmd script.
 * Returns null when nothing moves, so the caller can skip sendcmd entirely.
 */
function compileMotion(motionJson, paneGeometry, { fps, durationSeconds, startSeconds }) {
  if (!motionJson || !motionJson.panes) return null;
  const all = [];
  const panes = {};

  for (const [paneId, pane] of Object.entries(motionJson.panes)) {
    const geo = paneGeometry[paneId];
    if (!geo) continue;
    const r = compilePane(paneId, pane.keys, { ...geo, fps, durationSeconds, startSeconds });
    panes[paneId] = r;
    if (!r.static) all.push(...r.commands);
  }

  if (!all.length) return null;
  // sendcmd requires commands in ascending time order across all targets.
  all.sort((a, b) => parseFloat(a) - parseFloat(b));
  return { script: all.join('\n') + '\n', panes, commandCount: all.length };
}

/**
 * Reduce a dense auto-generated track (e.g. face tracking, which emitted 122 points) to a
 * handful of editable keys via Ramer–Douglas–Peucker. The point is no longer to dodge a
 * parser limit — sendcmd has none — but to hand a human something they can actually adjust.
 */
function simplifyTrack(points, epsilon = 0.012) {
  if (points.length <= 2) return points;
  const perp = (p, a, b) => {
    const dx = b.t - a.t;
    const dy = b.cx - a.cx;
    const den = Math.hypot(dx, dy) || 1e-9;
    return Math.abs(dy * (a.t - p.t) - dx * (a.cx - p.cx)) / den;
  };
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perp(points[i], points[0], points[points.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= epsilon) return [points[0], points[points.length - 1]];
  return [
    ...simplifyTrack(points.slice(0, idx + 1), epsilon).slice(0, -1),
    ...simplifyTrack(points.slice(idx), epsilon),
  ];
}

module.exports = { compileMotion, compilePane, sampleAt, simplifyTrack, graphTimeFromClipLocal, EASINGS };
