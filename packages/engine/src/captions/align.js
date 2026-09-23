/**
 * Snap whisper word timings to the speaker's actual voice.
 *
 * WHY THIS EXISTS. whisper.cpp with `--max-len 1` tiles word timings edge to edge: when the
 * speaker pauses, the pause is absorbed into a neighbouring word instead of appearing as a
 * gap. Usually it is the NEXT word that swallows it, so that word's start sits inside the
 * silence and its caption appears before it is said. The operator's report was exact: "when
 * I say clipping, and I do a little bit of pause, it already starts the other word."
 *
 * Measured on a real 99s clip: 22 of 215 words started inside silence, firing a median
 * 590 ms early, p90 2.46 s, worst 3.38 s. Captions hold until the next word appears, so
 * only word STARTS decide what is on screen — and those are exactly what was wrong.
 *
 * HOW. A 10 ms energy envelope of the 16 kHz WAV (computes a 71-minute stream in ~70 ms, so
 * it is not cached). A frame is silent when it sits more than SILENCE_BELOW_PEAK_DB under
 * the LOCAL speech level. The threshold is anchored to speech, not to the noise floor,
 * because the floor is unusable as an anchor: measured per minute it swung from -60 to
 * -35 dB on one stream (minutes with no real pause), and another stream's floor was
 * -120 dB, digital silence from a noise gate. The speech peak stayed within -17..-12 dB.
 *
 * Only clear pauses move a word: an unvoiced run must last MIN_PAUSE_S, so the 30-80 ms
 * closure before a plosive ("t", "k", "p") is never mistaken for one. When there is no
 * clear silence at a word boundary — continuous speech, background music — nothing moves.
 */

const fs = require('fs');

const FRAME_S = 0.01;
const SAMPLES_PER_FRAME = 160; // 10 ms at 16 kHz
const SILENCE_BELOW_PEAK_DB = 24;
const PEAK_WINDOW_S = 60;
const MIN_PAUSE_S = 0.08;
// Voiced runs shorter than this, with silence on both sides, are clicks or breaths.
const MIN_VOICE_S = 0.05;
const MIN_WORD_S = 0.08;
// A voiceless word is a quiet word said on time only if its gap is no longer than the word
// could plausibly take to say, plus this slack. Longer, and it was said after the gap.
const QUIET_SLACK_S = 0.1;
// Rough spoken duration from letter count, clamped: "I" ≈ 120 ms, "this" ≈ 280 ms.
const plausibleSeconds = (w) => {
  const n = String(w.word ?? w.text ?? '').replace(/[^\p{L}\p{N}$%]/gu, '').length;
  return Math.min(0.6, Math.max(0.12, 0.07 * n));
};
// Most words a single long pause can have swallowed before the layout gives up.
const MAX_GROUP = 12;
// Keep a word's tail audible after the voice decays.
const END_TAIL_S = 0.03;

/** Bumped whenever the algorithm changes, so cached transcripts and tracks re-align. */
// v3: boundaries between abutting words move to a clear energy dip (see refineWordTimings).
const ALIGN_VERSION = 'voice-v3';
const DIP_BACK_FRAMES = 3;    // search −30 ms …
const DIP_FWD_FRAMES = 9;     // … +90 ms around whisper's boundary
const DIP_DB = 4;             // a minimum this far under both flanks is a word edge

