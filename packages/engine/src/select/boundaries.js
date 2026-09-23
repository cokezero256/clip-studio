/**
 * Sentence boundary derivation — engine-agnostic.
 *
 * THE TRAP THIS EXISTS FOR: the two transcription engines disagree about punctuation in a
 * way that silently breaks clip selection.
 *
 *   whisper.cpp  words[] = ["I'm", "gonna", "try", "gold.", ...]   ← punctuation PRESENT
 *   OpenAI       words[] = ["Okay", "I'm", "going", "to", ...]     ← punctuation STRIPPED
 *
 * Measured on real files: 13/85 whisper.cpp words carry `.!?`, versus 0/5962 OpenAI words.
 * OpenAI keeps punctuation only in `segments[].text`.
 *
 * Detecting sentence ends by testing each word therefore finds exactly ONE sentence start
 * on an OpenAI transcript (index 0), which produces ZERO candidates and no error — the
 * worst failure shape there is. So boundaries are derived from whichever source actually
 * carries them, per transcript.
 */

const SENTENCE_END = /[.!?]["')\]]?$/;

/**
 * Returns a Set of word indices that END a sentence.
 * Strategy A (preferred): the words themselves carry punctuation.
 * Strategy B (fallback): align segment text — which always has punctuation — onto words
 *   by time, and mark the last word of every sentence-ending segment.
 */
/**
 * Turn MEASURED audio silences into boundary indices.
 *
 * Word-gap pauses do not exist in a whisper.cpp `--max-len 1` transcript: it tiles word
 * timings so consecutive words touch, even across seconds of actual silence. That is the
 * same limitation that made transcript-derived silence detection useless for cutting.
 * The waveform knows where the speaker stopped; the transcript does not.
 */
function boundariesFromSilence(words, regions) {
  const ends = new Set();
  if (!regions || !regions.length || !words.length) return ends;
  for (const r of regions) {
    // The last word that finishes before the silence begins closes a clause.
    let lo = 0;
    let hi = words.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].start <= r.start) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx >= 0) ends.add(idx);
  }
  return ends;
}

function sentenceEndIndices(transcript, silenceRegions = null) {
  const words = transcript.words || [];
  const segments = transcript.segments || [];
  if (!words.length) return new Set();

  const punctuatedWords = words.filter((w) => SENTENCE_END.test((w.word || '').trim())).length;
  const ends = new Set();

  /**
   * Punctuation is ALWAYS used when present, and pauses top it up.
   *
   * The old rule picked one source or the other on a 2% threshold. A real livestream
   * transcript came in at 1.6% — just under — so it fell back to segments and found one
   * sentence per 63 words, where natural speech is one per 10-15. Clips then had almost
   * nowhere legal to end and were rejected for finishing mid-sentence.
   *
   * A speaker's pause is a real boundary whether or not the transcriber wrote a full stop,
   * so both signals are combined rather than chosen between.
   */
  words.forEach((w, i) => {
    if (SENTENCE_END.test((w.word || '').trim())) ends.add(i);
  });

  if (segments.length) {
    let cursor = 0;
    for (const seg of segments) {
      let lastIdx = -1;
      for (let i = cursor; i < words.length; i++) {
        if (words[i].start < seg.end - 0.001) lastIdx = i;
        else break;
      }
      if (lastIdx >= 0) {
        if (SENTENCE_END.test((seg.text || '').trim())) ends.add(lastIdx);
        cursor = lastIdx + 1;
      }
    }
  }

  // Word-gap pauses, for transcripts whose timings are real rather than tiled.
  const PAUSE = 0.45;
  for (let i = 1; i < words.length; i++) {
    if (words[i].start - words[i - 1].end >= PAUSE) ends.add(i - 1);
  }
  // Measured audio silences — the only reliable pause signal on a tiled transcript.
  for (const i of boundariesFromSilence(words, silenceRegions)) ends.add(i);
  ends.add(words.length - 1);
  if (ends.size > 1) return ends;

  // Strategy B — derive from segments.
  if (segments.length) {
    let cursor = 0;
    for (const seg of segments) {
      // Last word that starts before this segment ends (with a small tolerance).
      let lastIdx = -1;
      for (let i = cursor; i < words.length; i++) {
        if (words[i].start < seg.end - 0.001) lastIdx = i;
        else break;
      }
      if (lastIdx >= 0) {
        if (SENTENCE_END.test((seg.text || '').trim())) ends.add(lastIdx);
        cursor = lastIdx + 1;
      }
    }
    ends.add(words.length - 1);
    return ends;
  }

  // Strategy C — no punctuation anywhere. Fall back to long pauses so selection still
  // functions rather than silently returning nothing.
  for (let i = 1; i < words.length; i++) {
    if (words[i].start - words[i - 1].end > 0.7) ends.add(i - 1);
  }
  ends.add(words.length - 1);
  return ends;
}

/** Word indices that START a sentence (the only legal clip starts). */
/**
 * Legal places to START a clip.
 *
 * Deliberately STRICTER than the ends. A viewer forgives a clip that ends on a short pause;
 * they do not forgive one that opens mid-thought — "two trades I took longs off of this
 * untested low" begins halfway through a sentence and reads as broken.
 *
 * So a start must follow either real punctuation or a LONG pause (a genuine clause break),
 * while an end may sit at any measured pause.
 */
const START_PAUSE = 0.75;

function sentenceStartIndices(transcript, silenceRegions = null) {
  const words = transcript.words || [];
  const starts = new Set([0]);
  if (!words.length) return starts;

  // Punctuation is always a legal start for the word that follows it.
  words.forEach((w, i) => {
    if (SENTENCE_END.test((w.word || '').trim()) && i + 1 < words.length) starts.add(i + 1);
  });

  // Long measured silences: the word that resumes speech afterwards.
  for (const r of silenceRegions || []) {
    if (r.seconds < START_PAUSE) continue;
    const idx = words.findIndex((w) => w.start >= r.end - 0.05);
    if (idx > 0) starts.add(idx);
  }

  // Segment beginnings whose text starts a sentence.
  for (const seg of transcript.segments || []) {
    const idx = words.findIndex((w) => w.start >= seg.start - 0.01);
    if (idx > 0 && /^[A-Z]/.test((seg.text || '').trim())) starts.add(idx);
  }
  return starts;
}

/** Which strategy fired — surfaced so a bad transcript is diagnosable, not mysterious. */
function describeStrategy(transcript, silenceRegions = null) {
  const words = transcript.words || [];
  if (!words.length) return 'empty';
  const p = words.filter((w) => SENTENCE_END.test((w.word || '').trim())).length;
  const total = sentenceEndIndices(transcript, silenceRegions).size;
  const sil = silenceRegions ? `${silenceRegions.length} measured silences` : 'no audio measured';
  return `punctuation ${p} + segments + ${sil} -> ${total} boundaries`;
}

module.exports = {
  sentenceEndIndices, sentenceStartIndices, boundariesFromSilence, describeStrategy, SENTENCE_END,
};
