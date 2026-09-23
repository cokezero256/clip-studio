/**
 * Per-clip caption track storage.
 *
 * A "track" is the persisted state of captions for one clip:
 *   - words[]                 — Whisper words filtered to this clip's time range, with optional
 *                               edited_text, emphasis, and newline_after.
 *   - chunk_size              — preferred grouping (1, 2, 3 words) when auto_chunked is false
 *   - auto_chunked            — true = variable 1-4 word chunks driven by sentence/pause/emphasis
 *   - position_y_offset_pct   — overrides style.y_offset_pct when set
 *   - style_id                — which style preset to use
 *
 * Per-word `emphasis` values: 'none' (default) | 'accent' (red Vartigo) | 'script' (white Vartigo)
 * | 'large' (bigger bold Helvetica). The renderer looks up the matching `variants[emphasis]`
 * block in the style preset.
 *
 * Persisted at `output/<name>/captions/<clipId>.json`. Auto-generated from the cached
 * Whisper transcript on first read; subsequent edits saved by the dashboard.
 */

const fs = require('fs');
const path = require('path');

const VALID_EMPHASIS = new Set(['none', 'accent', 'script', 'large']);

function trackPath(outputDir, clipId) {
  return path.join(outputDir, 'captions', `${clipId}.json`);
}

function ensureDir(outputDir) {
  fs.mkdirSync(path.join(outputDir, 'captions'), { recursive: true });
}

/**
 * @param {object} opts
 * @param {string} opts.outputDir
 * @param {string} opts.clipId
 * @param {object} opts.clip                { start_seconds, end_seconds, ... }
 * @param {object} opts.transcript          Whisper verbose_json (must contain `words`).
 * @param {string} [opts.defaultStyleId]    Default: 'viral-mozzo-plain'.
 * @returns {object} The track. Persisted to disk if newly generated.
 */
function loadOrGenerateTrack(opts) {
  const { outputDir, clipId, clip, transcript, defaultStyleId = 'viral-mozzo-plain' } = opts;
  const filePath = trackPath(outputDir, clipId);

  if (fs.existsSync(filePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      // Staleness guard: if the clip's source boundaries changed since the track was
      // generated, the word list is anchored to the wrong time range — regenerate.
      const boundsChanged =
        typeof saved.clip_start_seconds === 'number' &&
        typeof saved.clip_end_seconds === 'number' &&
        (Math.abs(saved.clip_start_seconds - clip.start_seconds) > 0.01 ||
         Math.abs(saved.clip_end_seconds - clip.end_seconds) > 0.01);
      // A track built from whisper's raw timings shows the word after every pause early;
      // regenerate it from the aligned transcript.
      const staleTiming = (transcript && transcript.timing) && saved.timing !== transcript.timing;
      if (!boundsChanged && !staleTiming) return saved;
      console.warn(
        `[track-store] clip ${clipId} bounds changed ` +
        `(${saved.clip_start_seconds}–${saved.clip_end_seconds} → ` +
        `${clip.start_seconds}–${clip.end_seconds}), re-anchoring captions`,
      );
    } catch (err) {
      console.warn(`[track-store] failed to parse ${clipId} track, regenerating: ${err.message}`);
    }
  }

  const allWords = transcript?.words || [];
  const lo = clip.start_seconds - 0.05;
  const hi = clip.end_seconds + 0.05;
  const filtered = allWords
    .filter((w) => typeof w.start === 'number' && typeof w.end === 'number')
    .filter((w) => w.end >= lo && w.start <= hi)
    .map((w, i) => ({
      i,
      text: String(w.word || '').trim(),
      start: w.start,
      end: w.end,
      edited_text: null,
      emphasis: 'none',
      newline_after: false,
    }))
    .filter((w) => w.text.length > 0)
    .map((w, i) => ({ ...w, i })); // re-index after filter

  /**
   * auto_chunked triggers reveal-mode rendering (word-by-word, per-word emphasis) rather
   * than the legacy karaoke phrase highlight.
   *
   * This used to be a hardcoded allowlist — and it listed the SAME id three times
   * (`new Set(['viral-mozzo-plain','viral-mozzo-plain','viral-mozzo-plain'])`), a leftover
   * from when one style was force-locked. The effect was that ANY newly added style
   * silently fell back to karaoke, so a style declaring `animation: "reveal"` didn't get
   * it. Ask the style what it wants instead of maintaining a name list.
   */
  const styleDoc = (() => {
    try { return require('./style-store').loadStyle(defaultStyleId); } catch { return null; }
  })();
  const wantsReveal = styleDoc ? styleDoc.animation === 'reveal' : false;
  const track = {
    clip_id: clipId,
    // Which word-timing version these words came from (see captions/align.js).
    timing: (transcript && transcript.timing) || null,
    clip_start_seconds: clip.start_seconds,
    clip_end_seconds: clip.end_seconds,
    style_id: defaultStyleId,
    auto_chunked: wantsReveal,
    auto_emphasized: false,  // flips to true after AI pass runs (success OR no-op), so it only fires once
    chunk_size: 2,
    position_y_offset_pct: null,
    title_text: null,  // optional static title bar at the top of the frame (used by split-screen renders mainly)
    words: filtered,
  };

  ensureDir(outputDir);
  fs.writeFileSync(filePath, JSON.stringify(track, null, 2), 'utf-8');
  return track;
}

