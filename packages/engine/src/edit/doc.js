/**
 * The clip's composition document — the ONE description of an edited clip that both the
 * editor's live preview and the ffmpeg export consume.
 *
 * WHY ONE DOCUMENT. v1's editor kept range/cuts in one JSON file and caption words in
 * per-span track files, and the two drifted apart: every trim or cut deleted the caption
 * track, and every render rebuilt captions from the raw transcript per span, so a word an
 * editor fixed never reached the output. Here the document owns range, cuts, format, title,
 * caption styling and per-word edits, and the renderer reads nothing else.
 *
 * Words are identified by their index in the (voice-aligned) transcript, so an edit
 * survives any trim or cut that keeps the word.
 *
 * Pure functions only: no disk, no database.
 */

const DOC_VERSION = 1;

// Every format the editor offers — the four band layouts AND the eight re-composed ones. The
// first version listed only the band family, so `normalizeDoc` silently turned "chart over
// trader" back into "title above" before the preview or the renderer ever saw it.
const VARIANTS = require('../compose/pane-geometry').listVariants().map((v) => v.id);
const CAPTION_MODES = ['word', 'highlight'];
const CASES = ['as-spoken', 'upper'];

const TITLE_DEFAULTS = {
  text: '',
  font: 'Sequel Sans Bold Head',
  size: 66,
  color: '#111111',
  box: true,
  boxColor: '#FFFFFF',
  outline: false,
  outlineColor: '#000000',
  // null = the whole clip. A number = that many seconds.
  hold: null,
  // Plate centre on the 1080×1920 canvas; null = the format's default position (centred).
  x: null,
  y: null,
};

const CAPTION_DEFAULTS = {
  enabled: true,
  mode: 'word',
  font: 'Sequel Sans Black Body',
  size: 84,
  color: '#FFFFFF',
  highlightColor: '#FFE500',
  case: 'as-spoken',
  // Caption block centre X and BOTTOM edge on the canvas; null = the format's defaults.
  x: null,
  y: null,
};

const HEX = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => (Number.isFinite(+v) ? +v : fallback);
const color = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : fallback);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

/** Sort, clamp to the range, and merge overlapping cuts. Zero-length cuts are dropped. */
function normalizeCuts(cuts, range) {
  const list = (Array.isArray(cuts) ? cuts : [])
    .map((c) => ({
      start: clamp(num(c.start, range.start), range.start, range.end),
      end: clamp(num(c.end, range.start), range.start, range.end),
      source: typeof c.source === 'string' ? c.source : 'manual',
    }))
    .filter((c) => c.end - c.start > 0.005)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of list) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
      if (last.source !== c.source) last.source = 'mixed';
    } else merged.push({ ...c });
  }
  return merged.map((c) => ({ start: +c.start.toFixed(3), end: +c.end.toFixed(3), source: c.source }));
}

/** The document a clip starts from: exactly the machine's plan. */
function defaultDoc(clip) {
  const range = { start: clip.start_s, end: clip.end_s };
  let cuts = [];
  try { cuts = JSON.parse(clip.cuts_json || '[]'); } catch {}
  return normalizeDoc({
    v: DOC_VERSION,
    range,
    cuts,
    splits: [],
    format: { variant: 'band-title-top' },
    title: { ...TITLE_DEFAULTS, text: clip.title_text || '' },
    captions: { ...CAPTION_DEFAULTS },
    words: {},
  }, clip);
}

/**
 * Validate and clamp anything the browser sent. Unknown keys are dropped, bad values fall
 * back to defaults — a malformed save must never produce a malformed render.
 */
function normalizeDoc(input, clip) {
  const d = input && typeof input === 'object' ? input : {};
  const r = d.range || {};
  let start = num(r.start, clip.start_s);
  let end = num(r.end, clip.end_s);
  if (end - start < 1) end = start + 1;
  const range = { start: +start.toFixed(3), end: +end.toFixed(3) };

  const t = { ...TITLE_DEFAULTS, ...(d.title || {}) };
  const title = {
    text: String(t.text ?? '').slice(0, 120),
    font: typeof t.font === 'string' && t.font ? t.font : TITLE_DEFAULTS.font,
    size: clamp(Math.round(num(t.size, TITLE_DEFAULTS.size)), 32, 130),
    color: color(t.color, TITLE_DEFAULTS.color),
    box: t.box !== false,
    boxColor: color(t.boxColor, TITLE_DEFAULTS.boxColor),
    outline: !!t.outline,
    outlineColor: color(t.outlineColor, TITLE_DEFAULTS.outlineColor),
    hold: t.hold == null || !(num(t.hold, 0) > 0) ? null : clamp(num(t.hold, 0), 1, 600),
    x: t.x == null ? null : clamp(Math.round(num(t.x, 540)), 60, 1020),
    y: t.y == null ? null : clamp(Math.round(num(t.y, 0)), 60, 1860),
  };

  const c = { ...CAPTION_DEFAULTS, ...(d.captions || {}) };
  const captions = {
    enabled: c.enabled !== false,
    mode: oneOf(c.mode, CAPTION_MODES, CAPTION_DEFAULTS.mode),
    font: typeof c.font === 'string' && c.font ? c.font : CAPTION_DEFAULTS.font,
    size: clamp(Math.round(num(c.size, CAPTION_DEFAULTS.size)), 40, 160),
    color: color(c.color, CAPTION_DEFAULTS.color),
    highlightColor: color(c.highlightColor, CAPTION_DEFAULTS.highlightColor),
    case: oneOf(c.case, CASES, CAPTION_DEFAULTS.case),
    x: c.x == null ? null : clamp(Math.round(num(c.x, 540)), 60, 1020),
    y: c.y == null ? null : clamp(Math.round(num(c.y, 0)), 200, 1880),
  };

  // Split markers: editing-only boundaries inside the range. They change nothing in the
  // render, but they must round-trip so a piece the editor split stays separately trimmable.
  const splits = [...new Set((Array.isArray(d.splits) ? d.splits : [])
    .map((v) => num(v, NaN))
    .filter((v) => Number.isFinite(v) && v > range.start && v < range.end)
    .map((v) => +v.toFixed(3)))].sort((a, b) => a - b);

  const words = {};
  for (const [k, w] of Object.entries(d.words || {})) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || !w || typeof w !== 'object') continue;
    const o = {};
    if (typeof w.text === 'string') o.text = w.text.slice(0, 40);
    if (Number.isFinite(+w.start)) o.start = +(+w.start).toFixed(3);
    if (Number.isFinite(+w.end)) o.end = +(+w.end).toFixed(3);
    if (o.start != null && o.end != null && o.end <= o.start) delete o.end;
    if (w.hidden === true) o.hidden = true;
    if (Object.keys(o).length) words[i] = o;
  }

  return {
    v: DOC_VERSION,
    range,
    cuts: normalizeCuts(d.cuts, range),
    splits,
    format: { variant: oneOf(d.format && d.format.variant, VARIANTS, VARIANTS[0]) },
    title,
    captions,
    words,
  };
}

