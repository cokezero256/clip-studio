/**
 * Extract the burned-in TITLE from a reel's OCR'd frames.
 *
 * This is the whole reason OCR is in the pipeline. Instagram captions on trading pages are
 * worthless — measured on rp.profits, they are literally "Crazy", "True", "Sauce", "Boom".
 * The text that carries the hook is burned into the video, so it can only be read off the
 * pixels.
 *
 * Three kinds of text appear on these frames, and they separate on two axes — SIZE and
 * whether the wording changes:
 *
 *   platform chrome   small (h < ~0.025), scattered      → discard
 *   rolling captions  large, fixed position, TEXT CHANGES every frame → discard (whisper has it)
 *   the title         large, fixed position, TEXT STABLE → keep
 *
 * Measured on a real reel: chart UI text sits at h≈0.012–0.026 while the caption is h≈0.032,
 * so the size gate alone removes most of the noise before persistence is even considered.
 */

const MIN_HEIGHT = 0.022;      // below this it's platform chrome

/**
 * Persistence and stability alone are NOT enough, and this was a real failure.
 *
 * A watermark, a chart axis label or a platform toolbar is MAXIMALLY persistent and stable
 * — far more so than a real title, which sometimes disappears partway through. Selecting on
 * those two axes alone therefore picks exactly the wrong text. Measured on the first real
 * corpus: 18 of 49 extracted "titles" were junk like "ris reversal" (the @riskreversalmedia
 * watermark), "+ Style 1 Studies" (a TradingView menu), "Industries | Health" (a chart
 * legend) and "3.75% - 4.00%" (axis values).
 *
 * So a title must also LOOK like a headline: several words, not pure digits, not hugging a
 * frame edge where chrome lives, and not drawn from platform vocabulary.
 */
const MIN_WORDS = 3;           // a headline is a phrase, not a label
const EDGE_MARGIN = 0.06;      // chrome and watermarks hug the edges
/**
 * Two lists, because one was too blunt.
 *
 * A single vocabulary list rejected "Just BLOW your funded account" — a perfectly good
 * headline — because "account" also appears in dashboard chrome. Trading headlines are full
 * of words that also appear in UI: account, chart, profit, drawdown. So:
 *
 *   PLATFORM_NAMES  never appear in a headline -> always reject
 *   UI_LABEL_WORDS  appear in both -> only reject when the text reads like a LABEL
 *                   (few words), not when it reads like a sentence
 */
const PLATFORM_NAMES = /\b(tradingview|thinkorswim|ninjatrader|metatrader|tradeify|topstep|apex ?trader|interactive ?brokers|webull|tastytrade)\b/i;
const UI_LABEL_WORDS = /\b(studies?|toggle|watchlist|screener|timeframe|indicator|layout|bid|ask|equity|margin|sharpe|volume)\b/i;
/** Pure numbers, prices, percentages, times, ticker fragments. */
const NOT_A_SENTENCE = /^[\s\d.,:%$+\-–—|•()\/]*$/;

/** Does this text plausibly read as a burned-in headline? */
function looksLikeTitle(text, box) {
  const t = String(text || '').trim();
  if (t.length < 12) return false;
  if (NOT_A_SENTENCE.test(t)) return false;
  if (PLATFORM_NAMES.test(t)) return false;
  // Needs real words, not a code or a label.
  const words = t.split(/\s+/).filter((w) => /[a-z]{2,}/i.test(w));
  if (words.length < MIN_WORDS) return false;
  // A UI word only disqualifies short label-like text; a full sentence may use it.
  if (UI_LABEL_WORDS.test(t) && words.length < 5) return false;
  // A pipe or a lone bullet is chart-legend punctuation, never headline punctuation.
  if (/\||•/.test(t)) return false;
  if (box) {
    // Chrome and watermarks live against the edges; headlines sit inboard.
    if (box.x < EDGE_MARGIN && box.w < 0.45) return false;
    if (box.x + box.w > 1 - EDGE_MARGIN && box.w < 0.45) return false;
    // A headline occupies a meaningful share of the width.
    if (box.w < 0.25) return false;
  }
  return true;
}
const POS_GRID = 0.06;         // bucket resolution for "same place"
const MIN_PERSISTENCE = 0.35;  // must appear in this share of frames
const TITLE_STABILITY = 0.6;   // same wording this often ⇒ a title
const CAPTION_STABILITY = 0.4; // below this ⇒ rolling captions

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/** Group observations that occupy the same screen position across frames. */
function bucketByPosition(frames) {
  const buckets = new Map();
  frames.forEach((frame, fi) => {
    for (const o of frame.observations || []) {
      if (o.h < MIN_HEIGHT) continue;                 // chrome
      if (o.y > 0.93) continue;                       // platform UI strip
      const cx = o.x + o.w / 2;
      const key = `${Math.round(cx / POS_GRID)}:${Math.round(o.y / POS_GRID)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ ...o, frame: fi });
    }
  });
  return buckets;
}

/**
 * Returns { title, confidence, rejected } — rejected explains what was discarded and why,
 * which matters because a wrong title is worse than none.
 */
function extractTitle(frames, { debug = false } = {}) {
  const total = frames.length || 1;
  const buckets = bucketByPosition(frames);
  const candidates = [];
  const rejected = [];

  for (const [key, obs] of buckets) {
    const framesSeen = new Set(obs.map((o) => o.frame)).size;
    const persistence = framesSeen / total;
    if (persistence < MIN_PERSISTENCE) continue;

    // How often is the wording identical?
    const counts = new Map();
    for (const o of obs) {
      const n = norm(o.text);
      if (!n) continue;
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    if (!counts.size) continue;
    const [bestText, bestCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const stability = bestCount / obs.length;

    if (stability < CAPTION_STABILITY) {
      rejected.push({ key, reason: 'rolling captions (same place, wording changes)', persistence, stability });
      continue;
    }
    if (stability < TITLE_STABILITY) {
      rejected.push({ key, reason: 'unstable text', persistence, stability });
      continue;
    }

    // Prefer the original casing from the highest-confidence observation of that wording.
    const sample = obs.filter((o) => norm(o.text) === bestText)
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (!looksLikeTitle(sample.text, sample)) {
      rejected.push({ key, reason: 'reads as platform chrome or a watermark, not a headline',
                      text: sample.text.slice(0, 40), persistence, stability });
      continue;
    }
    candidates.push({
      key, text: sample.text.trim(), persistence, stability,
      height: sample.h, y: sample.y,
      score: persistence * stability * (0.5 + sample.h * 6),
    });
  }

  if (!candidates.length) return { title: null, confidence: 0, rejected: debug ? rejected : undefined };

  // A title can wrap to several lines: merge same-wording-stable lines that sit close
  // vertically and share a similar height.
  candidates.sort((a, b) => a.y - b.y);
  const best = [...candidates].sort((a, b) => b.score - a.score)[0];
  const lines = candidates.filter(
    (c) => Math.abs(c.height - best.height) < best.height * 0.45 &&
           Math.abs(c.y - best.y) < 0.16
  ).sort((a, b) => a.y - b.y);

  const title = lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
  return {
    title: title || null,
    confidence: +Math.min(1, best.persistence * best.stability).toFixed(2),
    lines: lines.length,
    rejected: debug ? rejected : undefined,
  };
}

module.exports = { extractTitle, bucketByPosition, looksLikeTitle, MIN_HEIGHT };
