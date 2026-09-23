/**
 * Deterministic alt-take detection.
 *
 * The LLM can't reliably apply the "always keep the LAST take" rule — it sometimes drops
 * the wrong attempt or keeps multiple takes. This module solves that with explicit logic:
 *
 *   1. Walk consecutive Whisper segments.
 *   2. Group them when they share their opening words (the speaker is restarting the
 *      same sentence) AND they're close in time.
 *   3. For every group of size >= 2, drop ALL but the LAST segment as alt_take.
 *
 * This catches:
 *   - "Traditional marketing..." × 7 → drop 6, keep last
 *   - "The way people interact with your ads is no longer the same" × 2 → drop 1, keep 1
 *   - "Paid advertising will always play a huge role..." × 3 → drop 2, keep 1
 *   - "And as for the most important question..." × N → drop N-1, keep last
 *
 * Output objects match the LLM cut-decider shape so they merge cleanly into the same drop list.
 */

const PUNCT_RE = /[^a-z\s']/g;
const STOPWORD = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'i', 'in', 'is',
  'it', 'of', 'on', 'or', 'so', 'that', 'the', 'this', 'to', 'was', 'with', 'you',
]);

function normalize(text) {
  return String(text || '').toLowerCase().replace(PUNCT_RE, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(text) {
  return normalize(text).split(' ').filter(Boolean);
}

/**
 * Compute the leading "phrase fingerprint" — first N content words (skipping stopwords) —
 * so "The way people interact with your ads" and "the way people interact with your ads"
 * fingerprint identically as ["way", "people", "interact"].
 */
function leadingFingerprint(text, contentWords = 3) {
  const out = [];
  for (const tok of tokens(text)) {
    if (STOPWORD.has(tok)) continue;
    out.push(tok);
    if (out.length >= contentWords) break;
  }
  return out.join(' ');
}

/**
 * Compute Jaccard similarity between two token sets, both lowercased and stopword-stripped.
 */
function jaccard(textA, textB) {
  const a = new Set(tokens(textA).filter((t) => !STOPWORD.has(t)));
  const b = new Set(tokens(textB).filter((t) => !STOPWORD.has(t)));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Two segments are in the same alt-take group if ANY of these signals match
 * (and they're close in time):
 *   1. Leading 3-word fingerprint exact match    — strongest signal
 *   2. Leading 2-word fingerprint exact match    — catches "traditional market" → "traditional marketing"
 *   3. Leading 5-word Jaccard ≥ 0.4              — catches drifting fingerprints in progressive takes
 *   4. Overall Jaccard ≥ 0.5                     — catches paraphrased restarts
 */
function sameGroup(prev, cur, maxTimeBetweenSegments) {
  const timeBetween = cur.start - prev.end;
  if (timeBetween > maxTimeBetweenSegments) return false;

  // Method 1: 3-word fingerprint
  const prevFp3 = leadingFingerprint(prev.text, 3);
  const curFp3 = leadingFingerprint(cur.text, 3);
  if (prevFp3 && curFp3 && prevFp3 === curFp3) return true;

  // Method 2: 2-word fingerprint — handles "traditional market" → "traditional marketing"
  const prevFp2 = leadingFingerprint(prev.text, 2);
  const curFp2 = leadingFingerprint(cur.text, 2);
  if (prevFp2 && curFp2 && prevFp2 === curFp2) return true;

  // Method 3: Jaccard over leading 5 content words — catches takes whose fingerprints drift
  // as the speaker progressively refines wording (e.g., "traditional market kind" →
  // "traditional market traditional" → "traditional marketing almost").
  const prevLead = leadingContentTokens(prev.text, 5);
  const curLead = leadingContentTokens(cur.text, 5);
  if (prevLead.length >= 2 && curLead.length >= 2) {
    const a = new Set(prevLead);
    const b = new Set(curLead);
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    const j = inter / (a.size + b.size - inter);
    if (j >= 0.4) return true;
  }

  // Method 4: overall content similarity
  return jaccard(prev.text, cur.text) >= 0.5;
}

function recentAnchor(group) {
  // Most recent segment with duration >= 2.0s. Falls back to the literal last segment
  // if every segment in the group is brief (rare).
  for (let i = group.length - 1; i >= 0; i--) {
    const s = group[i];
    if (s.end - s.start >= 2.0) return s;
  }
  return group[group.length - 1];
}

function leadingContentTokens(text, n) {
  const out = [];
  for (const tok of tokens(text)) {
    if (STOPWORD.has(tok)) continue;
    out.push(tok);
    if (out.length >= n) break;
  }
  return out;
}

function detectAltTakes(transcript, opts = {}) {
  const {
    maxTimeBetweenSegments = 15,    // seconds — stop a group if speaker paused this long without restarting
    minGroupSizeToDrop = 2,
    maxSegmentLengthForGrouping = 25, // seconds — don't group very long segments (they're not failed takes)
  } = opts;

  const segments = (transcript.segments || []).slice().sort((a, b) => a.start - b.start);
  if (segments.length < 2) return [];

  const cuts = [];
  let group = [segments[0]];

  const flushGroup = () => {
    if (group.length >= minGroupSizeToDrop) {
      // Drop all but the LAST segment in the group.
      const lastIndex = group.length - 1;
      const lastSeg = group[lastIndex];
      const keptPreview = lastSeg.text.trim().slice(0, 60);
      // Coalesce contiguous drops into a single cut spanning the dropped segments.
      const dropStart = group[0].start;
      const dropEnd = group[lastIndex - 1].end;
      cuts.push({
        start_seconds: dropStart,
        end_seconds: dropEnd,
        action: 'drop',
        reason: 'alt_take',
        note: `Dropped ${group.length - 1} earlier take(s); keeping last: "${keptPreview}${keptPreview.length === 60 ? '…' : ''}"`,
        confidence: 0.95,
        source: 'alt-take-detector',
      });
    }
    group = [];
  };

  for (let i = 1; i < segments.length; i++) {
    // Anchor = most recent non-brief segment in the group. Brief trailing fragments like
    // "bit." should NEVER become the comparison anchor — otherwise the chain breaks every
    // time Whisper splits off a one-word fragment.
    const anchor = recentAnchor(group);
    const cur = segments[i];
    const curIsBrief = (cur.end - cur.start) < 2.0;

    let inGroup = sameGroup(anchor, cur, maxTimeBetweenSegments);

    // Peek-ahead bridge: if `cur` is a brief trailing fragment that doesn't match the
    // anchor, but the NEXT real segment does, include `cur` in the chain so the whole
    // multi-take collapses into one group.
    if (!inGroup && curIsBrief && i + 1 < segments.length) {
      const next = segments[i + 1];
      if (sameGroup(anchor, next, maxTimeBetweenSegments)) {
        inGroup = true;
      }
    }

    const tooLong = (cur.end - cur.start) > maxSegmentLengthForGrouping || (anchor.end - anchor.start) > maxSegmentLengthForGrouping;
    if (!tooLong && inGroup) {
      group.push(cur);
    } else {
      flushGroup();
      group = [cur];
    }
  }
  flushGroup();

  return cuts;
}

module.exports = { detectAltTakes, leadingFingerprint, jaccard };
