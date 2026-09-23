/**
 * The editor's preview proxy: a small, seek-friendly copy of just the clip's window.
 *
 * WHY. The browser preview skips every cut by seeking, and scrubbing seeks constantly. A
 * seek costs a decode from the previous keyframe, and the downloaded source had one every
 * ~5.3 s — up to five seconds of decoding per cut, which makes cut-skipping stutter and
 * scrubbing lag. The proxy has a keyframe every 10 frames (1/3 s at 30 fps) and covers the
 * clip's range padded both sides, so trim handles can be dragged outward into real footage.
 *
 * Proxy time 0 is source time `origin`; everything the editor does is in source time and
 * converts with that one offset.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegLib = require('../ffmpeg');
const { generatePeaks } = require('../waveform');

const PAD_S = 30;
// v2: adds the filmstrip the timeline's video track draws.
const PROXY_VERSION = 2;
const STRIP_TILE_W = 160;
const STRIP_COLUMNS = 20;

function proxyDir(workDir, clipId) {
  return path.join(workDir, 'editor', clipId);
}

/** Read the proxy manifest if a proxy exists and still covers the wanted range. */
function readProxy(workDir, clipId, range = null) {
  const file = path.join(proxyDir(workDir, clipId), 'proxy.json');
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (m.version !== PROXY_VERSION) return null;
    if (!fs.existsSync(m.video) || !fs.existsSync(m.peaks)) return null;
    if (!m.filmstrip || !fs.existsSync(m.filmstrip.path)) return null;
    if (range && (range.start < m.origin - 0.01 || range.end > m.origin + m.duration + 0.01)) return null;
    return m;
  } catch { return null; }
}

function run(args) {
  const FFMPEG = process.env.FFMPEG_BIN || require('ffmpeg-static');
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err.slice(-800)}`))));
  });
}

/**
 * Build (or reuse) the proxy for a clip window. Returns the manifest:
 * { version, origin, duration, fps, width, height, video, peaks, window }
 */
async function ensureProxy({ sourcePath, workDir, clipId, start, end, pad = PAD_S }) {
  const existing = readProxy(workDir, clipId, { start, end });
  if (existing) return existing;

  const info = await ffmpegLib.probe(sourcePath);
  const fps = info.fps_num / info.fps_den;
  const origin = Math.max(0, start - pad);
  const stop = Math.min(info.duration_seconds || end + pad, end + pad);
  const duration = Math.max(1, stop - origin);

  const dir = proxyDir(workDir, clipId);
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, 'proxy.mp4');
  const tmp = `${video}.partial.mp4`;
  await run([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', origin.toFixed(3), '-t', duration.toFixed(3), '-i', sourcePath,
    // Never upscale; cap at 540p so the proxy stays light on long windows.
    '-vf', 'scale=-2:min(ih\\,540)',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'fastdecode',
    '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-bf', '0', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', tmp,
  ]);
  fs.renameSync(tmp, video);

  const peaks = path.join(dir, 'peaks.json');
  await generatePeaks(video, peaks);

  // One tile per second, in a fixed-column sprite. The timeline picks tile k for second k.
  const count = Math.max(1, Math.ceil(duration));
  const rows = Math.ceil(count / STRIP_COLUMNS);
  const filmstrip = path.join(dir, 'filmstrip.jpg');
  await run([
    '-y', '-hide_banner', '-loglevel', 'error', '-i', video,
    '-vf', `fps=1,scale=${STRIP_TILE_W}:-2,tile=${STRIP_COLUMNS}x${rows}`,
    '-frames:v', '1', '-q:v', '5', filmstrip,
  ]);
  const tileH = Math.round((STRIP_TILE_W * info.height) / info.width / 2) * 2;

  const manifest = {
    version: PROXY_VERSION,
    filmstrip: { path: filmstrip, columns: STRIP_COLUMNS, rows, tileW: STRIP_TILE_W, tileH, secondsPerTile: 1, count },
    origin: +origin.toFixed(3),
    duration: +duration.toFixed(3),
    fps,
    width: info.width,
    height: info.height,
    video,
    peaks,
    window: { start, end },
  };
  fs.writeFileSync(path.join(dir, 'proxy.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

module.exports = { ensureProxy, readProxy, proxyDir, PAD_S };
