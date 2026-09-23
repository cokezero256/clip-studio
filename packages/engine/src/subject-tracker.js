/**
 * subject-tracker.js — wraps bin/detect-subject.py for the Node side of the pipeline.
 *
 * detectSubject(opts) now returns a TRAJECTORY:
 *   { control_points: [{t, x_pct, confidence}, ...], frame_dims, detector }
 * or null when detection was unreliable (caller falls back to center crop).
 *
 * Each control point's `t` is CLIP-LOCAL (0 = clip start). The renderer combines this
 * with the clip's actual start to build a per-time ffmpeg crop expression that pans
 * with the speaker.
 *
 * Cache: results saved to `<outputDir>/subject-tracks/<clipId>.json`. v1 caches (the
 * old static-crop schema) are ignored and re-detected — version field is checked.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BIN_DIR = require('./paths').binPath();
const VENV_PYTHON = path.join(BIN_DIR, 'venv', 'bin', 'python');
const SCRIPT = path.join(BIN_DIR, 'detect-subject.py');
const SCHEMA_VERSION = 2;

function pythonAvailable() {
  return fs.existsSync(VENV_PYTHON) && fs.existsSync(SCRIPT);
}

/**
 * @param {object} opts
 * @param {string} opts.sourcePath
 * @param {number} opts.startSeconds
 * @param {number} opts.endSeconds
 * @param {string} opts.clipId
 * @param {string} opts.outputDir
 * @param {number} [opts.intervalSec=0.4]   Sampling density (smaller = smoother pan but slower).
 * @param {number} [opts.timeoutMs=120000]
 * @returns {Promise<null | {control_points: Array<{t:number,x_pct:number,confidence:number}>, frame_dims:[number,number], detector:string, samples_total:number, samples_with_face:number}>}
 */
async function detectSubject(opts) {
  const {
    sourcePath,
    startSeconds,
    endSeconds,
    clipId,
    outputDir,
    intervalSec = 0.4,
    timeoutMs = 120 * 1000,
  } = opts;

  if (!fs.existsSync(sourcePath)) {
    console.warn(`[subject-tracker] source not found: ${sourcePath}`);
    return null;
  }
  if (endSeconds <= startSeconds) {
    console.warn(`[subject-tracker] invalid range ${startSeconds}-${endSeconds}`);
    return null;
  }

  const cacheDir = path.join(outputDir, 'subject-tracks');
  const cachePath = path.join(cacheDir, `${clipId}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (cached && cached.version === SCHEMA_VERSION && Array.isArray(cached.control_points)) {
        return cached;
      }
      // v1 (legacy) cache → ignore and re-detect.
    } catch {
      // Corrupt cache → ignore and re-detect.
    }
  }

  if (!pythonAvailable()) {
    console.warn(
      `[subject-tracker] Python sidecar not installed at ${VENV_PYTHON}. ` +
      `Run \`bash bin/setup.sh\`. Falling back to center crop.`,
    );
    return null;
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  const args = [
    SCRIPT,
    '--input', sourcePath,
    '--start', String(startSeconds),
    '--end', String(endSeconds),
    '--interval', String(intervalSec),
    '--out', cachePath,
  ];

  const result = await runOnce(VENV_PYTHON, args, timeoutMs);
  if (result.exitCode === 0 && fs.existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (parsed.version !== SCHEMA_VERSION) {
        console.warn(`[subject-tracker] unexpected schema version ${parsed.version} (expected ${SCHEMA_VERSION})`);
        return null;
      }
      return parsed;
    } catch (err) {
      console.warn(`[subject-tracker] cache parse failed: ${err.message}`);
      return null;
    }
  }

  // Exit codes from detect-subject.py: 2=input, 3=deps, 4=range, 5=insufficient detections.
  console.warn(
    `[subject-tracker] detection failed for clip ${clipId} (exit ${result.exitCode}). ` +
    `Falling back to center crop. stderr: ${result.stderr.slice(-300).trim()}`,
  );
  return null;
}

function runOnce(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    const proc = spawn(bin, args);
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? -1 : code, stdout, stderr, timedOut });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -2, stdout, stderr: stderr + '\n' + err.message, timedOut: false });
    });
  });
}

module.exports = { detectSubject, pythonAvailable, SCHEMA_VERSION, VENV_PYTHON, SCRIPT };
