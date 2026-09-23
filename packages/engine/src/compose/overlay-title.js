/**
 * Composite the title plate onto a FINISHED clip.
 *
 * WHY AFTER THE CONCAT: a clip is rendered as one span per kept segment and then joined.
 * Drawing the plate during span 0 meant the title lived exactly as long as that span —
 * measured on a real clip, 3.3 seconds of a 29-second video, then gone. Spans are created
 * by silence removal, so their length is arbitrary and has nothing to do with how long a
 * headline should stay up.
 *
 * Applying it once, at the end, makes the duration an explicit choice.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function run(args) {
  const FFMPEG = process.env.FFMPEG_BIN || require('ffmpeg-static');
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err.slice(-1200)}`))));
  });
}

/**
 * @param {number|null} seconds  how long the title stays up; null = the whole clip.
 * @param {number} fadeOut       seconds of fade as it leaves (0 = hard cut).
 */
async function overlayTitle(videoPath, plate, { seconds = null, fadeOut = 0.4 } = {}) {
  if (!plate || !plate.path || !fs.existsSync(plate.path)) return videoPath;

  const x = Math.round(plate.x ?? 0);
  const y = Math.round(plate.y ?? 0);

  // A finite duration gets a soft exit; otherwise the plate simply stays.
  let overlay;
  if (seconds && seconds > 0) {
    const fadeStart = Math.max(0, seconds - fadeOut);
    overlay =
      `[1:v]format=rgba,fade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeOut.toFixed(2)}:alpha=1[plate];` +
      `[0:v][plate]overlay=${x}:${y}:enable='lte(t,${seconds.toFixed(2)})'[v]`;
  } else {
    overlay = `[0:v][1:v]overlay=${x}:${y}[v]`;
  }

  const tmp = `${videoPath}.titled.mp4`;
  await run([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    '-loop', '1', '-i', plate.path,
    '-filter_complex', overlay,
    '-map', '[v]', '-map', '0:a?',
    '-c:v', process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264',
    '-b:v', '5M', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-shortest', '-movflags', '+faststart',
    tmp,
  ]);
  fs.renameSync(tmp, videoPath);
  return videoPath;
}

module.exports = { overlayTitle };
