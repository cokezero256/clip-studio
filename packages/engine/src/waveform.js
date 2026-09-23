/**
 * Generate a compact peaks JSON file for a source audio/video using ffmpeg.
 *
 * Algorithm:
 *   1. ffmpeg decodes the audio to raw float32 mono at 8 kHz into stdout.
 *   2. We bucket the samples into ~2000 [min, max] pairs regardless of duration.
 *   3. Persist as `output/<name>/waveform.json` — immutable once written.
 *
 * Output schema:
 *   { duration: number, sampleRate: 8000, peaks: [[min,max], ...] }
 *
 * wavesurfer.js v7 accepts `{ peaks: [[min,max],...] }` directly when you
 * pass `{ peaks: data.peaks, duration: data.duration }` to `WaveSurfer.create`.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FFMPEG = process.env.FFMPEG_BIN || require('ffmpeg-static');
const SAMPLE_RATE = 8000;
// Resolution is now a fixed number of buckets PER SECOND, not a fixed total. The old
// fixed-2000-total made long sources almost flat (a 36-min source = ~1 bucket/sec, so a
// 55s clip view had ~50 bars). 50 buckets/sec = 20ms resolution → a deep, detailed
// waveform at the clip level even on long sources.
const BUCKETS_PER_SEC = 50;

/**
 * Generate peaks JSON for `sourcePath` and cache it at `outputPath`.
 * Returns the peaks object `{ duration, sampleRate, peaks }`.
 * If the cache exists, returns it immediately.
 */
async function generatePeaks(sourcePath, outputPath) {
  if (fs.existsSync(outputPath)) {
    return JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
  }

  const raw = await extractRawAudio(sourcePath);
  const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const totalSamples = samples.length;
  // Fixed resolution-per-second so the waveform stays detailed regardless of source length.
  const bucketSize = Math.max(1, Math.round(SAMPLE_RATE / BUCKETS_PER_SEC));
  const numBuckets = Math.ceil(totalSamples / bucketSize);
  const peaks = [];

  for (let b = 0; b < numBuckets; b++) {
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, totalSamples);
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < end; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // Round to 3 decimal places to keep JSON compact.
    peaks.push([Math.round(min * 1000) / 1000, Math.round(max * 1000) / 1000]);
  }

  const duration = totalSamples / SAMPLE_RATE;
  const result = { duration, sampleRate: SAMPLE_RATE, peaks };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result), 'utf-8');
  return result;
}

/**
 * Stream raw float32le mono audio at SAMPLE_RATE from `sourcePath`.
 * Returns a Buffer containing the raw bytes.
 */
function extractRawAudio(sourcePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-i', sourcePath,
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le',
      'pipe:1',
    ]);

    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { /* intentionally silent — loglevel error only */ });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('waveform extraction timed out after 5 minutes'));
    }, 5 * 60 * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited ${code} while extracting audio from ${sourcePath}`));
      }
    });
    proc.on('error', reject);
  });
}

module.exports = { generatePeaks };
