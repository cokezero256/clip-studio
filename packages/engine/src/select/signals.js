/**
 * Deterministic selection signals.
 *
 * WHY THIS EXISTS: v1 sent the entire transcript of a multi-hour stream to one Haiku call
 * and asked it to do search AND judgment against a generic "viral video editor" rubric
 * whose own examples were about coaches and video editors. On a 3-hour trading livestream
 * most of the transcript is market-waiting and dead air, so the model was mostly reading
 * noise. That is the root cause of "the selection is very bad".
 *
 * The fix is to split the problem: SEARCH is deterministic and happens here, JUDGMENT is
 * a grounded model call over a small candidate set. Everything in this file is computed
 * from the transcript alone — no model, no audio decode — so it is fast and cacheable.
 */

/**
 * Trading-specific vocabulary. The single biggest reason the generic rubric failed is
 * that it had no idea what matters in this niche. A concrete number, a named level, or a
 * real instrument is what separates a shippable trading clip from generic advice.
 */
const INSTRUMENTS = /\b(NQ|ES|YM|RTY|SPY|QQQ|SPX|NDX|DXY|XAU|XAG|GC|CL|BTC|ETH|EUR ?USD|GBP ?USD|USD ?JPY|XAUUSD|nasdaq|s&p|dow|gold|oil|futures|forex)\b/gi;
const SETUP_TERMS = /\b(order block|liquidity|sweep|fair value gap|FVG|imbalance|supply|demand|support|resistance|breakout|retest|pullback|reversal|trend ?line|VWAP|EMA|SMA|RSI|MACD|fib(onacci)?|premium|discount|displacement|BOS|CHoCH|market structure|session|killzone|entry|stop ?loss|take ?profit|risk ?reward|R ?multiple|drawdown|scalp|swing|orb|opening range|midpoint|bounce|wick|zone|level|indicator|break ?even|candle|time ?frame|target|runner|partials?)\b/gi;
/** Money, percentages, point moves, R multiples, contract counts. */
const NUMBERS = /(\$\s?\d[\d,]*(\.\d+)?\s?[kKmM]?)|(\b\d+(\.\d+)?\s?%)|(\b\d+(\.\d+)?\s?(pips?|points?|ticks?|handles?|R\b))|(\b\d+\s?(contracts?|lots?|shares?))/g;

/** Openers that prove a span is not self-contained — it references unseen context. */
const DANGLING_OPEN = /^(so|and|but|then|also|because|which|that|this|it|they|he|she|there|here|those|these|anyway|again|plus|however|therefore|thus)\b/i;
/** Enders that leave the thought open. */
const DANGLING_END = /\b(because|and|but|so|or|which|that|if|when|while|the|a|an|to|of|for|with)$/i;

