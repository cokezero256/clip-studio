/**
 * Classify a reel's FORMAT from its pixels.
 *
 * Mauricio's requirement: keep only "the trader explaining something" — a clip off a
 * livestream, screen-share or chart — and drop selfies, lifestyle and reposts.
 *
 * The cheap signals do not work here, and that was measured rather than assumed: every one
 * of rp.profits' 30 most recent posts is 1080x1920, durations run 16–131s, and the captions
 * are "Crazy" / "True" / "Sauce". Aspect, length and caption carry no signal at all. So the
 * classifier has to look at the frames.
 *
 * The taxonomy is a fixed enum on purpose — free-text labels cannot be grouped, filtered or
 * counted, which is the whole point of a gallery.
 */

const FORMATS = [
  'screenshare_teach',   // trader over a chart/platform, explaining a concept  ← target
  'screenshare_recap',   // same visuals, reviewing a trade already taken       ← target
  'talking_head',        // selfie/tripod, face fills frame, no chart
  'talking_head_broll',  // face plus cutaways
  'lifestyle',           // car/gym/travel/money, no teaching
  'meme_repost',         // text over stock footage, reaction, someone else's clip
  'podcast_clip',        // two people, studio, visible mic
  'promo',               // course/Discord ad, testimonial montage
  'other',
];

const TOPICS = [
  'entry_setup', 'risk_management', 'psychology', 'pnl_result', 'market_structure',
  'indicator_howto', 'prop_firm', 'mistake_postmortem', 'news_reaction', 'lifestyle_flex',
  'promo', 'other',
];

const HOOK_TYPES = [
  'result_claim', 'contrarian', 'question', 'mistake_confession',
  'live_reaction', 'direct_address', 'number_drop', 'curiosity_gap', 'other',
];

const TOOL = {
  name: 'classify_reel',
  description: 'Record the format, topic and hook type of a trading reel.',
  input_schema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: FORMATS },
      format_confidence: { type: 'number', description: '0-1' },
      has_chart: { type: 'boolean', description: 'Is a trading chart or platform visible?' },
      chart_share: { type: 'number', description: '0-1, fraction of the frame the chart occupies' },
      face_present: { type: 'boolean' },
      layout: { type: 'string', enum: ['fullscreen_chart', 'split', 'pip', 'fullscreen_cam', 'other'] },
      has_burned_title: { type: 'boolean' },
      topic: { type: 'string', enum: TOPICS },
      hook_type: { type: 'string', enum: HOOK_TYPES },
      evidence: { type: 'string', description: 'One sentence citing what is actually on screen.' },
    },
    required: ['format', 'format_confidence', 'has_chart', 'face_present', 'layout', 'topic', 'hook_type', 'evidence'],
  },
};

const SYSTEM = `You classify short-form trading reels by what is VISIBLE in the frames.

THE DECIDING RULE — read this first:
If a trading chart or platform is visible AND the trader is talking over it, the format is
screenshare_teach or screenshare_recap. This holds EVEN IF the trader's face is also on
screen, which it usually is: the dominant format in this niche is a split frame with the
webcam in one band and the chart in the other. A visible face does NOT make it a talking
head. Only classify talking_head / talking_head_broll when there is NO chart on screen.

- screenshare_teach — chart visible, explaining a concept, setup or method  ← target
- screenshare_recap — chart visible, reviewing a trade already taken, usually with a P&L
  number on screen                                                          ← target
- talking_head — person only, NO chart anywhere in the frame
- talking_head_broll — person only, no chart, with cutaways to non-chart footage
- lifestyle — cars, watches, gyms, travel, cash. No teaching, no chart.
- meme_repost — someone else's footage, reaction clips, text over stock video
- podcast_clip — two people, studio, visible microphones, no chart
- promo — course/Discord advert, testimonial montage

teach vs recap: teach explains a concept or setup going forward; recap reviews a trade
already taken. A visible P&L figure points to recap. If ambiguous, prefer teach.

Judge from the frames and the transcript excerpt. In evidence, cite what you actually see —
name the platform, the instrument, or what the person is doing.`;

function imageBlock(b64, media = 'image/jpeg') {
  return { type: 'image', source: { type: 'base64', media_type: media, data: b64 } };
}

/**
 * Classify one reel. `frames` are base64 JPEGs (4 is plenty — more costs tokens without
 * changing the answer).
 */
async function classifyReel({ frames, title = null, transcript = null, caption = null, model }) {
  /*
   * Through the provider abstraction, never the Anthropic SDK directly. This function was
   * the ONE model call in the engine that bypassed it, so when the Anthropic account ran out
   * of credit every classification failed (123 posts per run) while titles — routed through
   * `structured()` — quietly fell back to Gemini and kept working.
   */
  const { structured } = require('../llm/provider');
  const context = [
    title ? `On-screen title (OCR'd): ${title}` : null,
    caption ? `Instagram caption: ${caption.slice(0, 200)}` : null,
    transcript ? `Transcript excerpt: ${transcript.slice(0, 900)}` : null,
  ].filter(Boolean).join('\n');

  const r = await structured({
    system: SYSTEM,
    schema: TOOL.input_schema,
    toolName: TOOL.name,
    images: frames,
    userText: context || 'No transcript available — judge from the frames.',
    model: model || process.env.OUTLIER_VISION_MODEL || undefined,
  });
  if (!r || !r.data) throw new Error('Model did not return a classification');
  return { ...r.data, usage: r.usage, provider: r.provider };
}

/**
 * Is this a clip Mauricio wants in the gallery?
 *
 * Expressed as a QUERY over stored attributes rather than a stored flag, so the definition
 * can change without reclassifying the corpus.
 *
 * The chart_share clause is a deliberate safety net: the model sometimes labels a
 * split-screen reel talking_head_broll because the face is prominent, even though a chart
 * fills most of the frame. Observed on a real pjtradesnq reel with chart_share 0.65.
 * Attributes are more reliable than the single label, so they get the final say.
 */
function isTargetFormat(row) {
  const f = row.format_label || row.format;
  if (f === 'screenshare_teach' || f === 'screenshare_recap') return true;
  if (f === 'lifestyle' || f === 'meme_repost' || f === 'promo') return false;
  return Boolean(row.has_chart) && (row.chart_share ?? 0) >= 0.35;
}

module.exports = { classifyReel, isTargetFormat, FORMATS, TOPICS, HOOK_TYPES };
