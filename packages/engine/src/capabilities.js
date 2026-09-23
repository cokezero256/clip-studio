/**
 * ffmpeg capability assertion.
 *
 * THE LANDMINE THIS DEFUSES: this machine has two ffmpeg binaries with different feature
 * sets, and the v1 app resolved them inconsistently —
 *
 *   clip-renderer.js : process.env.FFMPEG_BIN || require('ffmpeg-static')   → 6.0
 *   ffmpeg.js        : process.env.FFMPEG_BIN || `which ffmpeg`             → 8.1.2
 *
 * Homebrew's ffmpeg 8.1.2 on this Mac is built WITHOUT libass and WITHOUT libfreetype:
 * `subtitles` and `drawtext` are both "Unknown filter". The vendored ffmpeg-static 6.0
 * has them. So captions worked only because the renderer happened to resolve the vendored
 * binary. Setting FFMPEG_BIN to the Homebrew path would have silently produced
 * caption-less clips with no error.
 *
 * Here the render binary is pinned to the one proven to burn captions, and the process
 * refuses to start if it can't.
 */

const path = require('path');
const { execFileSync } = require('child_process');

/** The render binary MUST have libass. Prefer the vendored build, which does. */
function resolveRenderFfmpeg() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

function hasFilter(bin, name) {
  // NOTE: `ffmpeg -h filter=<name>` exits 0 even when the filter does not exist — it just
  // prints "Unknown filter". Checking the exit code alone silently reports every filter as
  // present, which is exactly the failure this module is meant to catch.
  try {
    const out = execFileSync(bin, ['-hide_banner', '-h', `filter=${name}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return !/Unknown filter/i.test(out) && new RegExp(`Filter\\s+${name}\\b`, 'i').test(out);
  } catch {
    return false;
  }
}

function hasEncoder(bin, name) {
  try {
    const out = execFileSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.includes(name);
  } catch {
    return false;
  }
}

/** Filters without which a render is silently wrong rather than merely failed. */
const REQUIRED_FILTERS = [
  'subtitles',          // caption burn-in — the one that fails silently
  'sendcmd',            // keyframed camera moves
  'crop', 'scale', 'overlay',
  'sidechaincompress',  // music ducking under VO
  'alphamerge',         // rounded/circular PIP masks
  'loudnorm', 'silencedetect',
];

function checkFfmpeg(bin = resolveRenderFfmpeg()) {
  const missing = REQUIRED_FILTERS.filter((f) => !hasFilter(bin, f));
  return {
    bin,
    ok: missing.length === 0,
    missing,
    videotoolbox: hasEncoder(bin, 'h264_videotoolbox'),
  };
}

/**
 * The two external tools and the model the pipeline needs beyond ffmpeg. A fresh clone on
 * another machine produced "spawn yt-dlp ENOENT" five times in the job log and nothing else;
 * this says which tool is missing and how to install it on THIS platform.
 */
const fs = require('fs');
const os = require('os');

const HINTS = {
  darwin: {
    ytdlp: 'brew install yt-dlp',
    whisper: 'brew install whisper-cpp',
  },
  win32: {
    ytdlp: 'winget install yt-dlp   (or: pip install yt-dlp)',
    whisper: 'download whisper-cli.exe from github.com/ggml-org/whisper.cpp/releases and put it on PATH (or set WHISPER_BIN)',
  },
  linux: {
    ytdlp: 'pip install yt-dlp   (or your package manager)',
    whisper: 'build whisper.cpp (github.com/ggml-org/whisper.cpp) and put whisper-cli on PATH (or set WHISPER_BIN)',
  },
};
const modelHint = (model) =>
  `curl -L --create-dirs -o "${model}" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${path.basename(model)}`;

function onPath(bin) {
  try {
    execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    return true;
  } catch (err) {
    // A binary that exists but dislikes --version still counts; only "not found" is missing.
    return !(err && (err.code === 'ENOENT' || /ENOENT|not found/i.test(String(err.message))));
  }
}

function checkTools() {
  const platform = process.platform;
  const hints = HINTS[platform] || HINTS.linux;
  const tools = require('./tools');
  const ytdlpBin = tools.resolveYtdlp();
  const whisperBin = tools.resolveWhisper();
  const model = tools.DEFAULT_MODEL;
  return {
    platform,
    ytdlp: { bin: ytdlpBin || 'yt-dlp', ok: !!ytdlpBin, hint: hints.ytdlp, what: 'downloading YouTube / Instagram links (local files still work)' },
    whisper: { bin: whisperBin || 'whisper-cli', ok: !!whisperBin, hint: hints.whisper, what: 'transcription — nothing works without it' },
    model: { path: model, ok: fs.existsSync(model), hint: modelHint(model), what: 'the whisper model file' },
    // Titles render through CoreText on macOS and through a bundled canvas everywhere else.
    titlePlate: { ok: true, what: 'title rendering' },
  };
}

/** Call once at worker startup. Fails loudly and says exactly how to fix it. */
function assertCapabilities({ bin, verbose = false } = {}) {
  const r = checkFfmpeg(bin);
  if (!r.ok) {
    throw new Error(
      `ffmpeg at ${r.bin} is missing required filters: ${r.missing.join(', ')}.\n` +
      (r.missing.includes('subtitles')
        ? 'This build has no libass, so captions would be dropped SILENTLY rather than erroring.\n'
        : '') +
      'Point FFMPEG_BIN at a build with libass (the bundled ffmpeg-static has it), or unset ' +
      'FFMPEG_BIN to use the bundled binary.'
    );
  }
  if (verbose) {
    console.log(`[capabilities] ffmpeg ok: ${r.bin}${r.videotoolbox ? ' (videotoolbox)' : ' (software encode)'}`);
  }
  const tools = checkTools();
  for (const key of ['whisper', 'model']) {
    if (!tools[key].ok) {
      throw new Error(`${key === 'model' ? 'whisper model' : 'whisper-cli'} not found (${tools[key].path || tools[key].bin}) — it is ${tools[key].what}.\n  The worker installs it on start; if that failed, install it yourself: ${tools[key].hint}`);
    }
  }
  if (!tools.ytdlp.ok) console.warn(`[capabilities] WARNING: yt-dlp not found — ${tools.ytdlp.what}. Install: ${tools.ytdlp.hint}`);
  return { ...r, tools };
}

module.exports = { assertCapabilities, checkFfmpeg, checkTools, resolveRenderFfmpeg, REQUIRED_FILTERS };