const QUESTION = /\b(what|why|how|when|where|which|who)\b|^(is|are|do|does|did|can|could|should|would|will|have|has)\b/i;
const SENTENCE_END = /[.!?]["')\]]?$/;

/** First-person claims of an outcome — the hook shape that dominates this niche. */
const RESULT_CLAIM = /\b(I|we)\s+(made|took|caught|banked|closed|made|lost|turned|grew|hit|nailed|scaled)\b/i;

/**
 * A REACTION opening — the structure the client identified as what works:
 * "put the reaction of the trade first... 'oh my god this was crazy'... then you cut into
 * so basically what I'm saying is this, this and this, and you show the trade."
 *
 * A clip that opens on a reaction earns attention before it explains anything. A clip that
 * opens on setup ("I didn't really notify anybody, but I was live yesterday") does not.
 */
const REACTION_OPEN = /\b(oh my god|oh my|holy|no way|look at (that|this)|are you kidding|insane|crazy|unreal|let's go|there it is|got (him|it|her)|easy money|called it|textbook|that was (so|the) \w+)\b/i;

/** Explicit hand-off into the explanation — the second beat of that structure. */
const EXPLAIN_PIVOT = /\b(so basically|what i('m| am) saying|here('s| is) (what|why|the)|let me show you|the reason (is|why)|what happened (was|is)|this is (why|what|how))\b/i;

/**
 * THE PAYOFF. Measured in the clip BODY, never the hook.
 *
 * WHY: the corpus ranker rejected 13 of 24 gate-passing candidates from one stream with
 * some version of "opens on a result but fails to pay off with the how". That is the
 * client's stated structure failing at its second beat, and it was invisible to this file
 * because every signal here was counted over the whole span — a clip whose only substance
 * is in its first five seconds scored identically to one that teaches all the way through.
 * Causal and instructional language is what separates a trade RECAP from a trade LESSON.
 */
const PAYOFF = new RegExp(
  [
    // Causal — "because" alone appears 33x in a measured 71-minute stream, by far the
    // most common way this niche explains itself.
    "\\b(because|the reason|that's why|which is why|since it)\\b",
    // Instructional.
    "\\b(so what i|what i do|how i (trade|play|take|enter)|i look for|i wait for|i want to see)\\b",
    // "I trade off the midpoint" — stating the method directly, without a "how".
    "\\bi (trade|play|enter|scalp) (off|from|at|on|the)\\b",
    "\\b(my rule|the rule is|you want to|you have to|you need to|you should)\\b",
    // Conditional rules, with or without an explicit "then".
    "\\bif (it|i|price|the|that|you)\\b.{3,60}\\b(then|i'?ll|it'?ll|i will|it will|don'?t|do not|i won'?t)\\b",
    // A signal telling the trader something — modal forms included.
    // Any subject — measured text says "this INDICATOR tells me", not "this tells me".
    "\\b(tells?|told|'ll tell|will tell|is telling)\\s+me\\b",
    "\\b(means that|that means|as soon as|this is how|let me show)\\b",
    // Execution narration — in this niche, walking through an entry IS the teaching.
    "\\b(i (took|entered|got in|closed|moved my stop|scaled)|my (entry|stop|target))\\b.{0,40}\\b(off|at|on|into|to|because|when)\\b",
  ].join("|"),
  "i"
);

/**
 * Stream housekeeping, recruiting and chat admin. Measured because the ranker kept
 * spending a model call to reject them: giveaways, clipper recruitment, audio checks and
 * chat arguments are never clips, but they are dense with speech so every other signal
 * here rated them as normal talk.
 */
const OFF_TOPIC = /\b(looking for clippers|clip my|clippers|give ?away|giving away|link in (bio|the description)|smash that|subscribe|can you guys hear|is the audio|my mic|sound check|notify anybody|in the chat(s)?|chat is|y'all are|welcome (back )?to the stream|let me know below)\b/gi;

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * Words-per-minute in a rolling window. Livestreams have long stretches of the trader
 * waiting on price with almost no speech; those regions must never be searched.
 */
function speechDensity(words, windowSeconds = 60) {
  if (!words.length) return [];
  const end = words[words.length - 1].end;
  const out = [];
  for (let t = 0; t < end; t += windowSeconds / 2) {
    const lo = t;
    const hi = t + windowSeconds;
    const n = words.filter((w) => w.start >= lo && w.start < hi).length;
    out.push({ start: lo, end: hi, wpm: (n / windowSeconds) * 60 });
  }
  return out;
}

/**
 * Regions too sparse to contain a clip. Masking these is what makes a 3-hour stream
 * tractable — typically ~45 minutes of the 180 is actually usable talk.
 */
function deadZones(words, { minWpm = 60, windowSeconds = 60 } = {}) {
  const density = speechDensity(words, windowSeconds);
  const zones = [];
  for (const d of density) {
    if (d.wpm >= minWpm) continue;
    const last = zones[zones.length - 1];
    if (last && d.start <= last.end) last.end = Math.max(last.end, d.end);
    else zones.push({ start: d.start, end: d.end, wpm: d.wpm });
  }
  return zones;
}

function inZones(t, zones) {
  return zones.some((z) => t >= z.start && t < z.end);
}

/** Gaps between consecutive words, classified. */
function pauses(words) {
  const out = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap <= 0.15) continue;
    out.push({
      at: words[i - 1].end,
      seconds: gap,
      // A short pause after a claim reads as emphasis; a long one is a wall.
      kind: gap > 1.2 ? 'wall' : gap > 0.4 ? 'beat' : 'breath',
      index: i,
    });
  }
  return out;
}

/**
 * Score a candidate span on deterministic, trading-aware features.
 * Returns raw sub-scores so the UI can explain WHY a clip ranked where it did — an editor
 * who sees "numbers 0, mechanism 1" learns something a single blended number never teaches.
 */
function scoreSpan(words, startIdx, endIdx, opts = {}) {
  const span = words.slice(startIdx, endIdx + 1);
  if (!span.length) return null;
  const text = span.map((w) => w.word).join(' ');
  const duration = span[span.length - 1].end - span[0].start;
  const first = span[0].word.trim();
  const last = span[span.length - 1].word.trim();

  const hookText = span.slice(0, 14).map((w) => w.word).join(' ');
  const tailText = span.slice(-14).map((w) => w.word).join(' ');

  // The clip is judged as a two-part structure, not a bag of words. The hook earns the
  // attention; the BODY has to pay it off. Splitting at 25% keeps the hook zone roughly
  // the first 8-15 seconds of a 30-120s clip, which is where the reaction lives.
  const bodyStart = Math.floor(span.length * 0.25);
  const bodySpan = span.slice(bodyStart);
  const bodyText = bodySpan.map((w) => w.word).join(' ');
  const bodyDuration = bodySpan.length
    ? bodySpan[bodySpan.length - 1].end - bodySpan[0].start
    : 0;

  const numbers = countMatches(text, NUMBERS);
  const instruments = countMatches(text, INSTRUMENTS);
  const setups = countMatches(text, SETUP_TERMS);

  const gaps = [];
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const g = words[i].start - words[i - 1].end;
    if (g > 0) gaps.push(g);
  }
  const worstGap = gaps.length ? Math.max(...gaps) : 0;
  const speechTime = span.reduce((s, w) => s + (w.end - w.start), 0);

  const openPenalty = DANGLING_OPEN.test(first) ? 1 : 0;
  // Whether this index ends a sentence must come from the DERIVED boundary set, not from
  // testing the word for punctuation — OpenAI transcripts strip punctuation from words[],
  // so a raw test marks every span as "ends mid-sentence" and rejects all of them.
  const endsSentence = opts.sentenceEnds
    ? opts.sentenceEnds.has(endIdx)
    : SENTENCE_END.test(last);
  const endPenalty = (!endsSentence || DANGLING_END.test(last)) ? 1 : 0;

  return {
    startSeconds: span[0].start,
    endSeconds: span[span.length - 1].end,
    durationSeconds: duration,
    wordCount: span.length,
    text,
    hookText,
    tailText,
    signals: {
      // Concreteness — the strongest niche-specific predictor.
      numberDensity: numbers / Math.max(1, duration / 30),
      instrumentMentions: instruments,
      setupMentions: setups,
      // Does it open by claiming a result? That's the dominant winning hook here.
      resultClaim: RESULT_CLAIM.test(hookText) ? 1 : 0,
      // Opens on the emotional reaction — the strongest opening shape for this niche.
      reactionOpen: REACTION_OPEN.test(hookText) ? 1 : 0,
      // ...and then hands off into the explanation.
      explainPivot: EXPLAIN_PIVOT.test(text) ? 1 : 0,
      // Does the BODY actually teach? A result with no payoff is a recap, not a clip.
      payoff: PAYOFF.test(bodyText) ? 1 : 0,
      // Mechanism density in the body specifically, per 30s — proves the teaching is
      // sustained rather than one lucky term in the hook.
      bodyMechanism:
        countMatches(bodyText, SETUP_TERMS) / Math.max(1, bodyDuration / 30),
      // Housekeeping / recruiting / chat admin anywhere in the span.
      offTopic: countMatches(text, OFF_TOPIC),
      question: QUESTION.test(hookText) ? 1 : 0,
      // Structure.
      openPenalty,
      endPenalty,
      worstGapSeconds: worstGap,
      speechRatio: duration > 0 ? speechTime / duration : 0,
      wordsPerSecond: span.length / Math.max(0.001, duration),
    },
  };
}