/** Read a 16-bit PCM mono WAV. Returns the samples and the sample rate. */
function readPcm16(audioPath) {
  const buf = fs.readFileSync(audioPath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a WAV file: ${audioPath}`);
  }
  let off = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      if (bits !== 16 || channels !== 1) {
        throw new Error(`expected 16-bit mono PCM, got ${bits}-bit ${channels}ch: ${audioPath}`);
      }
      const start = off + 8;
      const end = Math.min(buf.length, start + len);
      // Int16Array needs 2-byte alignment; copy only if the chunk happens to be misaligned.
      const aligned = (buf.byteOffset + start) % 2 === 0
        ? buf
        : Buffer.from(buf.subarray(start, end));
      const byteStart = aligned === buf ? buf.byteOffset + start : aligned.byteOffset;
      const samples = new Int16Array(aligned.buffer, byteStart, Math.floor((end - start) / 2));
      return { samples, sampleRate };
    }
    off += 8 + len + (len & 1);
  }
  throw new Error(`no data chunk in ${audioPath}`);
}

/** Per-frame RMS level in dB. */
function envelope(samples, sampleRate = 16000) {
  const perFrame = Math.round(sampleRate * FRAME_S) || SAMPLES_PER_FRAME;
  const frames = Math.floor(samples.length / perFrame);
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    const base = f * perFrame;
    for (let k = 0; k < perFrame; k++) {
      const v = samples[base + k] / 32768;
      acc += v * v;
    }
    db[f] = 10 * Math.log10(acc / perFrame + 1e-12);
  }
  return db;
}

function percentile(arr, q) {
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))];
}

/**
 * Per-frame "voiced" flags. Threshold = local speech level (p95 over PEAK_WINDOW_S) minus
 * SILENCE_BELOW_PEAK_DB, interpolated between window centres so gain drift is followed.
 */
function voicedFlags(db) {
  const n = db.length;
  const voiced = new Uint8Array(n);
  if (!n) return voiced;
  const win = Math.round(PEAK_WINDOW_S / FRAME_S);
  const centres = [];
  const peaks = [];
  for (let b = 0; b < n; b += win) {
    const slice = db.subarray(b, Math.min(n, b + win));
    centres.push(b + slice.length / 2);
    peaks.push(percentile(slice, 0.95));
  }
  let ci = 0;
  for (let f = 0; f < n; f++) {
    while (ci < centres.length - 2 && f > centres[ci + 1]) ci++;
    let peak;
    if (centres.length === 1 || f <= centres[0]) peak = peaks[0];
    else if (f >= centres[centres.length - 1]) peak = peaks[peaks.length - 1];
    else {
      const a = centres[ci];
      const b = centres[ci + 1];
      const t = (f - a) / (b - a);
      peak = peaks[ci] + t * (peaks[ci + 1] - peaks[ci]);
    }
    voiced[f] = db[f] > peak - SILENCE_BELOW_PEAK_DB ? 1 : 0;
  }
  return voiced;
}

/**
 * Mark frames that belong to a CLEAR pause: an unvoiced run lasting at least MIN_PAUSE_S.
 * Returns run bounds so a lookup can jump straight to the pause's first and last frame.
 */
function pauseRuns(voicedIn) {
  const minRun = Math.round(MIN_PAUSE_S / FRAME_S);
  const n = voicedIn.length;
  /*
   * A voiced island shorter than MIN_VOICE_S between two unvoiced stretches is a click, a
   * breath or a mic bump — not speech. Measured: the word "swept" was pinned to a 10 ms
   * blip and then followed by 500 ms of silence before the word was actually said. Such
   * islands are folded into the pause so an onset always means speech has resumed.
   */
  const voiced = Uint8Array.from(voicedIn);
  const minVoice = Math.round(MIN_VOICE_S / FRAME_S);
  for (let f = 0; f < n; ) {
    if (!voiced[f]) { f++; continue; }
    let g = f;
    while (g < n && voiced[g]) g++;
    const flankedBefore = f > 0 && !voiced[f - 1];
    const flankedAfter = g < n && !voiced[g];
    if (g - f < minVoice && flankedBefore && flankedAfter) voiced.fill(0, f, g);
    f = g;
  }
  const runStart = new Int32Array(n).fill(-1);
  const runEnd = new Int32Array(n).fill(-1);
  let f = 0;
  while (f < n) {
    if (voiced[f]) { f++; continue; }
    let g = f;
    while (g < n && !voiced[g]) g++;
    if (g - f >= minRun) {
      for (let k = f; k < g; k++) { runStart[k] = f; runEnd[k] = g - 1; }
    }
    f = g;
  }
  return { runStart, runEnd, voiced };
}

/**
 * Refine word timings against the voice. Pure: returns new word objects, never mutates.
 *
 * @param {Array<{word?:string,text?:string,start:number,end:number}>} words  absolute seconds
 * @param {{voiced: Uint8Array, runs: {runStart:Int32Array, runEnd:Int32Array}}} voice
 */
function refineWordTimings(words, voice) {
  const { runs } = voice;
  const n = voice.voiced.length;
  const frameOf = (t) => Math.max(0, Math.min(n - 1, Math.round(t / FRAME_S)));
  const inPause = (f) => runs.runStart[f] !== -1;
  const letters = (w) => String(w.word ?? w.text ?? '').replace(/[^\p{L}\p{N}$%]/gu, '').length;

  // Always refine from whisper's RAW timings, so re-aligning an already-aligned transcript
  // (after an algorithm change) is idempotent instead of compounding the previous pass.
  const out = words.map((w) => {
    const rs = w.raw_start ?? w.start;
    const re = w.raw_end ?? w.end;
    return { ...w, raw_start: rs, raw_end: re, start: rs, end: re };
  });

  /*
   * STARTS. Three cases, told apart by whether the word has any voice of its own:
   *
   *  1. The word begins in a pause but is voiced later in its own interval — whisper
   *     stretched it backwards over the pause. Its real start is the voice onset.
   *
   *  2. The word has no voice at all and the pause is SHORT. This is a quiet unstressed
   *     word ("the", "this", "can") filling a gap it is genuinely spoken in; unstressed
   *     function words sit 20+ dB under stressed syllables. Moving it would make a
   *     correct caption late, so it is left alone.
   *
   *  3. The word has no voice and the pause is LONG. whisper spread words that are spoken
   *     AFTER the pause across the silence — measured: "also if any of" across 12.4 s,
   *     then "you guys are" once speech resumed. They are laid out from the onset.
   */
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    const sf = frameOf(w.start);
    if (!inPause(sf)) continue;
    const onset = (runs.runEnd[sf] + 1) * FRAME_S;
    const pauseLen = (runs.runEnd[sf] - runs.runStart[sf] + 1) * FRAME_S;

    if (onset <= w.end - MIN_WORD_S) {        // case 1
      w.start = onset;
      continue;
    }
    // Case 2 only if the gap is about as long as the word could take to say. Measured: a
    // "this" sitting alone in a 650 ms gap fired 500 ms early — nobody takes 650 ms to say
    // "this". A fixed 0.7 s cut-off let exactly that through.
    if (pauseLen <= plausibleSeconds(w) + QUIET_SLACK_S) continue;   // case 2

    // Case 3: every word that starts before the onset belongs to the group…
    let j = i;
    while (j + 1 < out.length && out[j + 1].start < onset) j++;
    // …plus following words, while they leave no room for the group to be said.
    let k = j + 1;
    while (k < out.length && out[k].start < onset + MIN_WORD_S * (k - i) && k - i < MAX_GROUP) k++;
    const count = k - i;
    const windowEnd = Math.max(
      k < out.length ? out[k].start : onset + 0.25 * count,
      onset + MIN_WORD_S * count,
    );
    // Spread by letter count — a long word takes longer to say than "of" — across the
    // VOICED frames of the window only, so no word is placed back into a silence that
    // sits inside the window. (Absorbing further words when voice runs short was tried
    // and measured worse: 95 → 102 early words and 24 correct words dragged earlier,
    // because it re-spaces words whose timing was fine. The residue is whisper output
    // too garbled to place — e.g. a hallucinated loop over a stream's silent intro.)
    const weights = [];
    for (let m = i; m < k; m++) weights.push(Math.max(2, letters(out[m])));
    const total = weights.reduce((a, b) => a + b, 0);
    const f0 = frameOf(onset);
    const f1 = Math.max(f0 + 1, frameOf(windowEnd));
    const voicedFrames = [];
    for (let f = f0; f < f1; f++) if (runs.runStart[f] === -1) voicedFrames.push(f);
    if (voicedFrames.length < count) {
      // Not enough voice to place every word on it: fall back to an even spread.
      let t = onset;
      const d = (windowEnd - onset) / count;
      for (let m = i; m < k; m++) { out[m].start = t; out[m].end = t + d; t += d; }
    } else {
      let acc = 0;
      for (let m = i; m < k; m++) {
        const a = Math.floor((acc / total) * voicedFrames.length);
        acc += weights[m - i];
        const b = Math.max(a + 1, Math.floor((acc / total) * voicedFrames.length));
        out[m].start = voicedFrames[a] * FRAME_S;
        out[m].end = (voicedFrames[Math.min(voicedFrames.length - 1, b - 1)] + 1) * FRAME_S;
      }
    }
    i = k - 1;
  }

  // ENDS inside a clear pause → the word stopped where the voice decayed.
  for (const w of out) {
    const ef = frameOf(w.end) - 1;
    if (ef > frameOf(w.start) && inPause(ef)) {
      const offset = runs.runStart[ef] * FRAME_S + END_TAIL_S;
      if (offset >= w.start + MIN_WORD_S) w.end = Math.min(w.end, offset);
    }
  }

  /*
   * BOUNDARIES inside continuous speech (v3). Whisper's boundary between two abutting words
   * runs early: measured on a real stream, the nearest energy dip sat a median 50–60 ms
   * AFTER it (p25 −20, p75 +80 ms), so a caption switched while the previous word was still
   * sounding. Where the smoothed envelope shows a clear dip — DIP_DB under the level 150 ms
   * either side — within −30…+90 ms of the boundary, both words meet at the dip. A shallow
   * minimum on a flat stretch is noise, not a word edge, and is left alone.
   */
  if (voice.db) {
    const db = voice.db;
    const last = db.length - 1;
    const sm = (f) => (db[Math.max(0, f - 1)] + db[f] + db[Math.min(last, f + 1)]) / 3;
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1];
      const cur = out[i];
      if (cur.start - prev.end > 0.05) continue;                          // a real gap
      const fc = frameOf(cur.start);
      if (inPause(fc) || inPause(Math.max(0, frameOf(prev.end) - 1))) continue;  // handled above
      let best = fc;
      let bestV = Infinity;
      for (let f = fc - DIP_BACK_FRAMES; f <= fc + DIP_FWD_FRAMES; f++) {
        if (f < 1 || f >= last) continue;
        const v = sm(f);
        if (v < bestV) { bestV = v; best = f; }
      }
      const flank = Math.max(sm(Math.max(1, fc - 15)), sm(Math.min(last - 1, fc + 15)));
      if (flank - bestV < DIP_DB) continue;
      const t = best * FRAME_S;
      if (t - prev.start < MIN_WORD_S || cur.end - t < MIN_WORD_S) continue;
      cur.start = t;
      prev.end = t;
    }
  }

  let moved = 0;
  for (const w of out) {
    if (Math.abs(w.start - w.raw_start) > 0.02 || Math.abs(w.end - w.raw_end) > 0.02) moved++;
    w.start = +w.start.toFixed(3);
    w.end = +w.end.toFixed(3);
  }

  // Keep the sequence ordered and non-overlapping after the moves.
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    // Two words on the same instant cannot both be on screen first: separate by a frame.
    if (cur.start < prev.start + FRAME_S) cur.start = +(prev.start + FRAME_S).toFixed(3);
    if (prev.end > cur.start) prev.end = cur.start;
    if (cur.end <= cur.start) cur.end = +(cur.start + MIN_WORD_S).toFixed(3);
  }
  return { words: out, moved };
}

/** Build the voice model for an audio file once; reuse it for many refinements. */
function voiceModel(audioPath) {
  const { samples, sampleRate } = readPcm16(audioPath);
  const db = envelope(samples, sampleRate);
  const voiced = voicedFlags(db);
  return { db, voiced, runs: pauseRuns(voiced), frameSeconds: FRAME_S };
}

/**
 * Align a whole transcript's words. Returns a NEW transcript carrying `timing` and a small
 * `alignment` report; the original word times are preserved as raw_start/raw_end.
 */
function alignTranscript(transcript, audioPath, model = null) {
  const voice = model || voiceModel(audioPath);
  const { words, moved } = refineWordTimings(transcript.words || [], voice);
  return {
    ...transcript,
    words,
    timing: ALIGN_VERSION,
    alignment: { version: ALIGN_VERSION, wordsMoved: moved, words: words.length },
  };
}

/** Does a word start on voice (not inside a clear pause)? Used by verification. */
function startsOnVoice(t, voice) {
  const f = Math.max(0, Math.min(voice.voiced.length - 1, Math.round(t / FRAME_S)));
  return voice.runs.runStart[f] === -1;
}

module.exports = {
  ALIGN_VERSION,
  readPcm16,
  envelope,
  voicedFlags,
  pauseRuns,
  refineWordTimings,
  voiceModel,
  alignTranscript,
  startsOnVoice,
  FRAME_S,
  MIN_PAUSE_S,
};
