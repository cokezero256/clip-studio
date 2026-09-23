/**
 * Pauses in speech, measured the way an editor hears them.
 *
 * WHY THIS EXISTS. The first silence detector was ffmpeg's `silencedetect`, which works on
 * sample PEAKS: a single keyboard click or chair creak above −32 dBFS ends a silence. On a
 * real stream a 26-second dead stretch came back as a string of sub-0.4 s pieces — none long
 * enough to cut — so the plan left the dead air in, and where it did cut it left 0.01–0.28 s
 * word-less slivers between the pieces (the "multiple cuts" a user saw on the timeline).
 *
 * This module measures a 10 ms RMS envelope instead, calls a frame voiced when it sits within
 * SILENCE_BELOW_PEAK_DB of the speaker's OWN level (the 95th percentile over a rolling minute,
 * so a quiet mic and a loud one behave the same), and folds voiced islands shorter than
 * `foldVoice` back into the pause — unless a transcript word starts on them, because "I" is
 * 80 ms long and is not a click. The result is one pause per pause.
 *
 * The envelope is cached beside the WAV (`<audio>.env.bin`) because computing it means
 * reading the whole file; every later call is milliseconds.
 */

const fs = require('fs');
const { readPcm16, envelope, voicedFlags, FRAME_S } = require('../captions/align');

const MAGIC = 'ENV1';

/** dB envelope for an audio file, 10 ms frames, cached on disk. */
function envelopeFor(audioPath) {
  const cachePath = `${audioPath}.env.bin`;
  try {
    const st = fs.statSync(cachePath);
    if (st.mtimeMs >= fs.statSync(audioPath).mtimeMs) {
      const buf = fs.readFileSync(cachePath);
      if (buf.toString('ascii', 0, 4) === MAGIC) {
        const count = buf.readUInt32LE(4);
        const db = new Float32Array(count);
        for (let i = 0; i < count; i++) db[i] = buf.readFloatLE(8 + i * 4);
        return { db, frameSeconds: FRAME_S };
      }
    }
  } catch { /* no cache yet */ }
  const { samples, sampleRate } = readPcm16(audioPath);
  const db = envelope(samples, sampleRate);
  try {
    const out = Buffer.alloc(8 + db.length * 4);
    out.write(MAGIC, 0, 'ascii');
    out.writeUInt32LE(db.length, 4);
    for (let i = 0; i < db.length; i++) out.writeFloatLE(db[i], 8 + i * 4);
    fs.writeFileSync(cachePath, out);
  } catch { /* a read-only location is fine; we just recompute next time */ }
  return { db, frameSeconds: FRAME_S };
}

/**
 * Unvoiced runs of at least `minPause` seconds inside [from, to].
 *
 * @param {Float32Array} db        10 ms dB envelope of the whole file
 * @param {object} o
 * @param {number} [o.from=0]      window start, seconds
 * @param {number} [o.to]          window end, seconds
 * @param {number} [o.minPause=0.3]
 * @param {number} [o.foldVoice=0.15]  a voiced island shorter than this, flanked by pause, is noise
 * @param {number[]} [o.protect=[]]     instants (word starts) that must never be folded away
 * @returns {Array<{start:number,end:number,seconds:number}>} absolute seconds, sorted
 */
function pausesFromEnvelope(db, o = {}) {
  const from = Math.max(0, o.from ?? 0);
  const to = Math.min(db.length * FRAME_S, o.to ?? db.length * FRAME_S);
  const minPause = o.minPause ?? 0.3;
  const foldVoice = o.foldVoice ?? 0.15;
  const protect = (o.protect || []).filter((t) => t >= from - 0.5 && t <= to + 0.5).sort((a, b) => a - b);

  const voiced = Uint8Array.from(voicedFlags(db));
  const n = voiced.length;
  const f0 = Math.max(0, Math.floor(from / FRAME_S));
  const f1 = Math.min(n, Math.ceil(to / FRAME_S));

  // Fold short voiced islands into the surrounding pause — unless a word starts on them.
  const minVoice = Math.round(foldVoice / FRAME_S);
  const protectedIsland = (a, b) => {
    const ta = a * FRAME_S - 0.03;
    const tb = b * FRAME_S + 0.03;
    // protect is sorted: binary-search the first instant >= ta
    let lo = 0;
    let hi = protect.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (protect[mid] < ta) lo = mid + 1; else hi = mid; }
    return lo < protect.length && protect[lo] <= tb;
  };
  for (let f = f0; f < f1;) {
    if (!voiced[f]) { f++; continue; }
    let g = f;
    while (g < f1 && voiced[g]) g++;
    const flanked = f > 0 && !voiced[f - 1] && g < n && !voiced[g];
    if (g - f < minVoice && flanked && !protectedIsland(f, g)) voiced.fill(0, f, g);
    f = g;
  }

  const out = [];
  const minRun = Math.round(minPause / FRAME_S);
  for (let f = f0; f < f1;) {
    if (voiced[f]) { f++; continue; }
    let g = f;
    while (g < f1 && !voiced[g]) g++;
    if (g - f >= minRun) {
      const start = +(f * FRAME_S).toFixed(3);
      const end = +(g * FRAME_S).toFixed(3);
      out.push({ start, end, seconds: +(end - start).toFixed(3) });
    }
    f = g;
  }
  return out;
}

/**
 * Drop-in for `measureSilence`: pauses in [from, to] of a WAV, same output shape.
 * Synchronous (the envelope is cached), but returns a Promise like its predecessor so the
 * planner did not have to change.
 */
async function measurePauses(audioPath, from, to, o = {}) {
  const { db } = envelopeFor(audioPath);
  return pausesFromEnvelope(db, { ...o, from, to });
}

module.exports = { envelopeFor, pausesFromEnvelope, measurePauses };