/**
 * If the track is on a "reveal" preset and AI emphasis hasn't been attempted, run it
 * and persist the marks. Idempotent on subsequent calls. Safe to call from any caller
 * (editor GET, renderer pre-render) since both paths converge here before display.
 *
 * @returns the updated track (or the original if AI was skipped / failed).
 */
// Style IDs that opt INTO the AI emphasis pass. Add new viral-style presets here as
// they're created; presets that don't have variants (or want plain captions) stay out.
const AI_EMPHASIS_STYLES = new Set([
  // Plain viral is the only style and is intentionally kept OUT — captions stay clean,
  // word-by-word white text with no AI-colored/large emphasis variants.
]);

async function ensureAiEmphasis({ outputDir, clipId, track, force = false, aiNotes }) {
  if (!track) return track;
  if (!AI_EMPHASIS_STYLES.has(track.style_id)) return track;
  if (track.auto_emphasized === true && !force) return track;

  // Auto-load per-video AI notes from outputDir/ai-notes.txt unless the caller passed
  // them explicitly. Keeps every code path picking up notes without per-caller plumbing.
  let effectiveNotes = aiNotes;
  if (effectiveNotes === undefined && outputDir) {
    try {
      const notesPath = path.join(outputDir, 'ai-notes.txt');
      if (fs.existsSync(notesPath)) effectiveNotes = fs.readFileSync(notesPath, 'utf-8');
    } catch { /* notes are optional */ }
  }

  // Lazy require so non-render callers don't pay the Anthropic SDK import cost if unused.
  const { markEmphasis } = require('./emphasis-ai');
  try {
    const { emphasis } = await markEmphasis(track.words, { aiNotes: effectiveNotes || '' });
    if (emphasis && emphasis.length > 0) {
      const idx = new Map(emphasis.map((e) => [e.word_index, e.style]));
      track.words = track.words.map((w) => ({
        ...w,
        emphasis: idx.get(w.i) || 'none',
      }));
    }
  } catch (err) {
    console.warn('[track-store] AI emphasis failed, leaving as-is:', err.message || err);
  }
  track.auto_emphasized = true;
  ensureDir(outputDir);
  fs.writeFileSync(trackPath(outputDir, clipId), JSON.stringify(track, null, 2), 'utf-8');
  return track;
}

/**
 * Save a track with shallow validation. Returns the saved object.
 */
function saveTrack(outputDir, clipId, track) {
  ensureDir(outputDir);
  if (!track || !Array.isArray(track.words)) {
    throw new Error('Track must have a words[] array.');
  }
  const cleaned = {
    clip_id: clipId,
    clip_start_seconds: typeof track.clip_start_seconds === 'number' ? track.clip_start_seconds : undefined,
    clip_end_seconds: typeof track.clip_end_seconds === 'number' ? track.clip_end_seconds : undefined,
    style_id: typeof track.style_id === 'string' ? track.style_id : 'viral-mozzo-plain',
    auto_chunked: track.auto_chunked === true || track.auto_chunked === undefined,
    auto_emphasized: track.auto_emphasized === true,
    chunk_size: Math.max(1, Math.min(8, parseInt(track.chunk_size, 10) || 2)),
    position_y_offset_pct:
      typeof track.position_y_offset_pct === 'number'
        ? Math.max(0, Math.min(1, track.position_y_offset_pct))
        : null,
    title_text:
      typeof track.title_text === 'string' && track.title_text.trim() !== ''
        ? track.title_text.trim().slice(0, 200)
        : null,
    words: track.words.map((w, i) => ({
      i,
      text: String(w.text || '').trim(),
      start: Number(w.start) || 0,
      end: Number(w.end) || 0,
      edited_text:
        w.edited_text != null && String(w.edited_text).trim() !== ''
          ? String(w.edited_text)
          : null,
      emphasis: VALID_EMPHASIS.has(w.emphasis) ? w.emphasis : 'none',
      newline_after: w.newline_after === true,
    })),
  };
  fs.writeFileSync(trackPath(outputDir, clipId), JSON.stringify(cleaned, null, 2), 'utf-8');
  return cleaned;
}

module.exports = { loadOrGenerateTrack, ensureAiEmphasis, saveTrack, trackPath, VALID_EMPHASIS };
