/**
 * Phrase captions with the SPOKEN word lit up — the "highlight" mode.
 *
 * The style in the operator's reference (a short phrase on screen, the active word in
 * yellow) did not exist in the engine: karaoke fills words and leaves them filled, and the
 * reveal mode ignores highlight colour entirely. This module decides WHAT is on screen and
 * WHEN; ass-generator draws it for the export, and the editor's preview API returns the same
 * events so the browser draws exactly what the export will burn in.
 *
 * Pure: words in → events out. Times are OUTPUT seconds.
 */

const SENTENCE_END = /[.!?…]["')\]]?$/;

const PHRASE_DEFAULTS = {
  maxWords: 4,
  // Rough glyph budget for one line at the default size; two lines are allowed.
  maxLineChars: 16,
  maxLines: 2,
  // A pause this long ends the phrase: the next words belong to a new thought.
  pauseBreak: 0.45,
  // A phrase never freezes on screen across a long silence.
  maxHold: 2.5,
};

const clean = (w) => String(w.edited_text ?? w.text ?? w.word ?? '').trim();

/** Group consecutive words into phrases that fit the line budget and break at real pauses. */
function groupPhrases(words, opts = {}) {
  const o = { ...PHRASE_DEFAULTS, ...opts };
  const budget = o.maxLineChars * o.maxLines;
  const phrases = [];
  let cur = [];
  let chars = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const text = clean(w);
    if (!text) continue;
    const prev = cur[cur.length - 1];
    const breakHere = prev && (
      cur.length >= o.maxWords ||
      chars + 1 + text.length > budget ||
      SENTENCE_END.test(clean(prev)) ||
      w.start - prev.end > o.pauseBreak
    );
    if (breakHere) { phrases.push(cur); cur = []; chars = 0; }
    cur.push({ ...w, text });
    chars += (chars ? 1 : 0) + text.length;
  }
  if (cur.length) phrases.push(cur);
  return phrases;
}

/** Split a phrase's words into at most two balanced lines. */
function splitLines(words, maxLineChars) {
  const total = words.reduce((n, w) => n + w.text.length, 0) + Math.max(0, words.length - 1);
  if (total <= maxLineChars || words.length < 2) return [words];
  let best = 1;
  let bestDiff = Infinity;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).reduce((n, w) => n + w.text.length, 0) + (k - 1);
    const b = total - a - 1;
    const diff = Math.abs(a - b);
    if (diff < bestDiff) { bestDiff = diff; best = k; }
  }
  return [words.slice(0, best), words.slice(best)];
}

/**
 * One event per spoken word: the whole phrase is visible, the word being said is active.
 * The active word changes EXACTLY at each word's start — which is why word starts must be
 * voice-aligned (captions/align.js) — and the phrase holds until the next one begins.
 */
function highlightEvents(words, opts = {}) {
  const o = { ...PHRASE_DEFAULTS, ...opts };
  const phrases = groupPhrases(words, o);
  const events = [];
  phrases.forEach((ph, p) => {
    const nextPhraseStart = p + 1 < phrases.length ? phrases[p + 1][0].start : null;
    const lastEnd = ph[ph.length - 1].end;
    const phraseEnd = nextPhraseStart != null
      ? Math.min(nextPhraseStart, Math.max(lastEnd, ph[0].start) + o.maxHold)
      : lastEnd + 0.3;
    const lines = splitLines(ph, o.maxLineChars);
    ph.forEach((w, k) => {
      const start = w.start;
      const end = k + 1 < ph.length ? ph[k + 1].start : phraseEnd;
      if (end - start < 0.01) return;
      let idx = 0;
      events.push({
        start: +start.toFixed(3),
        end: +Math.max(start + 0.01, end).toFixed(3),
        lines: lines.map((line) => line.map((x) => ({ text: x.text, active: idx++ === k }))),
      });
    });
  });
  return events;
}

/** Word-by-word events (the "word" mode), in the same shape, for the preview. */
function wordEvents(words, { maxHold = 2.5 } = {}) {
  const list = words.map((w) => ({ ...w, text: clean(w) })).filter((w) => w.text);
  return list.map((w, i) => {
    const next = list[i + 1];
    const end = next ? Math.min(next.start, w.start + maxHold) : w.end + 0.3;
    return {
      start: +w.start.toFixed(3),
      end: +Math.max(w.start + 0.01, end).toFixed(3),
      lines: [[{ text: w.text, active: true }]],
    };
  });
}

module.exports = { groupPhrases, splitLines, highlightEvents, wordEvents, PHRASE_DEFAULTS };