/** Kept spans of the document: the range minus its cuts. */
function keptSpansOf(doc) {
  const spans = [];
  let t = doc.range.start;
  for (const c of doc.cuts) {
    if (c.start > t) spans.push({ start: t, end: c.start });
    t = Math.max(t, c.end);
  }
  if (doc.range.end > t) spans.push({ start: t, end: doc.range.end });
  return spans;
}

/**
 * The transcript words inside the document's range, with the editor's overrides applied.
 * `i` is the transcript index — the identity every edit is keyed by.
 */
function docWords(doc, transcript) {
  const all = (transcript && transcript.words) || [];
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    if (w.end <= doc.range.start - 0.05 || w.start >= doc.range.end) continue;
    const o = doc.words[i] || {};
    out.push({
      i,
      word: w.word,
      text: o.text ?? w.word,
      edited_text: o.text != null ? o.text : null,
      start: o.start ?? w.start,
      end: o.end ?? w.end,
      hidden: !!o.hidden,
    });
  }
  return out;
}

/**
 * Transcript words inside an arbitrary source-time window (the editor's proxy window), with
 * the document's overrides applied and each word flagged as in/out of the clip's range and
 * inside/outside a cut — the transcript panel and the timeline draw from this one list.
 */
function wordsInWindow(doc, transcript, start, end) {
  const all = (transcript && transcript.words) || [];
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    if (w.end <= start || w.start >= end) continue;
    const o = doc.words[i] || {};
    const ws = o.start ?? w.start;
    const we = o.end ?? w.end;
    const inRange = ws >= doc.range.start - 0.05 && ws < doc.range.end;
    const inCut = doc.cuts.some((c) => ws >= c.start && ws < c.end);
    out.push({
      i,
      word: w.word,
      text: o.text ?? w.word,
      edited: o.text != null,
      start: ws,
      end: we,
      hidden: !!o.hidden,
      inRange,
      cut: inRange && inCut,
    });
  }
  return out;
}

/** Everything the band renderer needs, derived from the document alone. */
function docToRenderParams(doc, transcript) {
  const spans = keptSpansOf(doc);
  const manualCuts = doc.cuts.map((c) => ({ start: c.start, end: c.end, source: c.source }));
  const words = docWords(doc, transcript).filter((w) => !w.hidden);
  return {
    variant: doc.format.variant,
    startSeconds: doc.range.start,
    endSeconds: doc.range.end,
    manualCuts,
    spans,
    words,
    captionsEnabled: doc.captions.enabled,
    titleText: doc.title.text || null,
    titleSeconds: doc.title.hold,
    titleStyle: {
      fontName: doc.title.font,
      fontSize: doc.title.size,
      textColor: doc.title.color,
      // Box off = a fully transparent fill; the plate keeps its padding so text never
      // touches the canvas edge.
      fill: doc.title.box ? doc.title.boxColor : '#00000000',
      radius: doc.title.box ? 26 : 0,
      strokeWidth: doc.title.outline ? 8 : 0,
      strokeColor: doc.title.outlineColor,
      x: doc.title.x,
      y: doc.title.y,
    },
    captionStyle: {
      mode: doc.captions.mode,
      font_family: doc.captions.font,
      font_size_px: doc.captions.size,
      primary_color: doc.captions.color,
      highlight_color: doc.captions.highlightColor,
      case: doc.captions.case,
      x: doc.captions.x,
      y: doc.captions.y,
    },
  };
}

module.exports = {
  DOC_VERSION, VARIANTS, CAPTION_MODES, TITLE_DEFAULTS, CAPTION_DEFAULTS,
  defaultDoc, normalizeDoc, normalizeCuts, keptSpansOf, docWords, wordsInWindow, docToRenderParams,
};
