/**
 * Locate the webcam and the screen-share by LOOKING at a frame.
 *
 * WHY NOT VARIANCE: the temporal-variance detector works when the background is static —
 * proven on a side-by-side source where it found the split line exactly. But trading
 * streams often run a live order-flow heatmap that animates continuously, and then the
 * CHART has more motion than the person. Measured on such a source: the variance map's
 * strongest blob was the chart, and the webcam inset was indistinguishable.
 *
 * One vision call per source settles it. It runs once, is cached on the source, and costs
 * a fraction of a cent — far cheaper than shipping a badly-framed clip.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { structured } = require('../llm/provider');

const SCHEMA = {
  type: 'object',
  properties: {
    layout: {
      type: 'string',
      enum: ['side_by_side', 'webcam_inset', 'fullscreen_screen', 'fullscreen_person', 'other'],
      description: 'How the frame is arranged.',
    },
    has_webcam: { type: 'boolean' },
    webcam: {
      type: 'object',
      description: 'Webcam rectangle as fractions of the frame, 0-1, origin top-left.',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        w: { type: 'number' }, h: { type: 'number' },
      },
      required: ['x', 'y', 'w', 'h'],
    },
    screen: {
      type: 'object',
      description: 'The chart/platform rectangle, same convention.',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        w: { type: 'number' }, h: { type: 'number' },
      },
      required: ['x', 'y', 'w', 'h'],
    },
    notes: { type: 'string', description: 'One sentence on what is actually on screen.' },
  },
  required: ['layout', 'has_webcam', 'webcam', 'screen', 'notes'],
};

const SYSTEM = `You locate the two panes in a frame from a trading livestream.

There is usually a trading chart or platform, and often a webcam showing the trader. Give
each as a rectangle in FRACTIONS of the frame (0-1), origin top-left.

Layouts you will see:
- side_by_side      person occupies a full-height band beside the chart
- webcam_inset      a small webcam rectangle sitting over a full-screen chart, usually in a corner
- fullscreen_screen chart only, no webcam visible
- fullscreen_person person only, no chart

Be precise about the webcam rectangle — include the whole inset, not just the face. If
there is no webcam, set has_webcam false and give the webcam rectangle as zeros.`;

/** Grab a representative frame as base64 JPEG. */
function grabFrame(videoPath, atSeconds) {
  const tmp = path.join(require('os').tmpdir(), `pane-${Date.now()}.jpg`);
  execFileSync(process.env.FFMPEG_BIN || require('ffmpeg-static'), [
    '-y', '-v', 'error', '-ss', String(atSeconds), '-i', videoPath,
    '-vframes', '1', '-vf', 'scale=960:-2', '-q:v', '3', tmp,
  ]);
  const b64 = fs.readFileSync(tmp).toString('base64');
  try { fs.unlinkSync(tmp); } catch {}
  return b64;
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const sane = (r) => r && r.w > 0.02 && r.h > 0.02;

/**
 * Returns a composition plan in the same shape planComposition produces, so it is a
 * drop-in replacement: { mode, cam, screen, ... }
 */
async function locatePanes(videoPath, { atSeconds = 60, samples = 2 } = {}) {
  const frames = [];
  for (let k = 0; k < samples; k++) frames.push(grabFrame(videoPath, atSeconds + k * 45));

  const r = await structured({
    system: SYSTEM,
    schema: SCHEMA,
    toolName: 'locate_panes',
    images: frames,
    userText: 'Locate the webcam and the chart in these frames from the same stream.',
  });
  const d = r.data;

  const cam = {
    x: clamp01(d.webcam?.x), y: clamp01(d.webcam?.y),
    w: clamp01(d.webcam?.w), h: clamp01(d.webcam?.h),
  };
  const screen = {
    x: clamp01(d.screen?.x), y: clamp01(d.screen?.y),
    w: clamp01(d.screen?.w) || 1, h: clamp01(d.screen?.h) || 1,
  };

  if (!d.has_webcam || !sane(cam)) {
    return { mode: 'letterbox', cam: null, screen, reason: d.notes || 'no webcam found', source: 'vision' };
  }
  // A webcam that fills a full-height band is a side-by-side split; a small one is an inset.
  const mode = d.layout === 'side_by_side' || cam.h > 0.75 ? 'split' : 'pip';
  return { mode, cam, screen, camSide: cam.x < 0.5 ? 'left' : 'right', notes: d.notes, source: 'vision', confidence: 0.9 };
}

module.exports = { locatePanes };