/**
 * Combine sub-scores into one number used only for ORDERING candidates before the model
 * sees them. Deliberately simple and legible — this is a filter, not the final judgment.
 */
function rankScore(s) {
  const g = s.signals;
  let score = 0;
  score += Math.min(3, g.numberDensity * 1.5);        // concrete numbers
  score += Math.min(1.5, g.instrumentMentions * 0.5); // named instruments
  score += Math.min(2, g.setupMentions * 0.4);        // actual mechanism
  score += g.resultClaim * 2;                          // "I took / I made"
  score += g.reactionOpen * 3;                         // opens on the reaction — the key shape
  score += g.explainPivot * 1.5;                       // then hands off into the how
  score += g.payoff * 2.5;                             // ...and the body actually delivers it
  score += Math.min(2, g.bodyMechanism * 0.8);         // sustained teaching, not one lucky term
  score += g.question * 0.5;
  // A result claim that never pays off is a recap. The corpus rejects those by name, so
  // stop paying the model to discover it: cancel the result bonus when the body is empty.
  if (g.resultClaim && !g.payoff && g.bodyMechanism < 0.5) score -= 2;
  score -= Math.min(4, g.offTopic * 1.5);              // housekeeping, giveaways, clipper ads
  score -= g.openPenalty * 3;                          // not self-contained
  score -= g.endPenalty * 2;                           // ends mid-thought
  score -= Math.max(0, g.worstGapSeconds - 0.6) * 2;   // internal dead air
  score += (g.speechRatio - 0.8) * 3;                  // density of actual talk
  return +score.toFixed(3);
}

module.exports = {
  deadZones, speechDensity, inZones, pauses, scoreSpan, rankScore,
  INSTRUMENTS, SETUP_TERMS, NUMBERS, DANGLING_OPEN, DANGLING_END, RESULT_CLAIM,
  REACTION_OPEN, EXPLAIN_PIVOT, PAYOFF, OFF_TOPIC, SENTENCE_END,
};
