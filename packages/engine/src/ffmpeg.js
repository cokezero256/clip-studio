const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Use system binaries if available (avoids macOS Gatekeeper quarantine on bundled binaries).
// Override via env (FFMPEG_BIN / FFPROBE_BIN) if you have a preferred path.
const { execSync } = require('child_process');
function resolveSystemBin(name, fallback) {
  try {
    const p = execSync('which ' + name, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (p) return p;
  } catch (_) {}
  return fallback;
}
const FFMPEG  = process.env.FFMPEG_BIN  || resolveSystemBin('ffmpeg',  require('ffmpeg-static'));
const FFPROBE = process.env.FFPROBE_BIN || resolveSystemBin('ffprobe', require('ffprobe-static').path);

// ── Cancellation support ──
// The pipeline runs inside the dashboard's Node process, so we can't kill it by pid
// (that's the server itself). Instead we track every spawned ffmpeg child here and let
// cancelAll() SIGKILL them — that makes the in-flight run() reject and the pipeline abort.
const activeProcs = new Set();
let cancelRequested = false;

/** Reset the cancel flag — call at the start of every new pipeline run. */
function resetCancel() {
  cancelRequested = false;
}

/** True if a cancel was requested for the current run. */
function isCancelled() {
  return cancelRequested;
}

/** Kill all in-flight ffmpeg children, aborting the current run. */
function cancelAll() {
  cancelRequested = true;
  for (const proc of activeProcs) {
    try { proc.kill('SIGKILL'); } catch {}
  }
  activeProcs.clear();
}

function run(bin, args, { timeout = 30 * 60 * 1000, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    activeProcs.add(proc);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onStdout) { try { onStdout(s); } catch {} }
    });
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${timeout}ms`));
    }, timeout);
    proc.on('close', (code) => {
      clearTimeout(timer);
      activeProcs.delete(proc);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else if (cancelRequested) {
        const e = new Error('Cancelled by user.');
        e.cancelled = true;
        reject(e);
      } else {
        reject(new Error(`${bin} exited ${code}\n${stderr.slice(-2000)}`));
      }
    });
    proc.on('error', (err) => { activeProcs.delete(proc); reject(err); });
  });
}

/**
 * Build a temp filename that PRESERVES the original extension. ffmpeg picks its output
 * muxer from the extension, so naming a temp file `foo.mp4.tmp` makes ffmpeg fail with
 * "Unable to find a suitable output format". `foo.partial.mp4` keeps mp4 detection working.
 */
function tmpPath(finalPath) {
  const ext = path.extname(finalPath);
  return finalPath.slice(0, -ext.length) + '.partial' + ext;
}

// Codecs where every frame is a keyframe — concat-demuxer stream-copy is
// frame-accurate without any re-encode. We skip the slow normalize step for these.
const INTRA_FRAME_CODECS = new Set([
  'prores', 'prores_ks', 'prores_aw', 'prores_raw',
  'dnxhd', 'dnxhr',
  'mjpeg',
  'rawvideo', 'r210', 'v210', 'v308', 'v408', 'v410',
  'cineform',
]);

async function probe(input) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    input,
  ]);
  const data = JSON.parse(stdout);
  const v = data.streams.find((s) => s.codec_type === 'video');
  const a = data.streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error(`No video stream in ${input}`);

  const [num, den] = (v.r_frame_rate || '30/1').split('/').map(Number);
  const fps = num / den;
  const duration = parseFloat(data.format.duration);

  // is_vfr from avg vs r_frame_rate is unreliable — many CFR camera files have tiny float
  // drift in avg_frame_rate that triggers a false positive. Only flag VFR if the drift > 1%.
  let is_vfr = false;
  if (v.avg_frame_rate && v.r_frame_rate && v.avg_frame_rate !== v.r_frame_rate) {
    const [an, ad] = v.avg_frame_rate.split('/').map(Number);
    const avgFps = an / ad;
    is_vfr = Math.abs(avgFps - fps) / fps > 0.01;
  }

  return {
    fps_num: num,
    fps_den: den,
    fps,
    width: parseInt(v.width, 10),
    height: parseInt(v.height, 10),
    duration_seconds: duration,
    audio_sample_rate: a ? parseInt(a.sample_rate, 10) : null,
    audio_channels: a ? a.channels : null,
    is_vfr,
    codec: v.codec_name,
    is_intra_frame: INTRA_FRAME_CODECS.has(v.codec_name),
    container_ext: containerExtFor(v.codec_name, input),
  };
}

function containerExtFor(codec, inputPath) {
  // ProRes/DNxHR/cineform live happily in .mov; H.264/HEVC in .mp4
  if (['prores', 'prores_ks', 'prores_aw', 'prores_raw', 'dnxhd', 'dnxhr', 'cineform'].includes(codec)) return '.mov';
  return path.extname(inputPath).toLowerCase() || '.mp4';
}

/**
 * Smart-normalize: pick the fastest correct strategy for this source.
 *
 *  - Intra-frame codecs (ProRes, DNxHR, etc.): every frame is a keyframe already, so we
 *    just remux into the correct container (instant, lossless).
 *  - VFR sources (phone clips, screen recordings): force CFR with re-encode.
 *  - Otherwise: re-encode with keyframes every 1s so concat-demuxer is frame-accurate.
 *
 * Returns { path, didReencode } so the caller can log what happened.
 */
async function normalize(input, output, probeResult, { onProgress } = {}) {
  // Parse ffmpeg's -progress stream (key=value lines on stdout) into a percent so the
  // caller can show a live bar. `out_time_us` is the encoded position in microseconds.
  const totalSec = probeResult.duration_seconds || 0;
  const makeProgressParser = () => {
    if (!onProgress || !totalSec) return undefined;
    let buf = '';
    return (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m) {
          const sec = Number(m[1]) / 1_000_000;
          const pct = Math.min(99, Math.round((sec / totalSec) * 100));
          try { onProgress(pct, sec); } catch {}
        }
      }
    };
  };
  const progressArgs = onProgress && totalSec ? ['-progress', 'pipe:1', '-nostats'] : [];
  // ATOMIC WRITE: encode to a .tmp sibling, then rename to the final path on success.
  // A partially-written file never appears at `output`, so cache checks (which look at
  // `output` existence) can't be fooled by an in-progress encode. If the encoder crashes
  // or the process gets killed, the .tmp is left behind and the next run starts fresh.
  const tmpOutput = tmpPath(output);
  // Cleanup any stale tmp from a previous failed run.
  try { fs.unlinkSync(tmpOutput); } catch {}

  if (probeResult.is_intra_frame && !probeResult.is_vfr) {
    // Fast path: just copy streams into the canonical container (no re-encode).
    // +faststart moves the moov atom to the front so browsers can play without
    // downloading the whole file first.
    await run(FFMPEG, ['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', tmpOutput]);
    fs.renameSync(tmpOutput, output);
    return { path: output, didReencode: false };
  }

  // Slow path: re-encode for CFR + frequent keyframes.
  // Cap to 1080p — 4K is overkill for social clips and makes VideoToolbox hang on some files.
  const { fps_num, fps_den, width, height } = probeResult;
  const isMac = process.platform === 'darwin';
  const MAX_WIDTH = 1920;
  const scaleFilter = width > MAX_WIDTH
    ? `scale=${MAX_WIDTH}:-2,fps=${fps_num}/${fps_den},format=yuv420p`
    : `fps=${fps_num}/${fps_den},format=yuv420p`;
  const effectiveWidth = Math.min(width, MAX_WIDTH);
  const effectiveHeight = width > MAX_WIDTH ? Math.round(height * (MAX_WIDTH / width) / 2) * 2 : height;
  const targetBitrate = pickBitrateForResolution(effectiveWidth, effectiveHeight);

  const sharedArgs = [
    '-y', '-i', input,
    '-vf', scaleFilter,
    '-r', String(fps_num / fps_den),
    '-vsync', 'cfr',
    '-g', String(Math.round(fps_num / fps_den)),
    '-force_key_frames', 'expr:gte(t,n_forced)',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k',
    '-movflags', '+faststart',
  ];

  if (isMac) {
    // Trust the hardware encoder. VideoToolbox runs faster than real-time even on 4K,
    // so a 36-min source finishes well inside this window. The old 90s timeout was far
    // too short and forced a fall back to slow software encoding (libx264) — the single
    // biggest cause of multi-minute normalize times. Give it 10 minutes.
    try {
      await run(FFMPEG, [
        ...sharedArgs,
        '-c:v', 'h264_videotoolbox', '-b:v', targetBitrate, '-tag:v', 'avc1',
        ...progressArgs,
        tmpOutput,
      ], { timeout: 600_000, onStdout: makeProgressParser() });
      fs.renameSync(tmpOutput, output);
      return { path: output, didReencode: true };
    } catch (vtErr) {
      try { fs.unlinkSync(tmpOutput); } catch {}
      // Only reached if VideoToolbox genuinely errors (codec unsupported), not a timeout.
      console.warn(`[normalize] VideoToolbox failed (${vtErr.message.slice(0, 80)}), falling back to libx264`);
    }
  }

  // libx264 — primary on Linux/Windows, last-resort fallback on Mac. Use veryfast so the
  // fallback (when it happens) is as quick as possible.
  await run(FFMPEG, [
    ...sharedArgs,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    ...progressArgs,
    tmpOutput,
  ], { onStdout: makeProgressParser() });
  fs.renameSync(tmpOutput, output);
  return { path: output, didReencode: true };
}

function pickBitrateForResolution(width, height) {
  const px = width * height;
  if (px >= 3840 * 2160 * 0.9) return '30M'; // 4K UHD
  if (px >= 2560 * 1440 * 0.9) return '16M'; // QHD
  if (px >= 1920 * 1080 * 0.9) return '10M'; // 1080p
  if (px >= 1280 * 720 * 0.9) return '5M';   // 720p
  return '3M';
}

/**
 * Encode a small, shareable H.264 preview from a (possibly huge) source like ProRes.
 * Optionally downscales to 1080p for ProRes 4K so the preview is reasonably sized.
 * Uses Apple's hardware encoder (videotoolbox) on macOS for ~5-10× speedup.
 */
async function encodeShareablePreview(input, output, { maxHeight = 1080 } = {}) {
  const isMac = process.platform === 'darwin';
  const codec = isMac ? 'h264_videotoolbox' : 'libx264';
  // Atomic write (see normalize() for the rationale).
  const tmpOutput = tmpPath(output);
  try { fs.unlinkSync(tmpOutput); } catch {}
  const args = [
    '-y',
    '-i', input,
    '-vf', `scale=-2:'min(${maxHeight},ih)'`,
    '-c:v', codec,
    ...(isMac ? ['-b:v', '8M', '-tag:v', 'avc1'] : ['-preset', 'fast', '-crf', '20']),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-fflags', '+genpts',
    tmpOutput,
  ];
  await run(FFMPEG, args);
  fs.renameSync(tmpOutput, output);
  return output;
}

/**
 * Detect silence regions for cut-boundary snapping.
 * Returns [{start, end}] in seconds where audio is below threshold for >= duration.
 */
async function detectSilence(input, { threshold_db = -35, min_duration_s = 0.05 } = {}) {
  const { stderr } = await run(FFMPEG, [
    '-i', input,
    '-af', `silencedetect=noise=${threshold_db}dB:d=${min_duration_s}`,
    '-f', 'null',
    '-',
  ]);
  const regions = [];
  const startRe = /silence_start: ([\d.]+)/g;
  const endRe = /silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g;
  const starts = [];
  let m;
  while ((m = startRe.exec(stderr)) !== null) starts.push(parseFloat(m[1]));
  let i = 0;
  while ((m = endRe.exec(stderr)) !== null) {
    const end = parseFloat(m[1]);
    const duration = parseFloat(m[2]);
    const start = starts[i++] ?? Math.max(0, end - duration);
    regions.push({ start, end, duration });
  }
  return regions;
}

/**
 * Detect silence in a WINDOW of the source [startSec, endSec] only — fast (input-seek,
 * decode just that span) so it's cheap to call per clip render. Returns regions in
 * ABSOLUTE source seconds (clip-relative detection + startSec offset).
 */
async function detectSilenceWindow(input, startSec, endSec, { threshold_db = -28, min_duration_s = 0.03 } = {}) {
  const dur = Math.max(0, endSec - startSec);
  if (dur <= 0) return [];
  const { stderr } = await run(FFMPEG, [
    '-ss', startSec.toFixed(3),
    '-i', input,
    '-t', dur.toFixed(3),
    '-vn',
    '-af', `silencedetect=noise=${threshold_db}dB:d=${min_duration_s}`,
    '-f', 'null',
    '-',
  ]);
  const regions = [];
  const startRe = /silence_start: (-?[\d.]+)/g;
  const endRe = /silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g;
  const starts = [];
  let m;
  while ((m = startRe.exec(stderr)) !== null) starts.push(Math.max(0, parseFloat(m[1])));
  let i = 0;
  while ((m = endRe.exec(stderr)) !== null) {
    const end = parseFloat(m[1]);
    const duration = parseFloat(m[2]);
    const s = starts[i++] ?? Math.max(0, end - duration);
    // Convert clip-relative → absolute source time.
    regions.push({ start: s + startSec, end: end + startSec, duration });
  }
  return regions;
}

/**
 * Cut a segment via stream-copy (BOTH video and audio). Fast, lossless, and — importantly —
 * does NOT add AAC encoder priming samples per segment. Re-encoding audio per cut accumulates
 * ~21ms of padding per segment, so 66 cuts → ~1.4s of A/V drift by the end. Stream-copy avoids
 * this entirely.
 *
 * Trade-off: micro-clicks at cut boundaries are possible because cuts may land mid-AAC-frame.
 * If the user reports audible clicks, the right fix is a single post-concat audio re-encode
 * with crossfades (one encode pass, no per-segment priming accumulation), NOT per-segment
 * re-encoding.
 */
async function cutSegment(input, startSec, endSec, output) {
  if (endSec <= startSec) {
    throw new Error(`Invalid cut: end (${endSec}) <= start (${startSec})`);
  }
  const duration = endSec - startSec;
  await run(FFMPEG, [
    '-y',
    '-ss', startSec.toFixed(3),
    '-i', input,
    '-t', duration.toFixed(3),
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    output,
  ]);
  return output;
}

/**
 * Concat a list of pre-cut segments via the concat demuxer. Stream-copy, no re-encode.
 */
async function concat(segmentPaths, output) {
  if (!segmentPaths.length) throw new Error('concat: no segments');

  const listFile = path.join(os.tmpdir(), `concat-${Date.now()}-${process.pid}.txt`);
  const lines = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listFile, lines, 'utf-8');

  // Atomic write — see normalize() for rationale.
  const tmpOutput = tmpPath(output);
  try { fs.unlinkSync(tmpOutput); } catch {}

  try {
    await run(FFMPEG, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      tmpOutput,
    ]);
    fs.renameSync(tmpOutput, output);
  } finally {
    try { fs.unlinkSync(listFile); } catch {}
  }
  return output;
}

/**
 * Sample-accurate concat of pre-rendered keeper segments via the concat FILTER.
 *
 * Unlike the demuxer concat (stream-copy), this decodes every segment and re-encodes ONCE,
 * so there are NO per-segment AAC encoder-priming gaps at the joins — the cause of the
 * ~20-40ms silence/click heard at each cut. Combined with disabling internal fade-to-silence
 * (only the outer edges fade), cuts join cleanly with no audible dip.
 *
 * All segments must share resolution / pixel format / audio layout — they do, because they
 * were all rendered through the same layout.
 */
async function concatAccurate(segmentPaths, output) {
  if (!segmentPaths.length) throw new Error('concatAccurate: no segments');
  if (segmentPaths.length === 1) { fs.copyFileSync(segmentPaths[0], output); return output; }

  const isMac = process.platform === 'darwin';
  const codec = isMac ? 'h264_videotoolbox' : 'libx264';
  const n = segmentPaths.length;
  const inputs = [];
  for (const p of segmentPaths) inputs.push('-i', p);
  let streams = '';
  for (let i = 0; i < n; i++) streams += `[${i}:v:0][${i}:a:0]`;
  const filter = `${streams}concat=n=${n}:v=1:a=1[v][a]`;

  const tmpOutput = tmpPath(output);
  try { fs.unlinkSync(tmpOutput); } catch {}
  await run(FFMPEG, [
    '-y',
    ...inputs,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', codec,
    ...(isMac ? ['-b:v', '10M', '-tag:v', 'avc1'] : ['-preset', 'fast', '-crf', '19']),
    '-c:a', 'aac', '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    tmpOutput,
  ]);
  fs.renameSync(tmpOutput, output);
  return output;
}

/**
 * Snap a cut boundary to the nearest local audio minimum (silence) within ±window_ms.
 * Falls back to the original boundary if no silence is nearby.
 */
function snapToSilence(targetSec, silenceRegions, window_ms = 150) {
  const window_s = window_ms / 1000;
  let best = null;
  let bestDelta = Infinity;
  for (const r of silenceRegions) {
    for (const cand of [r.start, r.end, (r.start + r.end) / 2]) {
      const delta = Math.abs(cand - targetSec);
      if (delta <= window_s && delta < bestDelta) {
        best = cand;
        bestDelta = delta;
      }
    }
  }
  return best ?? targetSec;
}

/**
 * Convert a float second to a frame-accurate time on the given fps rational.
 * Returns { seconds, frame } — frame is an integer count from t=0.
 */
function toFrameAccurate(seconds, fps_num, fps_den) {
  const fps = fps_num / fps_den;
  const frame = Math.round(seconds * fps);
  return { seconds: frame / fps, frame };
}

/**
 * Extract a single JPEG frame from a source video at the given timestamp.
 * Output is small (480px wide, quality 4) — meant for clip thumbnails in the UI.
 */
async function extractThumbnail(input, timestampSeconds, output, { width = 480 } = {}) {
  if (!fs.existsSync(input)) throw new Error(`Source not found: ${input}`);
  const tmpOutput = tmpPath(output);
  try { fs.unlinkSync(tmpOutput); } catch {}
  await run(FFMPEG, [
    '-y',
    '-ss', timestampSeconds.toFixed(3),
    '-i', input,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-q:v', '4',
    tmpOutput,
  ], { timeout: 30000 });
  fs.renameSync(tmpOutput, output);
  return output;
}

module.exports = {
  probe,
  normalize,
  encodeShareablePreview,
  extractThumbnail,
  detectSilence,
  detectSilenceWindow,
  cutSegment,
  concat,
  concatAccurate,
  snapToSilence,
  toFrameAccurate,
  cancelAll,
  resetCancel,
  isCancelled,
  FFMPEG,
  FFPROBE,
  INTRA_FRAME_CODECS,
};
