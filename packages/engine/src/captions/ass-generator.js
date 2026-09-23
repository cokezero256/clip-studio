/**
 * Generate an ASS (Advanced SubStation Alpha) subtitle file from a caption track + style.
 *
 * Modes:
 *   - Replace mode: each chunk replaces the previous (legacy preset behavior). Karaoke
 *     `\K` highlight per word inside the chunk.
 *   - Viral mode (track.auto_chunked === true and style.animation === 'reveal'): chunks
 *     are grouped into PHRASES that stay visible together (stacked multi-line). Words
 *     fade in one-by-one via `\alpha\t()` as they're spoken. Per-word emphasis maps to
 *     `style.variants[emphasis]` and is applied inline with `\fn\fs\c\b\i`.
 *
 * Color encoding: ASS uses `&H<AA><BB><GG><RR>` — alpha + bytes REVERSED from #RRGGBB.
 * Handled in hexToAss().
 *
 * Position encoding: \pos(x,y) uses PlayResX/Y coords; we set those to the rendered
 * frame size so a single style preset works across crop modes.
 */

const fs = require('fs');
const path = require('path');
const { groupWords } = require('./word-grouper');

// Phrase stacking is the "20% case" — multiple chunks shown together as stacked lines.
// Default for viral reveal mode is REPLACE: each chunk is its own phrase that fades in
// then disappears as the next chunk arrives at the same screen position. Stacking is
// triggered only by a tight cluster of short chunks (`STACK_GAP_SEC` between chunks)
// around an emphasized peak — that's the visual moment where 2–3 small chunks naturally
// build up before clearing.
const PHRASE_MAX_LINES = 3;
const PHRASE_MAX_DURATION_SEC = 4.0;
const STACK_GAP_SEC = 0.35;
// Reveal animation: scale-fade entrance per word — text starts at 92% scale + 0% opacity
// and lands at 100% scale + 100% opacity over REVEAL_DUR_MS. Snappy 60ms (~2 frames at
// 30fps) — slow enough to read as a soft scale-in, fast enough to feel like a hard pop.
const REVEAL_DUR_MS = 60;
const REVEAL_START_SCALE = 92;
const TAIL_SEC = 0.20;

