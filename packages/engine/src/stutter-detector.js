/**
 * Deterministic stutter / mistake detection from Whisper word-level timing.
 *
 * Catches the patterns Whisper smooths away in the text but leaves visible in the timing:
 *   1. Same word back-to-back at word level (e.g. "traditional, traditional, …")
 *      → drop the earlier occurrence(s), keep the last.
 *   2. Suspicious gaps WITHIN a segment (typically 0.6–3.0s of "no transcribed words"
 *      sandwiched between transcribed words) — these are usually half-words / stutters
 *      that Whisper dropped from the text but the audio is still there.
 *      → drop the gap region.
 *   3. Words with abnormally long duration (> 1.2s for a single short word) sandwiched
 *      between cleanly-pronounced shorter occurrences of the same word — speaker stretched
 *      it trying to recover. → drop that long instance and the gap leading into the next take.
 *
 * Each detection is a {start_seconds, end_seconds, action, reason, note, confidence} object
 * matching the shape produced by the LLM cut-decider, so it merges cleanly into the same drop list.
 */

const PUNCT_RE = /[^a-z']/g;

function normalizeWord(w) {
  return String(w || '').toLowerCase().replace(PUNCT_RE, '').trim();
}

/**
 * Word range falls within a segment iff start/end are inside the segment's bounds.
 */
function findSegmentFor(wordStart, wordEnd, segments) {
  for (const s of segments || []) {
    if (wordStart >= s.start - 0.05 && wordEnd <= s.end + 0.05) return s;
  }
  return null;
}

function detectStutters(transcript, opts = {}) {
  const {
    minRepeatGap = 0.0,        // inclusive lower bound on inter-word gap for "back-to-back"
    maxRepeatGap = 0.5,        // inclusive upper bound — past this it's a deliberate restart, not a quick stutter
    minWordLengthForRepeat = 3, // ignore "a a", "I I" — those happen in normal speech
    // In-segment gap detection is conservative because comma/delivery pauses can run
    // 0.8-1.5s and we don't want to chop off legitimate content. Only flag gaps that
    // are clearly too long for a natural pause AND short enough to not be real silence.
    minSegmentGap = 1.6,        // raised from 0.6 — natural delivery commas can run > 1s
    maxSegmentGap = 3.0,        // gap longer than this = real silence between thoughts, not a stutter
    longWordDuration = 1.2,     // word duration above this counts as "stretched" / struggle
  } = opts;

  const words = (transcript.words || [])
    .slice()
    .sort((a, b) => a.start - b.start);
  const segments = transcript.segments || [];

  const cuts = [];

  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const cur = words[i];
    const prevText = normalizeWord(prev.word);
    const curText = normalizeWord(cur.word);
    const gap = cur.start - prev.end;

    // Pattern 1: word repeated back-to-back at word level
    if (
      prevText &&
      prevText === curText &&
      prevText.length >= minWordLengthForRepeat &&
      gap >= minRepeatGap &&
      gap <= maxRepeatGap
    ) {
      cuts.push({
        start_seconds: Math.max(0, prev.start - 0.03),
        end_seconds: cur.start,
        action: 'drop',
        reason: 'restart',
        note: `word "${prevText}" repeated back-to-back`,
        confidence: 0.95,
        source: 'stutter-detector',
      });
    }

    // Pattern 2: suspicious gap WITHIN a segment — Whisper transcribed nothing but audio probably has a stutter
    const prevSeg = findSegmentFor(prev.start, prev.end, segments);
    const curSeg = findSegmentFor(cur.start, cur.end, segments);
    const sameSeg = prevSeg && curSeg && prevSeg === curSeg;

    if (sameSeg && gap >= minSegmentGap && gap <= maxSegmentGap) {
      // Drop just the gap region — keep the surrounding words.
      cuts.push({
        start_seconds: prev.end + 0.03,
        end_seconds: cur.start - 0.03,
        action: 'drop',
        reason: 'mistake',
        note: `${gap.toFixed(2)}s gap inside segment (likely undocumented stutter)`,
        confidence: 0.88,
        source: 'stutter-detector',
      });
    }
  }

  // Pattern 3: stretched word followed shortly by a clean repetition of the same word
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i];
    const dur = w.end - w.start;
    if (dur < longWordDuration) continue;

    const text = normalizeWord(w.word);
    if (!text || text.length < 3) continue;

    // Look ahead within ~1.5s for a clean (shorter) repeat of the same word
    for (let j = i + 1; j < Math.min(i + 6, words.length); j++) {
      const cand = words[j];
      const candText = normalizeWord(cand.word);
      const candDur = cand.end - cand.start;
      const distance = cand.start - w.end;
      if (distance > 1.5) break;
      if (candText === text && candDur < dur * 0.6) {
        cuts.push({
          start_seconds: Math.max(0, w.start - 0.03),
          end_seconds: cand.start,
          action: 'drop',
          reason: 'restart',
          note: `stretched "${text}" (${dur.toFixed(2)}s) recovers to clean "${text}" (${candDur.toFixed(2)}s)`,
          confidence: 0.86,
          source: 'stutter-detector',
        });
        break;
      }
    }
  }

  return cuts;
}

/**
 * Merge programmatic stutter cuts with LLM cuts. If a stutter cut is fully covered by
 * an existing drop, skip it (LLM already got it). Otherwise add it.
 */
function mergeWithLlmCuts(llmCuts, stutterCuts) {
  const drops = (llmCuts || []).filter((c) => c.action === 'drop');
  const out = [...(llmCuts || [])];

  for (const s of stutterCuts) {
    const coveredBy = drops.find(
      (d) => d.start_seconds <= s.start_seconds + 0.05 && d.end_seconds >= s.end_seconds - 0.05,
    );
    if (!coveredBy) out.push(s);
  }
  return out.sort((a, b) => a.start_seconds - b.start_seconds);
}

module.exports = { detectStutters, mergeWithLlmCuts };
