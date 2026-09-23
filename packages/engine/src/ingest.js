/**
 * Ingest — turn a URL or a local file into a normalized local source.
 *
 * This is the capability the v1 app never had: it only ever read local files, so a
 * livestream link had to be downloaded by hand before anything could happen.
 *
 * The important design choice here is that AUDIO IS FETCHED FIRST, as its own small
 * file, and the caller can start transcribing it while the (much larger) video is still
 * downloading. On a 3-hour trading livestream the video is multiple GB and the audio is
 * ~100MB; serialising them would idle the transcriber for many minutes.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';

/**
 * yt-dlp extraction strategies, tried in order.
 *
 * YouTube rotates which player clients serve working URLs, so a single hardcoded choice
 * fails periodically and looks like a bug in this app. Observed on a real video during
 * development: the DEFAULT client returned `HTTP Error 403: Forbidden`, `ios`/`web_safari`
 * returned "Requested format is not available", `tv` returned "The page needs to be
 * reloaded" — and only `android` worked. Six months from now it will be a different one.
 *
 * So we try a chain and remember the winner for the rest of the process. Anything that
 * works is fine; being locked to one that stopped working is not.
 */
const EXTRACTOR_STRATEGIES = [
  { name: 'default', args: [] },
  { name: 'android', args: ['--extractor-args', 'youtube:player_client=android'] },
  { name: 'ios', args: ['--extractor-args', 'youtube:player_client=ios'] },
  { name: 'web_safari', args: ['--extractor-args', 'youtube:player_client=web_safari'] },
  { name: 'tv', args: ['--extractor-args', 'youtube:player_client=tv'] },
];

/** Sticky within a process: once a strategy works, stop paying for the failures. */
let preferredStrategy = null;

/**
 * `preferQuality` matters for VIDEO. The sticky preference is a latency optimisation, but
 * applying it to video actively hurt: `android` won on the audio fetch, so it was then
 * preferred for video too — and android only offers a 640x360 combined format for videos
 * where the default client lists 1080p. The result was a 360p source upscaled into a
 * 1080x1920 clip. For video we always walk the list in quality order instead.
 */
function strategyOrder({ preferQuality = false } = {}) {
  if (preferQuality || !preferredStrategy) return EXTRACTOR_STRATEGIES;
  return [
    EXTRACTOR_STRATEGIES.find((s) => s.name === preferredStrategy),
    ...EXTRACTOR_STRATEGIES.filter((s) => s.name !== preferredStrategy),
  ].filter(Boolean);
}

/**
 * Run yt-dlp through the strategy chain, returning on the first success.
 * `verify` lets the caller assert the artefact actually appeared — yt-dlp can exit 0
 * having written nothing useful.
 */
async function runYtdlp(baseArgs, { onLine, verify, preferQuality = false } = {}) {
  const errors = [];
  for (const strat of strategyOrder({ preferQuality })) {
    try {
      await run(YTDLP_BIN, [...strat.args, ...baseArgs], { onLine });
      if (verify && !verify()) throw new Error('command succeeded but produced no output file');
      preferredStrategy = strat.name;
      return strat.name;
    } catch (err) {
      errors.push(`${strat.name}: ${String(err.message).split('\n').pop().slice(0, 160)}`);
    }
  }
  throw new Error(`yt-dlp failed with every extraction strategy:\n  ${errors.join('\n  ')}`);
}

/**
 * Guard against cloud-evicted files.
 *
 * macOS marks iCloud/Dropbox files whose contents have been evicted as `dataless`. The
 * file still stat()s at full size and looks completely normal, but ANY read blocks
 * indefinitely while the OS fetches it — no error, no timeout, no progress. A 2.6GB source
 * in this workspace stalled ffprobe and ffmpeg for 10+ minutes at 0% CPU with zero bytes
 * written, which in a worker means a permanently wedged job slot.
 *
 * So: detect it up front and say so, rather than hanging.
 */
