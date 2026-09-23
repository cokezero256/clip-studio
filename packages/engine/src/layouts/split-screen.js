/**
 * Split-screen layout builder for clip-renderer.
 *
 * Produces the ffmpeg filtergraph + input arg list for rendering a clip from two
 * source files (Camera + Screen). Two output formats:
 *
 *   - 'split-vertical' (1080×1920, 9:16): optional Title bar / Camera pane (top) /
 *     dark caption band (middle) / Screen pane (bottom). Matches the IG/TikTok
 *     references the user shared (streamers talking + sharing screen).
 *
 *   - 'split-horizontal' (1920×1080, 16:9): Screen fills the frame, Camera is a
 *     360×202 picture-in-picture in the lower-right corner. Captions at lower-third.
 *
 * Audio: Camera (input 0) always provides audio; Screen (input 1) audio is dropped.
 *
 * Caller responsibility: pass `captionAssPath`/`fontsDir` when captions exist; the
 * generator escapes spaces/colons in those paths. Pass `titleText` to draw a static
 * top-bar title (libass already handles this via a separate Dialogue in the .ass).
 *
 * The smart-crop expression for the Camera pane is computed from the same subject
 * trajectory used in single-source vertical renders — caller passes it through as
 * `cameraCropExpr` (or null for center-crop).
 */

const path = require('path');

/**
 * @param {object} opts
 * @param {string} opts.cameraPath         absolute path to Camera.mp4
 * @param {string} opts.screenPath         absolute path to Screen.mp4
 * @param {'split-vertical'|'split-horizontal'} opts.format
 * @param {string|null} [opts.captionAssPath]  absolute path to the .ass subtitle file
 * @param {string|null} [opts.fontsDir]        absolute path to the captions fonts directory
 * @param {string|null} [opts.cameraCropExpr]  ffmpeg x-expression for the Camera pane's smart crop;
 *                                             null = center-crop fallback.
 * @param {boolean} [opts.screenHasBlackFirstFrame=false]
 *   When true, the Screen input's first decoded frame is black (common in screen recordings
 *   that haven't started rendering content yet at the clip's seek point). The fix prepends
 *   `select=gte(n\,1),tpad=start=1:start_mode=clone` to the Screen filter chain: frame 0
 *   is dropped and frame 1 is cloned backward to fill the slot, preserving timing.
 * @returns {{ inputs: string[], videoFilter: string, audioFilter: string|null,
 *             frameDims: {width:number, height:number}, audioMapFromInputIndex: number }}
 */
function buildSplitScreenFilterGraph(opts) {
  const {
    cameraPath, screenPath, format,
    captionAssPath = null, fontsDir = null,
    cameraCropExpr = null,
    screenHasBlackFirstFrame = false,
  } = opts;

  const inputs = [
    '-i', cameraPath,
    '-i', screenPath,
  ];

  if (format === 'split-vertical') {
    return {
      inputs,
      videoFilter: buildSplitVerticalFilter({ captionAssPath, fontsDir, cameraCropExpr, screenHasBlackFirstFrame }),
      audioFilter: null,
      frameDims: { width: 1080, height: 1920 },
      audioMapFromInputIndex: 0, // Camera audio
    };
  }
  if (format === 'split-horizontal') {
    return {
      inputs,
      videoFilter: buildSplitHorizontalFilter({ captionAssPath, fontsDir, cameraCropExpr, screenHasBlackFirstFrame }),
      audioFilter: null,
      frameDims: { width: 1920, height: 1080 },
      audioMapFromInputIndex: 0,
    };
  }
  throw new Error(`Unknown split-screen format: ${format}`);
}

/**
 * Vertical 1080×1920 layout (SPLIT-SCREEN SPEC v1):
 *   y =     0..160   Header band — black; title text lands here if present
 *   y =   160..1120  A-roll / Camera pane (1080×960, smart-cropped face)
 *   y =  1120..1124  Thin black divider (4 px)
 *   y =  1124..1920  B-roll / Screen pane (1080×796, fills edge-to-edge)
 *
 * Captions are anchored INSIDE the A-roll pane (at y≈1040, computed by the caller)
 * rather than floating in the inter-panel gap. This is the spec's headline rule —
 * the previous layout placed captions in a wide black band between panes and they
 * read as floating rather than tied to the speaker.
 */
function buildSplitVerticalFilter({ captionAssPath, fontsDir, cameraCropExpr, screenHasBlackFirstFrame }) {
  const camCropX = cameraCropExpr ? cameraCropExpr : '(in_w-1080)/2';
  const finalLabel = captionAssPath ? 'stacked' : 'v';
  // Frame-1 B-roll guard: when the first decoded frame of Screen.mp4 is black (screen
  // recordings that haven't started rendering content at the seek point), drop it and
  // clone the next valid frame backward using tpad=start_mode=clone. This preserves
  // timing — tpad computes PTS of the clone as first_frame_PTS − frame_duration.
  const screenPrefix = screenHasBlackFirstFrame
    ? 'select=gte(n\\,1),tpad=start=1:start_mode=clone,'
    : '';

  const chain = [
    `[0:v]scale=-2:960,crop=1080:960:${camCropX}:0,setsar=1[cam]`,
    `[1:v]${screenPrefix}scale=1080:796:force_original_aspect_ratio=increase,crop=1080:796,setsar=1[scr]`,
    `color=c=black:s=1080x1920:d=10000[bg]`,
    `[bg][cam]overlay=0:160[t1]`,
    `[t1][scr]overlay=0:1124[${finalLabel}]`,
  ];
  if (captionAssPath) {
    const sub = `subtitles=${escapeFilterPath(captionAssPath)}` +
      (fontsDir ? `:fontsdir=${escapeFilterPath(fontsDir)}` : '');
    chain.push(`[stacked]${sub}[v]`);
  }
  return chain.join(';');
}

/**
 * Horizontal 1920×1080 layout: Screen fills, Camera is a 360×202 PIP in the lower-right.
 */
function buildSplitHorizontalFilter({ captionAssPath, fontsDir, cameraCropExpr, screenHasBlackFirstFrame }) {
  const finalLabel = captionAssPath ? 'composed' : 'v';
  const screenPrefix = screenHasBlackFirstFrame
    ? 'select=gte(n\\,1),tpad=start=1:start_mode=clone,'
    : '';
  const chain = [
    `[0:v]scale=360:-2,setsar=1[cam]`,
    `[1:v]${screenPrefix}scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[scr]`,
    `[scr][cam]overlay=W-w-24:H-h-24[${finalLabel}]`,
  ];
  if (captionAssPath) {
    const sub = `subtitles=${escapeFilterPath(captionAssPath)}` +
      (fontsDir ? `:fontsdir=${escapeFilterPath(fontsDir)}` : '');
    chain.push(`[composed]${sub}[v]`);
  }
  return chain.join(';');
}

/**
 * Escape a path for use inside a single filter argument. The subtitles filter requires
 * `:` and `,` escaped, plus `\` and `[]`. Spaces are fine because the whole `-vf` arg is
 * a single argv string.
 */
function escapeFilterPath(p) {
  return p
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

module.exports = { buildSplitScreenFilterGraph };
