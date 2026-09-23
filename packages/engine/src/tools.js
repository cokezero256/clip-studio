/**
 * The external tools the pipeline needs, found or installed by the app itself.
 *
 * WHY. A Windows user cloned the repo, pasted a link and got "spawn yt-dlp ENOENT" five
 * times. Nothing else. The tools were documented in a README nobody reads at that moment;
 * the app has to take care of them. This module resolves each tool in order —
 *   1. an explicit env var (YTDLP_BIN, WHISPER_BIN, WHISPER_MODEL)
 *   2. whatever is already on PATH
 *   3. a copy we downloaded earlier into <data>/bin
 *   4. a fresh download (yt-dlp from its GitHub release, whisper.cpp's prebuilt binaries on
 *      Windows/Linux, the model from Hugging Face)
 * and remembers the answer so ingest/transcribe can ask synchronously.
 *
 * macOS has no prebuilt whisper.cpp release; there the hint is `brew install whisper-cpp`
 * (the team's Macs already have it).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { engineRoot } = require('./paths');

const IS_WIN = process.platform === 'win32';
const exe = (name) => (IS_WIN ? `${name}.exe` : name);

const dataBin = () => path.resolve(engineRoot(), '..', '..', 'data', 'bin');

const DEFAULT_MODEL = process.env.WHISPER_MODEL
  || path.join(os.homedir(), '.cache', 'whisper-models', 'ggml-large-v3-turbo-q5_0.bin');
const MODEL_URL = (model) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${path.basename(model)}`;

/** Does `bin --version` run? Only "not found" counts as missing. */
function works(bin) {
  if (!bin) return false;
  try {
    execFileSync(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    return true;
  } catch (err) {
    return !(err && (err.code === 'ENOENT' || /ENOENT/.test(String(err.message))));
  }
}

/** The yt-dlp release asset for this machine. */
function ytdlpAsset(platform = process.platform) {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp_linux';
}

/** The whisper.cpp release asset for this machine, or null where none is published. */
function whisperAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'arm64' ? 'whisper-bin-win-cpu-arm64.zip' : 'whisper-bin-x64.zip';
  if (platform === 'linux') return arch === 'arm64' ? 'whisper-bin-ubuntu-arm64.tar.gz' : 'whisper-bin-ubuntu-x64.tar.gz';
  return null;
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'clip-studio' } });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  const ws = fs.createWriteStream(tmp);
  let got = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : null;
    if (onProgress && pct !== lastPct) { lastPct = pct; onProgress({ percent: pct, got, total }); }
  }
  await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
  fs.renameSync(tmp, dest);
  return dest;
}

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
    else if (entry.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return null;
}

