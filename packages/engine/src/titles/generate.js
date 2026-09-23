/**
 * Generate burned-in titles for a clip, grounded in the outlier corpus and verified
 * against the clip's own transcript.
 *
 * The corpus is small (about 30 clean titles today), so it is used for SHAPE — what a
 * working headline on these pages looks like — not for statistics. The thing that makes
 * the output trustworthy is the gates in ./verify, which are code and cannot drift.
 */

const { verifyTitle } = require('./verify');
const { structured } = require('../llm/provider');

const TOOL = {
  name: 'write_titles',
  description: 'Propose burned-in titles for a short trading clip.',
  input_schema: {
    type: 'object',
    properties: {
      titles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The on-screen headline. Under 62 characters.' },
            result_promise: { type: 'string', description: 'The concrete outcome it promises.' },
            mechanism: { type: 'string', description: 'The how the clip then delivers.' },
            evidence: {
              type: 'array',
              description: 'VERBATIM quotes from the transcript that deliver the promise.',
              items: {
                type: 'object',
                properties: { quote: { type: 'string' } },
                required: ['quote'],
              },
            },
          },
          required: ['title', 'result_promise', 'mechanism', 'evidence'],
        },
      },
    },
    required: ['titles'],
  },
};

const SYSTEM = `You write the burned-in headline that sits on top of a short trading clip.

THE RULE, which the client stated and which is checked in code afterwards:
A title promises a RESULT, and the clip then delivers the HOW. Not "I made $5,000" — rather
"I made $5,000" plus the mechanism the viewer will actually learn. The promise must be paid
off inside this clip.

Hard constraints:
- Under 62 characters. It has to fit a plate on a 1080-wide frame.
- NEVER state a number the trader does not say in the transcript. Every figure you write is
  checked against the spoken words and the title is thrown away if it does not match.
- Every evidence quote must be copied VERBATIM from the transcript, not paraphrased.
- If you promise a count ("3 mistakes"), give that many evidence quotes.
- No emoji — one is added separately.
- Write what the trader actually did in THIS clip. Do not invent a stronger story.

Return 4 varied candidates. It is better to write a plain accurate title than a punchy one
you cannot support.`;

/** Exemplars are rendered with their measured score so the model sees what actually won. */
function renderExemplars(rows) {
  if (!rows.length) return '';
  return '\n\nHeadlines that performed on these pages (multiplier is versus that page\'s typical reel):\n'
    + rows.map((r) => `  ${r.display_mult}x  "${r.ocr_title}"`).join('\n');
}

/** Flops matter: without them the model learns "a trading title", not what separates them. */
function renderFlops(rows) {
  if (!rows.length) return '';
  return '\n\nHeadlines that UNDERPERFORMED on the same pages — do not imitate these:\n'
    + rows.map((r) => `  ${r.display_mult}x  "${r.ocr_title}"`).join('\n');
}

/**
 * @param {object} opts
 * @param {string} opts.transcriptText  the clip's transcript
 * @param {Array}  opts.exemplars       [{ocr_title, display_mult}] winners
 * @param {Array}  opts.flops           [{ocr_title, display_mult}] duds
 */
async function generateTitles({ transcriptText, exemplars = [], flops = [], model, count = 4, provider }) {
  const r = await structured({
    provider,
    model,
    system: SYSTEM,
    toolName: 'write_titles',
    schema: TOOL.input_schema,
    userText:
      `Transcript of the clip:\n"""${transcriptText.slice(0, 4000)}"""` +
      renderExemplars(exemplars) + renderFlops(flops) +
      `\n\nWrite ${count} candidate titles.`,
  });
  return { candidates: r.data.titles || [], usage: r.usage, provider: r.provider };
}

/**
 * Generate, then gate. Returns survivors ranked, plus the rejects WITH reasons — showing an
 * editor why a punchy title was thrown out is how they learn the rule.
 */
async function generateVerifiedTitles(opts) {
  const { candidates, usage, provider } = await generateTitles(opts);
  const checked = candidates.map((c) => {
    const v = verifyTitle({
      title: c.title,
      evidence: c.evidence,
      transcriptText: opts.transcriptText,
    });
    return { ...c, verification: v, passed: v.passed };
  });
  return {
    accepted: checked.filter((c) => c.passed),
    rejected: checked.filter((c) => !c.passed),
    usage, provider,
  };
}

module.exports = { generateTitles, generateVerifiedTitles, TOOL };