function buildAss(opts) {
  const { track, style, frameDims, clipStart = 0, titlePos = null } = opts;
  const { width: w, height: h } = frameDims;

  // Font sizes in the preset are calibrated for a 1920-tall reference frame (vertical
  // 1080×1920). On a horizontal 1920×1080 frame this would render WAY too big, so we
  // scale all sizes by the actual frame height / 1920. Vertical render: scale = 1.0.
  // Horizontal render: scale = 1080/1920 ≈ 0.5625.
  const sizeScale = h / 1920;

  const wordsLocal = (track.words || []).map((wd) => ({
    ...wd,
    start: Math.max(0, wd.start - clipStart),
    end: Math.max(0, wd.end - clipStart),
  }));

  /*
   * HIGHLIGHT mode: a short phrase stays on screen and the word being SAID is coloured.
   * Timing comes from captions/phrases.js, which the editor's preview also uses, so the
   * browser shows exactly what is burned in here.
   */
  if (style.animation === 'highlight') {
    const { highlightEvents } = require('./phrases');
    const yPctH = track.position_y_offset_pct ?? style.y_offset_pct ?? 0.72;
    const size = Math.round((style.font_size_px || 84) * sizeScale);
    const events = highlightEvents(wordsLocal.map((wd) => ({ ...wd, text: wd.edited_text ?? wd.text })), {
      maxLineChars: Math.max(8, Math.floor((w * 0.9) / (size * 0.6))),
    });
    const primary = inlineColor(style.primary_color || '#FFFFFF');
    const hl = inlineColor(style.highlight_color || '#FFE500');
    const edgeBlur = style.shadow && Number.isFinite(style.shadow.edge_blur) ? Math.max(0, style.shadow.edge_blur) : 0;
    const cx = Number.isFinite(style.x_center_px) ? Math.round(style.x_center_px) : Math.round(w / 2);
    const pos = `\\an2\\pos(${cx},${Math.round(h * yPctH)})${edgeBlur > 0 ? `\\be${edgeBlur}` : ''}`;
    const dialogues = events.map((ev) => {
      const body = ev.lines.map((line) => line.map((x) => {
        const t = applyCase(x.text, style.case).replace(/[{}]/g, '');
        return x.active ? `{\\1c${hl}}${t}{\\1c${primary}}` : t;
      }).join(' ')).join('\\N');
      return `Dialogue: 0,${secondsToAssTime(ev.start)},${secondsToAssTime(ev.end)},Default,,0,0,0,,{${pos}}${body}`;
    });
    return assDocument(w, h, style, sizeScale, dialogues);
  }

  const isAuto = track.auto_chunked === true;
  const isReveal = style.animation === 'reveal' && isAuto;
  // stack_enabled defaults to true. When false, every chunk becomes its own phrase
  // (no V-shape stacking) — used by the "plain" preset.
  const stacksAllowed = isReveal && style.stack_enabled !== false;

  const chunks = groupWords(wordsLocal, {
    auto: isAuto,
    chunkSize: track.chunk_size ?? 2,
    // 0 = one word per chunk (house default). A style opts into merged phrases by
    // setting caption_min_chunk_seconds; size and hold are independent knobs.
    minChunkSeconds: track.min_chunk_seconds ?? style.caption_min_chunk_seconds ?? 0,
    maxWords: track.max_chunk_words ?? style.caption_max_chunk_words ?? 4,
  });

  const phrases = groupChunksIntoPhrases(chunks, wordsLocal, {
    stack: stacksAllowed,
    maxLines: PHRASE_MAX_LINES,
    maxDurationSec: PHRASE_MAX_DURATION_SEC,
  });

  const yPct = track.position_y_offset_pct ?? style.y_offset_pct ?? 0.72;
  const yCenter = Math.round(h * yPct);
  const xCenter = Number.isFinite(style.x_center_px) ? Math.round(style.x_center_px) : Math.round(w / 2);
  const anchor = style.anchor === 'center' ? 'center' : (isReveal ? 'bottom' : 'center');

  const events = phrases.map((phrase, idx) => {
    const nextStart = idx + 1 < phrases.length ? phrases[idx + 1].chunks[0].start : null;
    return isReveal
      ? buildRevealDialogue(phrase, wordsLocal, style, { xCenter, yCenter, nextPhraseStart: nextStart, anchor, sizeScale })
      : buildKaraokeDialogue(phrase.chunks[0], wordsLocal, style, { xCenter, yCenter, sizeScale, nextChunkStart: nextStart });
  });

  // Optional title bar — static white text at the top of the frame, shown for the full
  // clip duration. Used primarily by split-screen renders.
  if (typeof track.title_text === 'string' && track.title_text.trim()) {
    const clipDurSec = phrases.length > 0
      ? phrases[phrases.length - 1].chunks[phrases[phrases.length - 1].chunks.length - 1].end + 1.0
      : 10000;
    // buildTitleDialogue returns one line, or two when the title is boxed (plate + text).
    events.unshift(...buildTitleDialogue({
      text: track.title_text.trim(),
      durationSec: clipDurSec,
      frameW: w,
      frameH: h,
      sizeScale,
      style,
      titlePos,
    }));
  }

  return assDocument(w, h, style, sizeScale, events);
}