/** Newest whisper.cpp release that ships the asset we need (tagged releases often ship none). */
async function whisperAssetUrl(asset) {
  const res = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20', {
    headers: { 'user-agent': 'clip-studio', accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} while looking for whisper.cpp binaries`);
  for (const rel of await res.json()) {
    const a = (rel.assets || []).find((x) => x.name === asset);
    if (a) return { url: a.browser_download_url, tag: rel.tag_name, size: a.size };
  }
  throw new Error(`no whisper.cpp release with ${asset}`);
}

// ── resolution (sync, cached) ──
const resolved = { ytdlp: null, whisper: null, model: null };
const forceVendored = () => process.env.CLIPSTUDIO_FORCE_VENDORED === '1';   // tests

function resolveYtdlp() {
  if (resolved.ytdlp) return resolved.ytdlp;
  if (process.env.YTDLP_BIN) return (resolved.ytdlp = process.env.YTDLP_BIN);
  if (!forceVendored() && works('yt-dlp')) return (resolved.ytdlp = 'yt-dlp');
  const vendored = path.join(dataBin(), exe('yt-dlp'));
  if (fs.existsSync(vendored)) return (resolved.ytdlp = vendored);
  return null;
}

function resolveWhisper() {
  if (resolved.whisper) return resolved.whisper;
  if (process.env.WHISPER_BIN) return (resolved.whisper = process.env.WHISPER_BIN);
  if (!forceVendored() && works('whisper-cli')) return (resolved.whisper = 'whisper-cli');
  const vendored = findFile(path.join(dataBin(), 'whisper'), exe('whisper-cli'));
  if (vendored) return (resolved.whisper = vendored);
  return null;
}

function resolveModel() {
  return fs.existsSync(DEFAULT_MODEL) ? DEFAULT_MODEL : null;
}

/** What ingest/transcribe call: the resolved path, or the plain name so the error names it. */
const ytdlpBin = () => resolveYtdlp() || 'yt-dlp';
const whisperBin = () => resolveWhisper() || 'whisper-cli';
const modelPath = () => DEFAULT_MODEL;

// ── installation (async) ──
async function ensureYtdlp({ onProgress = () => {} } = {}) {
  const have = resolveYtdlp();
  if (have) return { bin: have, installed: false };
  const asset = ytdlpAsset();
  const dest = path.join(dataBin(), exe('yt-dlp'));
  onProgress({ tool: 'yt-dlp', message: `downloading ${asset}`, percent: 0 });
  await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, dest,
    (p) => onProgress({ tool: 'yt-dlp', message: `downloading ${asset}`, percent: p.percent }));
  if (!IS_WIN) fs.chmodSync(dest, 0o755);
  if (!works(dest)) throw new Error(`downloaded yt-dlp does not run: ${dest}`);
  resolved.ytdlp = dest;
  onProgress({ tool: 'yt-dlp', message: 'ready', percent: 100 });
  return { bin: dest, installed: true };
}

async function ensureWhisper({ onProgress = () => {} } = {}) {
  const have = resolveWhisper();
  if (have) return { bin: have, installed: false };
  const asset = whisperAsset();
  if (!asset) {
    throw new Error('whisper-cli not found. Install whisper.cpp — on macOS: brew install whisper-cpp — then restart the worker.');
  }
  const dir = path.join(dataBin(), 'whisper');
  const { url, tag, size } = await whisperAssetUrl(asset);
  const archive = path.join(dir, asset);
  onProgress({ tool: 'whisper', message: `downloading whisper.cpp ${tag} (${Math.round(size / 1e6)} MB)`, percent: 0 });
  await download(url, archive, (p) => onProgress({ tool: 'whisper', message: `downloading whisper.cpp ${tag}`, percent: p.percent }));
  onProgress({ tool: 'whisper', message: 'unpacking', percent: null });
  // bsdtar (macOS, Linux, Windows 10+) opens both .zip and .tar.gz.
  execFileSync('tar', ['-xf', archive, '-C', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.unlinkSync(archive);
  const bin = findFile(dir, exe('whisper-cli'));
  if (!bin) throw new Error(`whisper.cpp archive had no ${exe('whisper-cli')}`);
  if (!IS_WIN) fs.chmodSync(bin, 0o755);
  resolved.whisper = bin;
  onProgress({ tool: 'whisper', message: 'ready', percent: 100 });
  return { bin, installed: true };
}

async function ensureModel({ onProgress = () => {} } = {}) {
  if (resolveModel()) return { path: DEFAULT_MODEL, installed: false };
  const name = path.basename(DEFAULT_MODEL);
  onProgress({ tool: 'model', message: `downloading ${name} (~550 MB, once)`, percent: 0 });
  await download(MODEL_URL(DEFAULT_MODEL), DEFAULT_MODEL,
    (p) => onProgress({ tool: 'model', message: `downloading ${name} (~550 MB, once)`, percent: p.percent }));
  onProgress({ tool: 'model', message: 'ready', percent: 100 });
  return { path: DEFAULT_MODEL, installed: true };
}

/**
 * Everything the worker needs, installed if missing. yt-dlp failing is a warning (local
 * files still work); whisper or its model failing is fatal, with the fix in the message.
 */
async function ensureTools({ onProgress = () => {}, log = () => {} } = {}) {
  const out = { ytdlp: null, whisper: null, model: null, warnings: [] };
  try {
    const r = await ensureYtdlp({ onProgress });
    out.ytdlp = r.bin;
    if (r.installed) log(`yt-dlp installed → ${r.bin}`);
  } catch (err) {
    out.warnings.push(`yt-dlp unavailable: ${err.message}`);
  }
  const w = await ensureWhisper({ onProgress });
  out.whisper = w.bin;
  if (w.installed) log(`whisper-cli installed → ${w.bin}`);
  const m = await ensureModel({ onProgress });
  out.model = m.path;
  if (m.installed) log(`whisper model downloaded → ${m.path}`);
  return out;
}

module.exports = {
  ensureTools, ensureYtdlp, ensureWhisper, ensureModel,
  resolveYtdlp, resolveWhisper, resolveModel, ytdlpBin, whisperBin, modelPath,
  ytdlpAsset, whisperAsset, dataBin, DEFAULT_MODEL,
};
