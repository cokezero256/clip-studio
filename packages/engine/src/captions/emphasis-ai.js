/**
 * AI emphasis pass for viral captions.
 *
 * Sends the clip's word list to Claude Haiku 4.5 and asks it to mark ~15-25% of words
 * for emphasis using one of:
 *   - 'accent'  → red Vartigo (the dominant viral style — for emotional/contrarian/key beats)
 *   - 'script'  → white Vartigo (for softer emphasis on transitional or evocative phrases)
 *   - 'large'   → bigger bold Helvetica (for power words / numbers / nouns)
 *
 * Returns { emphasis: [{word_index, style}], cost_usd } so callers can persist + display.
 * On any failure, returns { emphasis: [] } so the caller falls back to "all-plain" captions.
 *
 * Cost: ~$0.02/clip with Haiku 4.5 prompt-caching on the system prompt.
 */

const Anthropic = require('@anthropic-ai/sdk');

const HAIKU = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const EMPHASIS_TOOL = {
  name: 'submit_emphasis',
  description:
    'Submit the per-word emphasis assignments for this caption track.',
  input_schema: {
    type: 'object',
    properties: {
      emphasis: {
        type: 'array',
        description:
          'List of words to emphasize. Mark roughly 15-25% of total words. Skip filler words (um, uh, like, you know). Prefer key nouns, strong verbs, numbers, contrarian claims, and emotional words.',
        items: {
          type: 'object',
          properties: {
            word_index: {
              type: 'integer',
              description: 'The `i` field of the word in the provided word list.',
            },
            style: {
              type: 'string',
              enum: ['accent', 'script', 'large'],
              description:
                "'accent' = red Vartigo (dominant; for emotional/contrarian/key beats). 'script' = white Vartigo (softer emphasis on transitions/evocative phrases). 'large' = bigger bold Helvetica (power words, numbers, proper nouns).",
            },
          },
          required: ['word_index', 'style'],
        },
      },
    },
    required: ['emphasis'],
  },
};

const SYSTEM_PROMPT = `You design premium viral-style social captions. The base font is bold white Helvetica. You have three emphasis variants:

- "accent" (white cursive Vartigo, oversized): for EMOTIONAL / RHETORICAL / EVOCATIVE words — adjectives, verbs of feeling, the word that lands the punch emotionally. Examples: "magical", "broken", "screamed", "obsessed", "secretly", "everything", "alone", "truth", "love", "moment". This is the DOMINANT cursive emphasis — use it whenever the word's power is emotional rather than informational.
- "script" (white cursive Vartigo, oversized — currently identical to accent): use as variety when two emotional words land back-to-back, so we don't visually repeat.
- "large" (1.7x bold Helvetica, same font): for INFORMATIONAL peaks — numbers, money figures, proper nouns, brand names, time spans. Examples: "100M", "YouTube", "$500", "10 years", "Apple", "2026". Reserve large for words where the INFORMATION is the impact, not the emotion.

YOUR JOB IS CURATION, NOT ANNOTATION.

This caption style is built on PEAKS. The viewer's eye rides a wave: small words → BIG peak → small words → BIG peak. If you mark too many words, the rhythm dies and nothing feels important. If you mark the wrong words, captions feel random.

Rules (read all of them):
- Mark 10–15% of words. Never more than 18%. For a 100-word clip, that's 10–15 emphases TOTAL. Be ruthless.
- Identify the BEATS first (every ~3–6 seconds of speech, one peak word should land). The emphasized word IS that beat's payoff.
- Aim for ~60% accent / ~30% large / ~10% script. The cursive emphasis is what makes this style feel premium — use it generously on emotional words. Information-only peaks (numbers, brand names) get "large".
- NEVER mark: filler ("um", "uh", "like", "you know", "basically", "so", "I mean"), pronouns, articles, prepositions, auxiliary verbs ("is", "are", "have", "will"), connectors ("and", "but", "or").
- The very FIRST word of a clip is usually a hook — only mark it if it's a standalone power word.
- Avoid two emphases within 4 consecutive words. The rhythm needs space between peaks.
- Output ONLY via the submit_emphasis tool.`;

/**
 * @param {Array<{i:number, text:string, edited_text?:string|null}>} words
 * @param {object} [opts]
 * @param {string} [opts.aiNotes]  Optional free-text editor notes — appended as
 *                                 high-priority guidance to the system prompt.
 * @returns {Promise<{emphasis: Array<{word_index:number, style:string}>, cost_usd:number}>}
 */
async function markEmphasis(words, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[emphasis-ai] ANTHROPIC_API_KEY not set — skipping AI emphasis pass.');
    return { emphasis: [], cost_usd: 0 };
  }
  if (!Array.isArray(words) || words.length === 0) {
    return { emphasis: [], cost_usd: 0 };
  }

  const userText = formatWordsForPrompt(words);
  const notes = (opts.aiNotes || '').trim();
  // The notes are NOT cached (per-video), so we keep them OUT of the cache_control block
  // and pass them as a second system text block. The shared SYSTEM_PROMPT stays cached
  // (~90% cost saving across clips); only the per-video notes vary.
  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ...(notes
      ? [{ type: 'text', text: '\n## Editor notes for this video (apply when marking emphasis)\n' + notes }]
      : []),
  ];

  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: HAIKU,
      max_tokens: 2048,
      tools: [EMPHASIS_TOOL],
      tool_choice: { type: 'tool', name: EMPHASIS_TOOL.name },
      system: systemBlocks,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    });

    for (const block of response.content || []) {
      if (block.type === 'tool_use' && block.name === EMPHASIS_TOOL.name) {
        const raw = Array.isArray(block.input?.emphasis) ? block.input.emphasis : [];
        const validIndexes = new Set(words.map((w) => w.i));
        const cleaned = raw
          .filter((e) => validIndexes.has(e.word_index))
          .filter((e) => ['accent', 'script', 'large'].includes(e.style));
        const cost = estimateCost(response.usage);
        return { emphasis: cleaned, cost_usd: cost };
      }
    }
    console.warn('[emphasis-ai] Claude did not call submit_emphasis tool — skipping.');
    return { emphasis: [], cost_usd: 0 };
  } catch (err) {
    console.warn('[emphasis-ai] failed:', err.message || err);
    return { emphasis: [], cost_usd: 0 };
  }
}

function formatWordsForPrompt(words) {
  const lines = words.map((w) => {
    const text = (w.edited_text != null && w.edited_text !== '') ? w.edited_text : w.text;
    return `${w.i}\t${text}`;
  });
  return [
    'Words in this clip (word_index TAB text):',
    '',
    ...lines,
    '',
    `Total words: ${words.length}. Mark at most ${Math.max(2, Math.round(words.length * 0.12))} words. Fewer is better — pick the genuine peaks.`,
  ].join('\n');
}

function estimateCost(usage) {
  if (!usage) return 0;
  const inT = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) * 0.1
            + (usage.cache_creation_input_tokens || 0) * 1.25;
  const outT = usage.output_tokens || 0;
  return (inT * 1.0 + outT * 5.0) / 1_000_000;
}

module.exports = { markEmphasis };
