/**
 * Title verification gates.
 *
 * Mauricio's rule: a title promises a RESULT, and that result is what the clip actually
 * delivers — "not just 'I made $5,000'; it's 'I made $5,000, and what I did was X, X, X'".
 *
 * Stating that in a prompt is not enough. Prompt instructions drift, and a model asked to
 * write a compelling title will happily invent a number. These gates are code, they are
 * free, and they run before any model is asked for a second opinion. The numeral gate in
 * particular kills the exact failure the rule is about.
 */

const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or']);

const normalise = (s) => String(s || '')
  .toLowerCase()
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[^a-z0-9$%.' ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Contractions are expanded on BOTH sides before comparison.
 *
 * Without this the gate rejected a genuinely supported quote because the model wrote
 * "I am watching" where the trader said "I'm watching". The gate's job is to confirm the
 * claim is in the clip, not to police transcription style.
 */
const CONTRACTIONS = [
  [/\bi'm\b/g, 'i am'], [/\b(\w+)'re\b/g, '$1 are'], [/\b(\w+)'ve\b/g, '$1 have'],
  [/\b(\w+)'ll\b/g, '$1 will'], [/\b(\w+)n't\b/g, '$1 not'], [/\b(\w+)'d\b/g, '$1 would'],
  [/\bit's\b/g, 'it is'], [/\bthat's\b/g, 'that is'], [/\bhere's\b/g, 'here is'],
  [/\bthere's\b/g, 'there is'], [/\bwhat's\b/g, 'what is'],
  [/\bgonna\b/g, 'going to'], [/\bwanna\b/g, 'want to'],
];

const canon = (s) => {
  let t = normalise(s);
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
  return t
    .replace(/'/g, '')
    // Drop sentence punctuation but KEEP decimal points, so "vix." matches "vix" while
    // "2.5" stays intact. A trailing full stop was silently failing otherwise.
    .replace(/(?<!\d)\.|\.(?!\d)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Near-verbatim quote matching.
 *
 * Exact substring is brittle: one dropped filler word ("kind of", "like") sinks an
 * otherwise correct quote. This walks the quote's tokens through the transcript in order,
 * allowing small gaps, and asks what fraction were found consecutively enough. Strict
 * enough that invented evidence still fails — a hallucinated quote shares almost no
 * ordered run with the source.
 */
function quoteSupported(quote, haystack, threshold = 0.82) {
  const hay = canon(haystack);
  const needle = canon(quote);
  if (!needle || !hay) return false;
  if (hay.includes(needle)) return true;

  const q = needle.split(' ').filter(Boolean);
  const h = hay.split(' ').filter(Boolean);
  if (!q.length || q.length > h.length) return false;

  let best = 0;
  for (let i = 0; i < h.length; i++) {
    let qi = 0;
    let hits = 0;
    for (let j = i; j < h.length && qi < q.length; j++) {
      if (h[j] === q[qi]) { hits++; qi++; }
      else if (j - i > q.length + 5) break;   // drifted too far from this window
    }
    if (hits / q.length > best) best = hits / q.length;
    if (best >= threshold) return true;
  }
  return false;
}

/** Every numeric token a title asserts: $5,000 · 12% · 300 points · 2R · 14 */
function numerals(text) {
  const out = [];
  const re = /\$\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?|\b\d[\d,]*(?:\.\d+)?\s?%|\b\d[\d,]*(?:\.\d+)?\s?(?:R|pips?|points?|ticks?|handles?)\b|\b\d[\d,]*(?:\.\d+)?\b/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0].trim());
  return out;
}

/** Compare numbers by value, so "$5,000" in a title matches "5000" in a transcript. */
function numericValue(token) {
  const cleaned = String(token).replace(/[$,\s]/g, '').toLowerCase();
  const mult = /k$/.test(cleaned) ? 1000 : /m$/.test(cleaned) ? 1e6 : 1;
  const n = parseFloat(cleaned.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n * mult : null;
}

/**
 * GATE 1 — every number the title claims must actually be said in the clip.
 *
 * This is the single most important check. A title reading "I made $5,000" over a clip
 * where the trader never says a matching figure is the precise failure to prevent, and
 * it is the one a model produces most readily.
 */
function numeralGate(title, transcriptText) {
  const claimed = numerals(title);
  if (!claimed.length) return { passed: true, detail: 'No numbers claimed.' };

  const spoken = numerals(transcriptText).map(numericValue).filter((v) => v != null);
  const missing = [];
  for (const c of claimed) {
    const v = numericValue(c);
    if (v == null) continue;
    // Allow a little tolerance — "$4,279.93" spoken as "forty-two seventy-nine".
    const hit = spoken.some((s) => s === v || (v !== 0 && Math.abs(s - v) / Math.max(s, v) < 0.02));
    if (!hit) missing.push(c);
  }
  return missing.length
    ? { passed: false, detail: `The clip never says ${missing.join(', ')}.`, missing }
    : { passed: true, detail: `All ${claimed.length} number(s) are spoken in the clip.` };
}

/** GATE 2 — the cited evidence must be verbatim from the transcript, not paraphrased. */
function evidenceGate(evidence, transcriptText) {
  if (!evidence || !evidence.length) {
    return { passed: false, detail: 'No supporting quote was given.' };
  }
  const missing = [];
  for (const q of evidence) {
    const raw = q.quote ?? q;
    if (!raw || normalise(raw).length < 8) { missing.push(raw); continue; }
    if (!quoteSupported(raw, transcriptText)) missing.push(raw);
  }
  return missing.length
    ? { passed: false, detail: `Quote not found in the clip: "${String(missing[0]).slice(0, 60)}"`, missing }
    : { passed: true, detail: `${evidence.length} quote(s) verified verbatim.` };
}

/** GATE 3 — length and shape, so it fits the plate and reads as a headline. */
function shapeGate(title, { maxChars = 62, minWords = 3 } = {}) {
  const t = String(title || '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < minWords) return { passed: false, detail: `Too short (${words.length} words).` };
  if (t.length > maxChars) return { passed: false, detail: `${t.length} chars — over the ${maxChars} limit for the title plate.` };
  return { passed: true, detail: `${t.length} chars, ${words.length} words.` };
}

/**
 * GATE 4 — if the title promises a count ("3 things", "two mistakes"), the clip must
 * actually deliver that many. A title promising three steps over a clip that lists one is
 * the most seductive bad title a model writes.
 */
const NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
function enumerationGate(title, evidence) {
  const m = String(title).match(/\b(\d+|two|three|four|five|six|seven)\s+(things|ways|reasons|steps|mistakes|rules|tips|signs|levels)\b/i);
  if (!m) return { passed: true, detail: 'No count promised.' };
  const claimed = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUMBER_WORDS[m[1].toLowerCase()];
  const given = (evidence || []).length;
  return given >= claimed
    ? { passed: true, detail: `Promises ${claimed} ${m[2]}, ${given} supported.` }
    : { passed: false, detail: `Promises ${claimed} ${m[2]} but only ${given} are supported in the clip.` };
}

/** Run every gate. A title is only usable when all of them pass. */
function verifyTitle({ title, evidence = [], transcriptText, options = {} }) {
  const results = [
    { id: 'shape', name: 'Fits the plate', ...shapeGate(title, options) },
    { id: 'numerals', name: 'Numbers are spoken', ...numeralGate(title, transcriptText) },
    { id: 'evidence', name: 'Quotes are verbatim', ...evidenceGate(evidence, transcriptText) },
    { id: 'enumeration', name: 'Count is delivered', ...enumerationGate(title, evidence) },
  ];
  return { passed: results.every((r) => r.passed), results };
}

module.exports = { verifyTitle, numeralGate, evidenceGate, shapeGate, enumerationGate, numerals, numericValue, quoteSupported };