/** Wrap dialogue lines in the ASS header + base style. */
function assDocument(w, h, style, sizeScale, events) {
  return [
    '[Script Info]',
    '; Generated by lib/captions/ass-generator.js',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${buildBaseStyleLine(style, sizeScale)}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

function buildBaseStyleLine(style, sizeScale = 1.0) {
  const fontFamily = style.font_family || 'Arial';
  const fontSize = Math.max(8, Math.round((style.font_size_px || 60) * sizeScale));
  const primary = hexToAss(style.primary_color || '#FFFFFF');
  const secondary = hexToAss(style.highlight_color || style.primary_color || '#FFFFFF');
  const outline = hexToAss(style.outline_color || '#000000');
  const outlineWidth = style.outline_width_px ?? 3;
  const shadow = style.shadow || null;
  // No shadow if style.shadow is null/false — gives a perfectly clean text-on-video look.
  // BackColour with full alpha keeps the shadow rendering disabled even with depth>0 (safety).
  const shadowDepth = shadow ? Math.max(0, shadow.offset_y_px ?? 2) : 0;
  // Shadow opacity (0..1, default fully opaque). ASS alpha is inverted (00=opaque,
  // FF=transparent), so a low opacity → high alpha byte. Lets a style request a soft,
  // low-opacity black shadow behind the text instead of a hard backing.
  const shadowOpacity = shadow ? (typeof shadow.opacity === 'number' ? shadow.opacity : 1) : 0;
  const shadowAlphaByte = Math.max(0, Math.min(255, Math.round((1 - shadowOpacity) * 255)));
  const shadowAlphaHex = shadowAlphaByte.toString(16).padStart(2, '0').toUpperCase();
  const shadowRgb = (shadow && shadow.color ? shadow.color : '#000000').replace(/^#/, '');
  const shadowBgr = shadowRgb.length === 6
    ? shadowRgb.slice(4, 6) + shadowRgb.slice(2, 4) + shadowRgb.slice(0, 2)
    : '000000';
  const backColor = shadow ? `&H${shadowAlphaHex}${shadowBgr}` : '&HFF000000';
  // bold: true (=-1 = use the font's bold face), false (=0 = regular), OR a numeric
  // weight 100-900 for variable fonts (libass renders the matching weight axis).
  const bold = typeof style.bold === 'number'
    ? String(style.bold)
    : (style.bold === true ? '-1' : '0');
  const italic = style.italic === true ? '-1' : '0';

  // Letter spacing — preset can set `letter_spacing_px` (or `letter_spacing` for backward
  // compatibility). Positive values track OUT (looser); negative values track IN (tighter,
  // designer feel — e.g. -1 to -2 for headlines).
  const letterSpacing = Math.round((style.letter_spacing_px ?? style.letter_spacing ?? 0) * sizeScale);

  return [
    'Default',
    fontFamily,
    String(fontSize),
    primary,           // PrimaryColour — base color
    secondary,         // SecondaryColour — karaoke pre-tick (only used in replace mode)
    outline,           // OutlineColour
    backColor,         // BackColour — alpha=FF (transparent) when no shadow requested
    bold,
    italic,
    '0',               // Underline
    '0',               // StrikeOut
    '100', '100',      // ScaleX, ScaleY
    String(letterSpacing),  // Spacing (letter tracking)
    '0',               // Angle
    '1',               // BorderStyle 1 = outline+shadow (use 0-width outline for "no stroke" + shadow only)
    String(outlineWidth),
    String(shadowDepth),
    '5',               // Alignment 5 = center-center (overridden by \pos)
    '0', '0', '0',
    '1',               // Encoding
  ].join(',');
}

/**
 * Decide which consecutive chunks group into a stacked phrase vs which stand alone.
 *
 * In viral reveal mode the rule is:
 *   - DEFAULT: each chunk is its own phrase. Replaces previous on screen (word-by-word).
 *   - STACK: 2–3 chunks join into a phrase ONLY when they form a tight peak cluster:
 *       (a) chunks are within STACK_GAP_SEC of each other (back-to-back delivery)
 *       (b) at least one chunk in the group is emphasized
 *       (c) total lines ≤ PHRASE_MAX_LINES (3) and total words ≤ 6 (1–2 per line)
 *       (d) duration ≤ PHRASE_MAX_DURATION_SEC
 *
 * In replace mode (legacy presets), every chunk is its own phrase regardless.
 */
function groupChunksIntoPhrases(chunks, words, opts) {
  if (!opts.stack || chunks.length === 0) {
    return chunks.map((c) => ({ chunks: [c] }));
  }

  // Cap total words across a stacked phrase at 3 (V-shape spec). With AUTO_MAX_WORDS=2
  // in the word-grouper, this lets us produce stacks like 1+2 or 1+1+1 words.
  const PHRASE_MAX_WORDS = 3;
  const phrases = [];
  let i = 0;

  function chunkHasEmphasis(chunk) {
    return chunk.word_indexes.some((wi) => {
      const w = words[wi];
      return w && w.emphasis && w.emphasis !== 'none';
    });
  }
  function lastWordEndsSentence(chunk) {
    const lastIdx = chunk.word_indexes[chunk.word_indexes.length - 1];
    const lastWord = words[lastIdx];
    const text = (lastWord.edited_text != null && lastWord.edited_text !== '')
      ? lastWord.edited_text : lastWord.text;
    return /[.!?…]/.test(String(text).trim()) || lastWord.newline_after === true;
  }
  function chunkWords(chunk) { return chunk.word_indexes.length; }

  while (i < chunks.length) {
    const head = chunks[i];
    // Try to extend the head into a stacked phrase.
    const group = [head];
    let j = i + 1;
    while (j < chunks.length && group.length < opts.maxLines) {
      const prev = group[group.length - 1];
      const next = chunks[j];
      const gap = next.start - prev.end;
      const groupWords = group.reduce((n, c) => n + chunkWords(c), 0);
      const groupDuration = next.end - group[0].start;
      const hitSentence = lastWordEndsSentence(prev);

      if (hitSentence) break;
      if (gap > STACK_GAP_SEC) break;
      if (groupWords + chunkWords(next) > PHRASE_MAX_WORDS) break;
      if (groupDuration > opts.maxDurationSec) break;
      group.push(next);
      j++;
    }

    // V-shape rule: a stack only commits if the EMPHASIZED chunk is the LAST one in the
    // group (bottom of the stack). The bottom line is visually heavier (accent Vartigo or
    // large Helvetica), forming the funnel "top = small filler, bottom = power word".
    // If the candidate group has emphasis somewhere in the middle, trim the tail until
    // the last chunk IS the emphasized one; everything after that becomes its own
    // single-chunk phrase on the next loop iteration.
    let committed = false;
    if (group.length > 1) {
      let lastPeakIdx = -1;
      for (let k = group.length - 1; k >= 0; k--) {
        if (chunkHasEmphasis(group[k])) { lastPeakIdx = k; break; }
      }
      // Need (a) at least one peak and (b) the peak somewhere except the very first
      // position alone (we want 2+ chunks with peak at the bottom).
      if (lastPeakIdx >= 1) {
        const trimmed = group.slice(0, lastPeakIdx + 1);
        phrases.push({ chunks: trimmed });
        i += trimmed.length;
        committed = true;
      }
    }
    if (!committed) {
      phrases.push({ chunks: [head] });
      i += 1;
    }
  }

  return phrases;
}

/**
 * Reveal mode (viral): one Dialogue for the whole phrase, words fade in via \alpha\t().
 * Per-word emphasis maps to style.variants[emphasis] applied inline.
 */
function buildRevealDialogue(phrase, words, style, { xCenter, yCenter, nextPhraseStart = null, anchor = 'center', sizeScale = 1.0 }) {
  const phraseStart = phrase.chunks[0].start;
  const naturalEnd = phrase.chunks[phrase.chunks.length - 1].end + TAIL_SEC;
  // Cap end at the next phrase's start so consecutive phrases don't overlap on screen.
  let phraseEnd = nextPhraseStart != null
    ? Math.min(naturalEnd, nextPhraseStart)
    : naturalEnd;
  /**
   * HOW LONG A CAPTION STAYS UP.
   *
   * There used to be a hard rule here: a single-chunk phrase expired 0.4s after it began.
   * With `stack_enabled: false` EVERY phrase is a single chunk, so every caption vanished
   * after 400ms and the screen sat blank until the next word. Measured on a real render:
   * captions were on screen for only 45-90% of each segment, averaging ~60% — four of six
   * sampled frames had no text at all.
   *
   * Reference reels hold each caption until the next one replaces it, so text is
   * continuously present. That is the default now. `caption_hold: "punch"` restores the
   * old flash-and-clear behaviour for styles that want it.
   */
  const hold = style.caption_hold || 'continuous';
  if (hold === 'punch' && phrase.chunks.length === 1) {
    phraseEnd = Math.min(phraseEnd, phraseStart + 0.4);
  } else if (hold === 'continuous' && nextPhraseStart != null) {
    // Hold right up to the next phrase, so there is no blank frame between words.
    // MAX_HOLD stops a caption freezing on screen across an unusually long pause.
    const MAX_HOLD = 2.5;
    phraseEnd = Math.min(nextPhraseStart - 0.001, phraseStart + MAX_HOLD);
    // Prefer not to end before the words finish being spoken — but NEVER outlive the next
    // caption's appearance. Two captions on screen at once is the "disordered captions"
    // defect; a caption clipped a few ms early is invisible. The cap wins.
    phraseEnd = Math.min(
      Math.max(phraseEnd, phrase.chunks[phrase.chunks.length - 1].end),
      nextPhraseStart - 0.001,
    );
  }
  // \an2 = bottom-center: text grows UPWARD from a fixed bottom edge. Position stays
  // stable even when line count changes — without this, a 1-line phrase centers at Y
  // and a 2-line phrase straddles Y, causing the captions to "bounce" between phrases.
  // \an5 = center-center: legacy anchor (kept for non-viral presets).
  const anTag = anchor === 'bottom' ? '\\an2' : '\\an5';
  // Edge blur softens both the text edge and the offset shadow, giving a clean "soft
  // drop shadow" look instead of the hard-edged ghost shadow that reads as a stroke.
  const edgeBlur = style.shadow && Number.isFinite(style.shadow.edge_blur)
    ? Math.max(0, style.shadow.edge_blur)
    : 0;
  const beTag = edgeBlur > 0 ? `\\be${edgeBlur}` : '';
  // baseSize after frame-height scaling — all variant sizes (size_px or size_multiplier)
  // compose with this so a `size_multiplier: 1.7` variant stays 1.7× the (scaled) base
  // and an absolute `size_px: 150` variant scales proportionally with the frame.
  const baseSize = Math.max(8, Math.round((style.font_size_px || 60) * sizeScale));

  const lineParts = phrase.chunks.map((chunk) => {
    return chunk.word_indexes.map((wi, posInLine) => {
      const word = words[wi];
      const wordStartMs = Math.round((word.start - phraseStart) * 1000);
      const emphasis = word.emphasis || 'none';
      const variant = emphasis !== 'none' ? (style.variants && style.variants[emphasis]) : null;

      const overrides = ['\\r']; // reset to base style first

      // Per-emphasis entrance animation tiers ("Creator Room" style brief):
      //   none   → instant cut (1ms alpha snap), keeps the "Flow" rhythm snappy
      //   large  → glow pop: scale 108→100 + quick alpha fade (~50ms), informational peak
      //   accent → soft scale-fade: 92→100 + alpha (~140ms), emotional Vartigo peak
      //   script → identical to accent for now
      let endMs;
      if (emphasis === 'none') {
        endMs = wordStartMs + 1;
        overrides.push(`\\alpha&HFF&\\t(${wordStartMs},${endMs},\\alpha&H00&)`);
      } else if (emphasis === 'large') {
        endMs = wordStartMs + 60;
        overrides.push(`\\fscx108\\fscy108\\t(${wordStartMs},${endMs},\\fscx100\\fscy100)`);
        overrides.push(`\\alpha&HFF&\\t(${wordStartMs},${wordStartMs + 30},\\alpha&H00&)`);
      } else {
        // accent / script — Vartigo soft scale-fade
        endMs = wordStartMs + REVEAL_DUR_MS;
        overrides.push(`\\fscx${REVEAL_START_SCALE}\\fscy${REVEAL_START_SCALE}\\t(${wordStartMs},${endMs},\\fscx100\\fscy100)`);
        overrides.push(`\\alpha&HFF&\\t(${wordStartMs},${endMs},\\alpha&H00&)`);
      }

      if (variant) {
        if (variant.font_family) overrides.push(`\\fn${variant.font_family}`);
        if (typeof variant.size_px === 'number') {
          // Absolute size_px is calibrated for a 1920-tall frame, scale to current frame.
          overrides.push(`\\fs${Math.max(8, Math.round(variant.size_px * sizeScale))}`);
        } else if (typeof variant.size_multiplier === 'number') {
          overrides.push(`\\fs${Math.round(baseSize * variant.size_multiplier)}`);
        }
        if (variant.color) overrides.push(`\\c${hexToAss(variant.color)}`);
        if (typeof variant.outline_width_px === 'number') {
          overrides.push(`\\bord${variant.outline_width_px}`);
        }
        if (variant.italic === true) overrides.push('\\i1');
        if (variant.italic === false) overrides.push('\\i0');
        if (typeof variant.bold === 'number') overrides.push(`\\b${variant.bold}`);
        else if (variant.bold === true) overrides.push('\\b1');
        else if (variant.bold === false) overrides.push('\\b0');
      }

      const display = (word.edited_text != null && word.edited_text !== '')
        ? word.edited_text : word.text;
      const text = applyCase(String(display).trim(), style.case);
      const space = posInLine < chunk.word_indexes.length - 1 ? ' ' : '';

      return `{${overrides.join('')}}${text}${space}`;
    }).join('');
  });

  const text = lineParts.join('\\N');

  const startCs = secondsToAssTime(phraseStart);
  const endCs = secondsToAssTime(phraseEnd);
  const posTag = `${anTag}\\pos(${xCenter},${yCenter})${beTag}`;
  const body = `{${posTag}}${text}`;

  return `Dialogue: 0,${startCs},${endCs},Default,,0,0,0,,${body}`;
}

/**
 * Replace mode (legacy): one Dialogue per chunk with karaoke `\K` highlighting.
 * Used by non-viral presets that don't define `animation: "reveal"`.
 */
function buildKaraokeDialogue(chunk, words, style, { xCenter, yCenter, sizeScale = 1.0, nextChunkStart = null }) {
  const chunkWords = chunk.word_indexes.map((i) => words[i]);
  const karaokeText = chunkWords.map((wd, idx) => {
    const durationCs = Math.max(1, Math.round((wd.end - wd.start) * 100));
    const display = (wd.edited_text != null && wd.edited_text !== '') ? wd.edited_text : wd.text;
    const text = applyCase(String(display).trim(), style.case);
    return `{\\K${durationCs}}${text}${idx < chunkWords.length - 1 ? ' ' : ''}`;
  }).join('');

  // Swap primary/secondary so karaoke flows base → highlight per word
  const primary = hexToAss(style.primary_color || '#FFFFFF');
  const highlight = hexToAss(style.highlight_color || style.primary_color || '#FFFFFF');
  const colorSwap = `\\1c${highlight}\\2c${primary}`;

  const startCs = secondsToAssTime(chunk.start);
  /**
   * The +50ms tail exists so captions don't flicker off between chunks. But whisper's
   * word timings tile, so the NEXT chunk often starts within that 50ms — and two phrases
   * then render simultaneously at the same \pos, drawing on top of each other. Observed
   * on a real clip as "with"/"resistance" overlaid into "wigbore sistapce".
   *
   * So: hold the caption, but never past the moment the next one appears.
   */
  const paddedEnd = chunk.end + 0.05;
  const cappedEnd = nextChunkStart != null
    ? Math.min(paddedEnd, Math.max(chunk.end, nextChunkStart - 0.001))
    : paddedEnd;
  const endCs = secondsToAssTime(cappedEnd);
  const posTag = `\\an5\\pos(${xCenter},${yCenter})`;
  const body = `{${posTag}${colorSwap}}${karaokeText}`;

  return `Dialogue: 0,${startCs},${endCs},Default,,0,0,0,,${body}`;
}

/**
 * Emit a Dialogue line for the optional static title bar.
 * Positioned via \pos at the top-center of the frame (y ≈ 80 px on a 1920-tall frame,
 * scaled). Uses the base style's font family, slightly smaller than the body for hierarchy.
 *
 * Auto-fits the title so it never overflows the canvas:
 *   1. If the text fits on one line at the configured size → emit as-is.
 *   2. If not, find the word-break that best balances the two lines and check if they
 *      fit at the original size. Use \N to render 2 lines.
 *   3. If the longest line still overflows, shrink the font proportionally until it fits.
 */
/**
 * Rounded rectangle as an ASS drawing path.
 *
 * The reference reels put the title in a white rounded box sitting on the seam between the
 * two panes. libass has no box-with-radius primitive — BorderStyle=3 gives square corners
 * only — but it does support drawing mode with cubic beziers, so the box is drawn rather
 * than approximated. That keeps everything inside the single subtitles filter instead of
 * adding an image-compositing pass.
 */
function roundedRectPath(w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  // ASS drawing units are 1/1 with \p1. `b` is a cubic bezier: two controls + endpoint.
  return [
    `m ${rr} 0`,
    `l ${w - rr} 0`,
    `b ${w} 0 ${w} 0 ${w} ${rr}`,
    `l ${w} ${h - rr}`,
    `b ${w} ${h} ${w} ${h} ${w - rr} ${h}`,
    `l ${rr} ${h}`,
    `b 0 ${h} 0 ${h} 0 ${h - rr}`,
    `l 0 ${rr}`,
    `b 0 0 0 0 ${rr} 0`,
  ].join(' ');
}

function buildTitleDialogue({ text, durationSec, frameW, frameH, sizeScale, style, titlePos = null }) {
  const headerCfg = style.header || {};
  const fontFamily = headerCfg.font_family || style.font_family || 'Helvetica';
  const weight = typeof headerCfg.bold === 'number' ? `\\b${headerCfg.bold}` : '\\b1';
  const color = headerCfg.color || '#FFFFFF';
  // Strip ASS control characters; newlines in source text become spaces.
  const safeText = String(text).replace(/[{}\\]/g, '').replace(/\n/g, ' ').trim();

  // Position/anchor/size come from the layout config when provided (PlayRes == canvas,
  // so coords + font size are in raw canvas pixels — no sizeScale needed). Fall back to
  // the legacy top-centre placement when no layout is supplied.
  const an = titlePos ? titlePos.an : 8;
  const posX = titlePos ? titlePos.x : Math.round(frameW / 2);
  const posY = titlePos ? titlePos.y : Math.round(80 * (frameH / 1920));
  const nominalSize = titlePos
    ? Math.max(10, titlePos.fontSize)
    : Math.max(10, Math.round((headerCfg.font_size_px || 96) * sizeScale));
  const minFontSize = Math.max(10, Math.round(20 * (titlePos ? 1 : sizeScale)));
  const bord = titlePos && typeof titlePos.bord === 'number' ? titlePos.bord : 0;
  const shad = titlePos && typeof titlePos.shad === 'number' ? titlePos.shad : 0;

  // Left-anchored titles (an 1/4/7) wrap against the right edge from x; centred titles
  // (an 2/5/8) wrap symmetrically. Give fitTitle the usable width accordingly.
  const leftAnchored = an === 1 || an === 4 || an === 7;
  const fitWidth = leftAnchored ? (frameW - posX) * 2 : frameW;

  const { text: fittedText, fontSize } = fitTitle({
    text: safeText,
    frameW: fitWidth,
    nominalSize,
    minFontSize,
  });

  const endCs = secondsToAssTime(durationSec);
  const box = headerCfg.box || (titlePos && titlePos.box) || null;

  // Plain title (no box) — the original behaviour.
  if (!box || box.enabled === false) {
    const tag = `\\an${an}\\pos(${posX},${posY})\\fn${fontFamily}\\fs${fontSize}${weight}\\c${hexToAss(color)}\\bord${bord}\\shad${shad}`;
    return [`Dialogue: 0,0:00:00.00,${endCs},Default,,0,0,0,,{${tag}}${fittedText}`];
  }

  // Boxed title: measure the fitted text, draw the plate, then set the text on top.
  const lines = fittedText.split('\\N');
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const CHAR_W = 0.6;                       // same estimate fitTitle uses
  const LINE_H = 1.22;
  const padX = box.pad_x ?? Math.round(fontSize * 0.55);
  const padY = box.pad_y ?? Math.round(fontSize * 0.34);
  const textW = Math.round(longest * fontSize * CHAR_W);
  const textH = Math.round(lines.length * fontSize * LINE_H);
  const boxW = textW + padX * 2;
  const boxH = textH + padY * 2;
  const radius = box.radius ?? Math.round(fontSize * 0.32);

  // Resolve the plate's top-left from the text anchor so box and text stay locked together.
  const centred = an === 2 || an === 5 || an === 8;
  const left = centred ? Math.round(posX - boxW / 2)
             : (an === 1 || an === 4 || an === 7) ? posX
             : Math.round(posX - boxW);
  const top = (an >= 7) ? posY
            : (an >= 4) ? Math.round(posY - boxH / 2)
            : Math.round(posY - boxH);

  const fill = hexToAss(box.fill || '#FFFFFF');
  const plate =
    `Dialogue: 0,0:00:00.00,${endCs},Default,,0,0,0,,` +
    `{\\an7\\pos(${left},${top})\\c${fill}\\bord0\\shad0\\p1}` +
    `${roundedRectPath(boxW, boxH, radius)}{\\p0}`;

  // Text centred inside the plate, regardless of the requested anchor.
  const textColor = hexToAss(box.text_color || '#000000');
  const cx = left + Math.round(boxW / 2);
  const cy = top + Math.round(boxH / 2);
  const textTag =
    `\\an5\\pos(${cx},${cy})\\fn${fontFamily}\\fs${fontSize}${weight}` +
    `\\c${textColor}\\bord0\\shad0`;

  // Plate first so the text paints over it (same layer, later line wins in libass).
  return [plate, `Dialogue: 0,0:00:00.00,${endCs},Default,,0,0,0,,{${textTag}}${fittedText}`];
}

/**
 * Determine the display text and font size so the title never overflows frameW.
 *
 * Uses 0.6 * fontSize as a conservative per-character width estimate for proportional
 * sans-serif fonts (slightly over-estimates narrow chars, but errs on the safe side).
 *
 * Strategy:
 *   1. Single line fits at nominalSize → return as-is.
 *   2. Wrap to 2 lines at the word boundary that minimises max(line1.len, line2.len).
 *      If both lines fit at nominalSize → return with \N separator.
 *   3. If the longest line still overflows → shrink the font proportionally.
 *   4. Single-word titles that overflow (no word break available) → shrink only.
 *
 * @param {object} p
 * @param {string} p.text       Already-sanitised title text (no ASS control chars).
 * @param {number} p.frameW     Canvas width in pixels.
 * @param {number} p.nominalSize Desired font size in pixels (pre-scaled by sizeScale).
 * @param {number} p.minFontSize Absolute floor on font size (prevents unreadable text).
 * @returns {{ text: string, fontSize: number }}
 */
function fitTitle({ text, frameW, nominalSize, minFontSize = 10 }) {
  const CHAR_W = 0.6; // avg char width as a fraction of font size (safe upper bound)
  const maxPx = frameW * 0.88; // 6 % breathing room on each side

  function estPx(str, fs) { return str.length * fs * CHAR_W; }

  // 1. Single line fits?
  if (estPx(text, nominalSize) <= maxPx) return { text, fontSize: nominalSize };

  // 2. Try balanced 2-line wrap.
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    let bestSplit = 1;
    let bestImbalance = Infinity;
    for (let s = 1; s < words.length; s++) {
      const imbalance = Math.abs(
        words.slice(0, s).join(' ').length - words.slice(s).join(' ').length,
      );
      if (imbalance < bestImbalance) { bestImbalance = imbalance; bestSplit = s; }
    }
    const l1 = words.slice(0, bestSplit).join(' ');
    const l2 = words.slice(bestSplit).join(' ');
    const longestLen = Math.max(l1.length, l2.length);

    // 2a. Both lines fit at the original size?
    if (estPx(l1, nominalSize) <= maxPx && estPx(l2, nominalSize) <= maxPx) {
      return { text: `${l1}\\N${l2}`, fontSize: nominalSize };
    }
    // 2b. Shrink to fit the longer line.
    const shrunk = Math.max(minFontSize, Math.floor(maxPx / (longestLen * CHAR_W)));
    return { text: `${l1}\\N${l2}`, fontSize: shrunk };
  }

  // 3. Single long word — can only shrink.
  const shrunk = Math.max(minFontSize, Math.floor(maxPx / (text.length * CHAR_W)));
  return { text, fontSize: shrunk };
}

function writeAssFile(outputPath, opts) {
  const content = buildAss(opts);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf-8');
  return outputPath;
}

function hexToAss(hex) {
  if (!hex || typeof hex !== 'string') return '&H00FFFFFF';
  const cleaned = hex.replace(/^#/, '').toUpperCase();
  let r = 'FF', g = 'FF', b = 'FF', a = '00';
  if (cleaned.length === 6) {
    r = cleaned.slice(0, 2);
    g = cleaned.slice(2, 4);
    b = cleaned.slice(4, 6);
  } else if (cleaned.length === 8) {
    a = invertAlpha(cleaned.slice(0, 2));
    r = cleaned.slice(2, 4);
    g = cleaned.slice(4, 6);
    b = cleaned.slice(6, 8);
  }
  return `&H${a}${b}${g}${r}`;
}

/** Inline colour override form (`&HBBGGRR&`) — hexToAss returns `&HAABBGGRR`. */
function inlineColor(hex) {
  return `&H${hexToAss(hex).slice(4)}&`;
}

function invertAlpha(hexAa) {
  const n = parseInt(hexAa, 16);
  return (255 - n).toString(16).padStart(2, '0').toUpperCase();
}

function secondsToAssTime(seconds) {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor((total - Math.floor(total)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function applyCase(text, caseMode) {
  switch (caseMode) {
    case 'upper': return text.toUpperCase();
    case 'lower': return text.toLowerCase();
    case 'title':
      return text.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    case 'as-spoken':
    default: return text;
  }
}

module.exports = { buildAss, writeAssFile, hexToAss, secondsToAssTime, applyCase };
