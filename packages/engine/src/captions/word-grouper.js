/**
 * Group Whisper word-level timestamps into chunks for caption display.
 *
 * Two modes:
 *   - fixed:  legacy mode, target N words per chunk (`chunkSize`).
 *   - auto:   word-by-word replace style. Each word is its own chunk by default; small
 *             articles ("a", "an", "the") attach to the immediate next content word so
 *             they don't flash alone for 100ms. The phrase grouper (in ass-generator.js)
 *             decides which consecutive chunks, if any, stack into a multi-line "phrase";
 *             by default chunks REPLACE each other in the same screen position.
 */

const SENTENCE_ENDERS = /[.!?…]/;
const PAUSE_BREAK_SECONDS = 0.7;
const AUTO_MAX_WORDS = 4;
/**
 * A chunk must stay on screen long enough to READ.
 *
 * Whisper word durations swing wildly — measured on a real clip: 110ms, 180ms, 250ms,
 * 400ms in a single sentence. Rendering each word for exactly its spoken duration makes
 * short words strobe, which is what reads on screen as disordered captions. So consecutive
 * words are merged until the chunk reaches a readable floor. Long words still stand alone;
 * only the fast ones group up.
 */
/**
 * Default: 0 — ONE WORD PER CHUNK. This is the house style.
 *
 * History, because this was got wrong twice in opposite directions. Words were first
 * rendered for exactly their spoken duration, and short ones (110-180ms is normal) flashed
 * and vanished — which reads on screen as disordered captions. That was misdiagnosed as
 * "the chunks are too small" and fixed by merging words up to a 0.7s floor, which produced
 * short phrases and lost the word-by-word style the client actually wants.
 *
 * The strobe was never caused by chunk SIZE. It was caused by each caption EXPIRING at the
 * end of its word. With `caption_hold: 'continuous'` every chunk now holds on screen until
 * the next one appears, so a 110ms word is still legible while remaining a single word.
 * Size and hold are independent, and conflating them is what caused both bugs.
 *
 * Set `caption_min_chunk_seconds` in a style to get merged phrases instead.
 */
const MIN_CHUNK_SECONDS = 0;
const MERGE_MAX_GAP = 0.45;
// Tiny articles that read awkwardly on their own line — attach to the next word.
const ARTICLES = new Set(['a', 'an', 'the']);

function groupWords(words, opts = {}) {
  const auto = opts.auto === true;
  const chunkSize = Math.max(1, Math.min(8, opts.chunkSize ?? 2));
  // 0 (the default) means one word per chunk — no merging at all.
  const minChunkSeconds = Math.max(0, opts.minChunkSeconds ?? MIN_CHUNK_SECONDS);
  const maxWords = Math.max(1, Math.min(8, opts.maxWords ?? AUTO_MAX_WORDS));
  if (!Array.isArray(words) || words.length === 0) return [];

  const cleaned = words.map((w) => {
    const display = (w.edited_text != null && w.edited_text !== '') ? w.edited_text : w.text;
    return { ...w, _display: String(display || '').trim() };
  });

  if (auto) return autoGroup(cleaned, { minChunkSeconds, maxWords });
  return fixedGroup(cleaned, chunkSize);
}

function autoGroup(words, { minChunkSeconds = MIN_CHUNK_SECONDS, maxWords = AUTO_MAX_WORDS } = {}) {
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (!w._display) { i++; continue; }

    const start = w.start;
    const indexes = [i];
    const articleKey = w._display.toLowerCase().replace(/[^a-z']/g, '');
    let end = w.end;

    // If the current word is an article AND the next non-empty word exists within a
    // short pause (< 0.5s) AND is not also an article — attach them so the article
    // doesn't flash alone.
    if (minChunkSeconds > 0 && ARTICLES.has(articleKey)) {
      let j = i + 1;
      while (j < words.length && !words[j]._display) j++;
      if (j < words.length) {
        const nextKey = words[j]._display.toLowerCase().replace(/[^a-z']/g, '');
        const gap = words[j].start - w.end;
        if (gap < 0.5 && !ARTICLES.has(nextKey)) {
          indexes.push(j);
          end = words[j].end;
          i = j;
        }
      }
    }
    /**
     * Absorb following words until the chunk is readable.
     *
     * Whisper word durations swing wildly — measured on a real clip: 110ms, 150ms, 180ms,
     * 400ms within one sentence. Showing each word for exactly its spoken duration makes
     * the short ones strobe, which is what reads on screen as disordered captions. Long
     * words still stand alone; only fast ones group up.
     */
    let j = i + 1;
    while ((end - start) < minChunkSeconds && indexes.length < maxWords) {
      while (j < words.length && !words[j]._display) j++;
      if (j >= words.length) break;
      const prev = words[indexes[indexes.length - 1]];
      if (SENTENCE_ENDERS.test(prev._display)) break;      // never run past a sentence end
      if (words[j].start - end > MERGE_MAX_GAP) break;     // a real pause — let it breathe
      indexes.push(j);
      end = words[j].end;
      i = j;
      j++;
    }

    // The start of the next word that will actually be displayed — the floor above must
    // never cross it, or two captions share the screen.
    let nx = i + 1;
    while (nx < words.length && !words[nx]._display) nx++;
    const nextStart = nx < words.length ? words[nx].start : null;

    chunks.push(finalizeChunk({
      word_indexes: indexes,
      start,
      end,
      text: indexes.map((k) => words[k]._display).join(' '),
    }, nextStart));
    i++;
  }
  return chunks;
}

function fixedGroup(words, chunkSize) {
  const chunks = [];
  let current = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w._display) continue;
    if (!current) {
      current = makeChunk(i, w, w._display);
      continue;
    }
    const prevIdx = current.word_indexes[current.word_indexes.length - 1];
    const prevWord = words[prevIdx];
    const gap = w.start - prevWord.end;
    const hitSentenceEnd = SENTENCE_ENDERS.test(prevWord._display);
    const hitPause = gap >= PAUSE_BREAK_SECONDS;
    const hitExplicitBreak = prevWord.newline_after === true;
    const hitSize = current.word_indexes.length >= chunkSize;

    if (hitSentenceEnd || hitPause || hitExplicitBreak || hitSize) {
      chunks.push(finalizeChunk(current));
      current = makeChunk(i, w, w._display);
    } else {
      current.word_indexes.push(i);
      current.text += ' ' + w._display;
      current.end = w.end;
    }
  }
  if (current) chunks.push(finalizeChunk(current));
  return chunks;
}

function makeChunk(index, word, text) {
  return { word_indexes: [index], start: word.start, end: word.end, text };
}

/**
 * A minimum on-screen duration, clamped so it can never reach the NEXT chunk's start.
 *
 * Without the clamp this floor was the source of overlapping captions: the word "I" is
 * spoken for 40ms, got padded to 150ms, and so was still on screen when "made" appeared
 * 40ms later — two words stacked at once, which is what reads as disordered captions.
 * Measured on one 59s clip: 28 overlapping pairs out of 140.
 *
 * The floor is mostly redundant now — `caption_hold: 'continuous'` already holds every
 * caption until the next one appears — but it is kept for the LAST chunk, which has no
 * successor to hold against.
 */
function finalizeChunk(chunk, nextStart = null) {
  if (chunk.end - chunk.start < 0.15) {
    const wanted = chunk.start + 0.15;
    chunk.end = nextStart != null ? Math.min(wanted, nextStart) : wanted;
  }
  return chunk;
}

module.exports = { groupWords, PAUSE_BREAK_SECONDS, AUTO_MAX_WORDS };
