/**
 * Transcription via local whisper.cpp.
 *
 * Replaces the v1 OpenAI Whisper API path, which had a hard 25MB ceiling and no chunking
 * — it simply could not transcribe a multi-hour trading livestream, which is the main
 * input this app is built for. whisper.cpp streams a file of any length.
 *
 * OUTPUT CONTRACT: this emits the same shape the OpenAI `verbose_json` response had —
 *   { language, duration, text, segments: [{id,start,end,text}], words: [{word,start,end}] }
 * — because silence-detector, cut-mapping, the ASS generator and clip selection all
 * already consume that shape. Matching it means nothing downstream had to change.
 */

const fs = require('fs');
const { alignTranscript, ALIGN_VERSION } = require('./captions/align');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const DEFAULT_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(os.homedir(), '.cache', 'whisper-models', 'ggml-large-v3-turbo-q5_0.bin');

/** New segment when the speaker lands a sentence, pauses, or runs long. */
const SENTENCE_END = /[.!?]["')\]]?$/;
const SEGMENT_GAP_SECONDS = 0.6;
const SEGMENT_MAX_WORDS = 18;

function runWhisper(args, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(WHISPER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      // whisper.cpp reports `whisper_print_progress_callback: progress =  42%`
      const m = s.match(/progress\s*=\s*(\d+)%/);
      if (m && onProgress) onProgress({ phase: 'transcribe', percent: parseInt(m[1], 10) });
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`whisper-cli exited ${code}: ${stderr.slice(-2000)}`))
    );
  });
}

/** whisper.cpp emits offsets in ms; everything else in this codebase speaks seconds. */
const ms = (v) => Math.round(v) / 1000;

/**
 * Group the one-word-per-entry output back into readable segments. Selection works on
 * segments (and returns segment INDICES, which is how boundaries stay honest), while
 * captions work on words — so we need both from a single pass.
 */
function groupWords(words) {
  const segments = [];
  let cur = null;

  for (const w of words) {
    if (!cur) {
      cur = { id: segments.length, start: w.start, end: w.end, words: [w] };
      continue;
    }
    const gap = w.start - cur.end;
    const prev = cur.words[cur.words.length - 1];
    const broke =
      SENTENCE_END.test(prev.word.trim()) ||
      gap >= SEGMENT_GAP_SECONDS ||
      cur.words.length >= SEGMENT_MAX_WORDS;

    if (broke) {
      segments.push(cur);
      cur = { id: segments.length, start: w.start, end: w.end, words: [w] };
    } else {
      cur.words.push(w);
      cur.end = w.end;
    }
  }
  if (cur) segments.push(cur);

  return segments.map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    text: s.words.map((w) => w.word).join('').replace(/\s+/g, ' ').trim(),
  }));
}

/**
 * Transcribe a 16kHz mono WAV. Cached on `<audio>.transcript.json` — transcription is the
 * slowest step in the pipeline and re-running a source must never pay for it twice.
 */
async function transcribe(audioPath, { model = DEFAULT_MODEL, language = 'en', threads, onProgress } = {}) {
  const cachePath = `${audioPath}.transcript.json`;
  if (fs.existsSync(cachePath)) {
    return loadTranscript(audioPath);
  }
  if (!fs.existsSync(model)) {
    throw new Error(
      `Whisper model not found at ${model}. Download one, e.g.\n` +
      `  curl -L -o "${model}" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${path.basename(model)}`
    );
  }

  const outPrefix = `${audioPath}.w`;
  await runWhisper([
    '-m', model,
    '-f', audioPath,
    '-l', language,
    '-t', String(threads || Math.max(4, os.cpus().length - 2)),
    // One entry per word: this is what gives word-level timing without a second pass.
    '--max-len', '1',
    '--split-on-word',
    '--output-json',
    '--output-json-full',
    '--no-prints',
    '-of', outPrefix,
  ], { onProgress });

  const jsonPath = `${outPrefix}.json`;
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  const words = (raw.transcription || [])
    .map((t) => ({
      word: t.text,
      start: ms(t.offsets.from),
      end: ms(t.offsets.to),
    }))
    .filter((w) => w.word && w.word.trim() && w.end > w.start);

  const segments = groupWords(words);
  const result = {
    language: (raw.result && raw.result.language) || language,
    duration: words.length ? words[words.length - 1].end : 0,
    text: segments.map((s) => s.text).join(' '),
    segments,
    // Trim here, not above: segment text needs the leading spaces to rejoin correctly.
    words: words.map((w) => ({ word: w.word.trim(), start: w.start, end: w.end })),
    engine: 'whisper.cpp',
    model: path.basename(model),
  };

  const aligned = alignOrKeep(result, audioPath);
  fs.writeFileSync(cachePath, JSON.stringify(aligned));
  fs.unlinkSync(jsonPath);
  return aligned;
}

/**
 * Snap word timings to the voice, or return the transcript untouched if alignment fails —
 * a transcript with whisper's timings is still better than no transcript.
 */
function alignOrKeep(transcript, audioPath) {
  try {
    return alignTranscript(transcript, audioPath);
  } catch (err) {
    console.warn(`[transcribe] word alignment skipped (${err.message})`);
    return transcript;
  }
}

/**
 * Read the cached transcript, upgrading it in place if its word timings predate the
 * current alignment. Every consumer that needs word TIMES must read through here: a
 * transcript read straight off disk may still carry whisper's tiled timings, which put
 * the word after every pause on screen before it is said.
 */
function loadTranscript(audioPath) {
  const cachePath = `${audioPath}.transcript.json`;
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  if (cached.timing === ALIGN_VERSION) return cached;
  const aligned = alignOrKeep(cached, audioPath);
  if (aligned.timing === ALIGN_VERSION) {
    const tmp = `${cachePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(aligned));
    fs.renameSync(tmp, cachePath);
  }
  return aligned;
}

module.exports = { transcribe, loadTranscript, groupWords, DEFAULT_MODEL };