function isDataless(filePath) {
  try {
    // st_flags; UF_COMPRESSED (0x20) is what Finder/`ls -lO` shows as "dataless" for an
    // evicted cloud file.
    const flags = execFileSync('stat', ['-f', '%f', filePath], { encoding: 'utf8' }).trim();
    const n = parseInt(flags, 10);
    if (Number.isFinite(n) && (n & 0x20)) return true;
  } catch {}
  try {
    const out = execFileSync('ls', ['-lO', filePath], { encoding: 'utf8' });
    return /\bdataless\b/.test(out);
  } catch {}
  return false;
}

/** Fail fast with an actionable message instead of blocking forever. */
function assertMaterialized(filePath) {
  if (!isDataless(filePath)) return;
  throw new Error(
    `Source is a cloud placeholder (evicted, "dataless"): ${filePath}\n` +
    'Its bytes are not on this machine, and reading it would hang indefinitely rather ' +
    'than error. Materialise it first:\n' +
    `  brctl download "${filePath}"      # iCloud\n` +
    '  (or right-click > Download Now in Finder / your sync client)'
  );
}

/** Sources we can fetch with yt-dlp vs. read off disk. */
function isUrl(input) {
  return /^https?:\/\//i.test(input);
}

function run(bin, args, { onLine, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buffer = '';

    const pump = (chunk) => {
      if (!onLine) return;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) onLine(line);
    };

    child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; pump(s); });
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; pump(s); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${bin} exited ${code}: ${stderr.slice(-2000) || stdout.slice(-2000)}`));
    });

    // Expose the child so a job can be cancelled with a real signal rather than
    // the v1 approach of killing ffmpeg and hoping the awaited promise rejects.
    resolve.child = child;
  });
}

/** yt-dlp writes progress as `[download]  42.3% of ...`; turn that into a number. */
function parseProgress(line) {
  const m = line.match(/\[download\]\s+([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Read metadata without downloading. Cheap, and it tells us up front whether we are
 * dealing with a 40-second reel or a 4-hour stream, which changes everything downstream.
 */
async function probeUrl(url) {
  let stdout = null;
  const errors = [];
  for (const strat of strategyOrder()) {
    try {
      const r = await run(YTDLP_BIN, [...strat.args, '--no-warnings', '--dump-json', '--no-playlist', url]);
      if (r.stdout.trim()) { stdout = r.stdout; preferredStrategy = strat.name; break; }
    } catch (err) {
      errors.push(`${strat.name}: ${String(err.message).split('\n').pop().slice(0, 140)}`);
    }
  }
  if (!stdout) throw new Error(`Could not read metadata for ${url}:\n  ${errors.join('\n  ')}`);
  const firstLine = stdout.trim().split('\n')[0];
  const j = JSON.parse(firstLine);
  return {
    id: j.id,
    title: j.title,
    durationSeconds: j.duration ?? null,
    uploader: j.uploader || j.channel || null,
    isLive: Boolean(j.is_live),
    wasLive: Boolean(j.was_live),
    thumbnail: j.thumbnail || null,
    extractor: j.extractor_key || j.extractor || null,
    width: j.width ?? null,
    height: j.height ?? null,
    webpageUrl: j.webpage_url || url,
  };
}

/**
 * Fetch just the audio and convert it to the 16 kHz mono WAV whisper.cpp wants.
 * We go straight to WAV rather than keeping a compressed intermediate because
 * whisper-server re-decodes anyway and WAV seeking is trivial for chunked passes.
 */
async function fetchAudio(url, outDir, { onProgress } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const raw = path.join(outDir, 'audio.source');
  const wav = path.join(outDir, 'audio.16k.wav');

  if (!fs.existsSync(wav)) {
    if (!fs.existsSync(raw)) {
      await runYtdlp([
        '--no-warnings', '--no-playlist',
        '-f', 'bestaudio/best',
        '--no-part',
        '--retries', '10', '--fragment-retries', '50',
        '-o', raw,
        url,
      ], {
        onLine: (line) => {
          const pct = parseProgress(line);
          if (pct != null && onProgress) onProgress({ phase: 'audio', percent: pct });
        },
        verify: () => fs.existsSync(raw) && fs.statSync(raw).size > 0,
      });
    }
    await toWav16k(raw, wav);
  }
  return wav;
}

/** Shared by the URL path and the local-file path. */
function toWav16k(input, output) {
  const tmp = `${output}.partial.wav`;
  return run(process.env.FFMPEG_BIN || 'ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le',
    tmp,
  ]).then(() => { fs.renameSync(tmp, output); return output; });
}

/**
 * Fetch the video itself. Capped at 1080p — the render canvas is at most 1920px wide,
 * so pulling a 4K stream costs bandwidth and disk for detail that is thrown away in the
 * first scale filter.
 */
async function fetchVideo(url, outDir, { onProgress, maxHeight = 1080 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'source.mp4');
  if (fs.existsSync(out)) return out;

  await runYtdlp([
    '--no-warnings', '--no-playlist',
    '-f', `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/bv*+ba/b`,
    '--merge-output-format', 'mp4',
    '--no-part',
    '--retries', '10', '--fragment-retries', '50', '--concurrent-fragments', '4',
    '-o', out,
    url,
  ], {
    onLine: (line) => {
      const pct = parseProgress(line);
      if (pct != null && onProgress) onProgress({ phase: 'video', percent: pct });
    },
    preferQuality: true,
    verify: () => fs.existsSync(out) && fs.statSync(out).size > 0,
  });

  // Report what we actually got. YouTube periodically serves only low-resolution formats
  // to the clients that still allow downloads, and silently upscaling a 360p source into a
  // 1080x1920 clip is the kind of quality loss nobody notices until the client does.
  try {
    const dims = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out,
    ], { encoding: 'utf8' }).trim().split(',').map(Number);
    if (dims[1] && dims[1] < 720) {
      console.warn(
        `[ingest] WARNING: source is only ${dims[0]}x${dims[1]}. Clips will be upscaled. ` +
        'YouTube is serving low-resolution formats to the only extractor client that ' +
        'currently permits downloads; updating yt-dlp usually restores 1080p.'
      );
    }
  } catch {}
  return out;
}

/** Stable id for a source so repeated ingests of the same link reuse the same folder. */
function sourceKey(input) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
}

/**
 * Full ingest. Returns as soon as audio is ready, handing back a promise for the video
 * so the caller can transcribe in parallel:
 *
 *   const { audioPath, video } = await ingest(url, dir);
 *   const [transcript, videoPath] = await Promise.all([transcribe(audioPath), video]);
 */
async function ingest(input, baseDir, { onProgress } = {}) {
  const key = sourceKey(input);
  const outDir = path.join(baseDir, key);
  fs.mkdirSync(outDir, { recursive: true });

  if (!isUrl(input)) {
    if (!fs.existsSync(input)) throw new Error(`Source file not found: ${input}`);
    assertMaterialized(input);
    const wav = path.join(outDir, 'audio.16k.wav');
    if (!fs.existsSync(wav)) await toWav16k(input, wav);
    return {
      key,
      outDir,
      meta: { title: path.basename(input), webpageUrl: null, durationSeconds: null },
      audioPath: wav,
      video: Promise.resolve(input),
    };
  }

  const meta = await probeUrl(input);
  fs.writeFileSync(path.join(outDir, 'source.meta.json'), JSON.stringify(meta, null, 2));

  const audioPath = await fetchAudio(input, outDir, { onProgress });
  // Deliberately NOT awaited — the caller transcribes while this downloads.
  const video = fetchVideo(input, outDir, { onProgress });

  return { key, outDir, meta, audioPath, video };
}

module.exports = { ingest, probeUrl, fetchAudio, fetchVideo, toWav16k, isUrl, sourceKey, isDataless, assertMaterialized, EXTRACTOR_STRATEGIES };
