/**
 * Finds "best moments" in a longform transcript — self-contained 30-90s segments with
 * a strong hook and a clear payoff. Designed for editors who want to extract shareable
 * shortform clips from interview/talking-head/podcast material.
 *
 * Returns a ranked list of ClipCandidate objects with:
 *   - start/end seconds (frame-accurate via word-level alignment)
 *   - the hook line that opens the clip
 *   - the payoff line that closes it
 *   - a 1-line summary for the dashboard
 *   - a virality score (0-10) with reasoning
 *   - a suggested social caption / title
 *
 * Output is saved to output/<name>/clip-candidates.json so the dashboard can render
 * the cards without re-calling the API.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

const HAIKU = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const SONNET = process.env.CLAUDE_MODEL_HARD || 'claude-sonnet-4-5-20250929';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

const CLIP_TOOL = {
  name: 'submit_clip_candidates',
  description:
    'Submit the ranked list of hook+payoff clip candidates extracted from this transcript.',
  input_schema: {
    type: 'object',
    properties: {
      clips: {
        type: 'array',
        description:
          'Self-contained 30-90s clip candidates, ranked from best to worst by virality score.',
        items: {
          type: 'object',
          properties: {
            start_segment_index: {
              type: 'integer',
              description:
                'The "i" index of the transcript segment where the clip STARTS (the segment containing the hook line). Copy the exact "i" value from the TRANSCRIPT json — do NOT guess a time in seconds.',
            },
            end_segment_index: {
              type: 'integer',
              description:
                'The "i" index of the transcript segment where the clip ENDS (the segment containing the payoff line). Copy the exact "i" value from the TRANSCRIPT json. Must be >= start_segment_index.',
            },
            hook: {
              type: 'string',
              description:
                'The opening line of the clip — verbatim from the transcript. Must be a strong, declarative or intriguing sentence.',
            },
            payoff: {
              type: 'string',
              description:
                'The closing line of the clip — verbatim from the transcript. Must deliver a clear point, insight, or punchline.',
            },
            summary: {
              type: 'string',
              description: 'One sentence (<= 100 chars) summarizing what the clip is about.',
            },
            score: {
              type: 'number',
              minimum: 0,
              maximum: 10,
              description:
                'Virality score 0-10. Consider: hook strength, self-containment, payoff clarity, broad appeal, contrarian / surprising / emotional content. 10 = obvious viral clip, 5 = average, 0 = unusable.',
            },
            why: {
              type: 'string',
              description:
                'Why this clip scores at this level — 1-2 sentences. Reference specific virality criteria.',
            },
            caption: {
              type: 'string',
              description:
                'Suggested social caption / title for the clip (max 80 chars). Match the energy of the content. No hashtags.',
            },
            shape: {
              type: 'string',
              enum: ['short', 'long'],
              description:
                'short = 30-90s clip (social shorts). long = 2-4 minute cutdown (YouTube/LinkedIn). Only used in "stream" mode; for "video" mode default to "short".',
            },
          },
          required: ['start_segment_index', 'end_segment_index', 'hook', 'payoff', 'summary', 'score', 'why'],
        },
      },
    },
    required: ['clips'],
  },
};

// Source-type presets shape the LENGTH and KIND of clips we look for.
//
//   - "video":  treat as a tightly-edited longform (interview, talk, scripted YouTube).
//               Pull short, punchy 30-90s standalone clips. Best for social shorts.
//   - "stream": treat as a long unedited stream / podcast / Zoom / livestream. Pull both
//               short shareable clips AND longer 2-4 minute segments that work as YouTube
//               cutdowns or LinkedIn longer-form posts.
const SOURCE_TYPE_PRESETS = {
  video: {
    label: 'Video',
    description: 'Tightly edited longform — pull short shareable clips',
    duration_guidance:
      'Each clip MUST be 30–90 seconds. No longer. If you find a great 2-minute span, split it into two ~60s clips with their own hook/payoff.',
    count_guidance: 'Return 5-15 clip candidates ranked by score.',
  },
  stream: {
    label: 'Stream',
    description: 'Long unedited recording — pull short clips AND 2-4 minute segments',
    duration_guidance: `Mix of two lengths:
      - SHORT clips (30-90s) — punchy hooks for social shorts. Tag them with "shape": "short".
      - LONG segments (2-4 minutes) — substantive cutdowns that work as standalone YouTube/LinkedIn posts.
        Tag with "shape": "long". These should have a clear arc: setup → development → payoff.
      Return both shapes. Aim for ~60% short / 40% long unless the content overwhelmingly favors one length.`,
    count_guidance:
      'Return 10-20 clip candidates total, mixed short + long. Rank ALL of them by score (don\'t segregate the lists).',
  },
};

const SYSTEM_PROMPT_PREFIX = `You are a viral video editor. Your job: given the transcript of a longform recording, find the best moments that each stand alone as shareable clips.

Every clip MUST be:
  1. SELF-CONTAINED — a viewer with zero context understands the full point.
  2. HOOK + PAYOFF — opens with a strong line that pulls people in, closes with a clear payoff.
  3. WITHIN THE LENGTH RANGE for this source's type (see below).

What makes a strong hook (applies to both shapes):
  - Declarative claim: "The biggest mistake editors make is..."
  - Intriguing question: "What if you only had 10 seconds to..."
  - Pattern interrupt: "I used to think X. I was wrong."
  - Contrarian: "Everyone tells you to do X. Don't."
  - Personal story opener: "When I was 16, my coach said..."
  - Specific number: "There are exactly three reasons..."

What makes a strong payoff:
  - Resolves the hook's tension with a concrete insight.
  - Lands a memorable line a viewer would screenshot.
  - Gives a clear action or takeaway.
  - Sticks the emotional landing of the story.

Score 0-10 based on:
  - Hook strength (1-3 points)
  - Payoff clarity (1-2 points)
  - Self-containment (1-2 points)
  - Broad appeal / contrarian / emotional weight (1-3 points)

A score of 7+ means "I'd publish this". 5-6 is "interesting but mid". <5 don't include unless asked.

OUTPUT: call submit_clip_candidates with the right number of clips for this source type.

CRITICAL — how to specify clip boundaries:
  - Each transcript segment has an integer "i" index. Identify the segment that contains your hook line and the segment that contains your payoff line, then return their "i" values as start_segment_index and end_segment_index.
  - These indices MUST come straight from the TRANSCRIPT json. Do NOT invent or estimate timestamps — the system derives exact seconds from the segment indices you return.
  - The hook field MUST be verbatim text from the start_segment_index segment; the payoff field MUST be verbatim text from the end_segment_index segment. They must be consistent — a hook quote from one part of the video with an index pointing somewhere else is a bug.
  - Do not summarize or paraphrase the hook/payoff fields — those are quotes used for display in the editor's dashboard.`;

function buildSystemPrompt(sourceType, aiNotes) {
  const preset = SOURCE_TYPE_PRESETS[sourceType] || SOURCE_TYPE_PRESETS.video;
  const notesBlock = aiNotes && aiNotes.trim()
    ? '\n\n## Editor notes (apply when picking clips — treat as high-priority guidance)\n' + aiNotes.trim() + '\n'
    : '';
  return (
    SYSTEM_PROMPT_PREFIX +
    '\n\n## Length guidance for this source ("' + preset.label + '")\n' +
    preset.duration_guidance + '\n' +
    preset.count_guidance +
    notesBlock +
    '\n'
  );
}

function compressTranscript(verboseJson) {
  // Segment-level is enough; word timestamps stay client-side for frame accuracy later.
  const segments = verboseJson.segments || [];
  return segments.map((s, i) => ({
    i,
    start: Number(s.start.toFixed(3)),
    end: Number(s.end.toFixed(3)),
    text: s.text.trim(),
  }));
}

async function findClips(transcript, opts = {}) {
  const { sourceType = 'video', useHardModel = false, aiNotes = '', exclude = [] } = opts;
  if (!SOURCE_TYPE_PRESETS[sourceType]) {
    throw new Error(`Unknown sourceType "${sourceType}" — expected one of: ${Object.keys(SOURCE_TYPE_PRESETS).join(', ')}.`);
  }

  const segments = compressTranscript(transcript);
  const systemPrompt = buildSystemPrompt(sourceType, aiNotes);
  const preset = SOURCE_TYPE_PRESETS[sourceType];

  // "Find more" mode: the caller passes clips already extracted. Tell the model to find
  // DIFFERENT, non-overlapping moments — and to return an empty list if there genuinely
  // aren't any good additional clips left (don't pad with weak/duplicate picks).
  const excludeBlock = (Array.isArray(exclude) && exclude.length > 0)
    ? '\n\nALREADY EXTRACTED — do NOT return these or anything that overlaps their time ranges. ' +
      'Find brand-new, non-overlapping moments elsewhere in the transcript. If there are no ' +
      'more genuinely strong, distinct clips left, return an EMPTY clips array (better to ' +
      'return nothing than to repeat or pad with weak picks):\n' +
      JSON.stringify(exclude.map((c) => ({
        start_seconds: Math.round(c.start_seconds),
        end_seconds: Math.round(c.end_seconds),
        hook: String(c.hook || '').slice(0, 80),
      })))
    : '';

  const userText =
    `Source type: ${preset.label} — ${preset.description}\n\n` +
    'TRANSCRIPT (sentence-level, JSON):\n' +
    JSON.stringify({
      duration_seconds: transcript.duration,
      language: transcript.language,
      segments,
    }) +
    excludeBlock +
    '\n\nReturn clip candidates per the length guidance. Use submit_clip_candidates.';

  const provider = PROVIDER === 'openai' ? openaiProvider : anthropicProvider;
  const result = await provider.callWithTool({
    systemPrompt,
    userText,
    maxTokens: 16000,
    useHardModel,
  });

  // Derive frame-accurate seconds from the SEGMENT INDICES the LLM returned. This is the
  // source of truth — the model only picks which segments, we look up the real timestamps.
  // (Previously the model returned raw seconds, which it routinely got wrong: a hook quote
  // from 767s tagged as starting at 199s. Indices eliminate that whole class of bug.)
  const lastIdx = segments.length - 1;
  const clips = (result.clips || [])
    .map((c, i) => {
      // Resolve start/end. Prefer indices; fall back to any raw seconds for back-compat.
      let startIdx = Number.isInteger(c.start_segment_index) ? c.start_segment_index : null;
      let endIdx = Number.isInteger(c.end_segment_index) ? c.end_segment_index : null;

      let start_seconds;
      let end_seconds;
      if (startIdx !== null && endIdx !== null) {
        startIdx = Math.max(0, Math.min(lastIdx, startIdx));
        endIdx = Math.max(startIdx, Math.min(lastIdx, endIdx));
        start_seconds = segments[startIdx].start;
        end_seconds = segments[endIdx].end;
      } else if (typeof c.start_seconds === 'number' && typeof c.end_seconds === 'number') {
        start_seconds = c.start_seconds;
        end_seconds = c.end_seconds;
      } else {
        return null; // unusable clip — no way to place it on the timeline
      }

      const duration = end_seconds - start_seconds;
      const shape = c.shape || (duration > 110 ? 'long' : 'short');
      // Drop the index fields from the stored object; downstream expects seconds.
      const { start_segment_index, end_segment_index, ...rest } = c;
      return {
        id: `c${i + 1}-${Math.round(start_seconds * 100)}`,
        shape,
        ...rest,
        start_seconds,
        end_seconds,
      };
    })
    .filter(Boolean);

  return { clips, usage: result.usage, model: result.model, sourceType };
}

const anthropicProvider = {
  async callWithTool({ systemPrompt, userText, maxTokens, useHardModel }) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set.');
    }
    const anthropic = new Anthropic();
    const model = useHardModel ? SONNET : HAIKU;
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      tools: [CLIP_TOOL],
      tool_choice: { type: 'tool', name: CLIP_TOOL.name },
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    });
    for (const block of response.content || []) {
      if (block.type === 'tool_use' && block.name === CLIP_TOOL.name) {
        return { clips: block.input.clips || [], usage: response.usage, model };
      }
    }
    throw new Error('Claude did not call submit_clip_candidates.');
  },
};

const openaiProvider = {
  async callWithTool({ systemPrompt, userText, maxTokens, useHardModel }) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set.');
    }
    const model = OPENAI_MODEL;
    const tool = {
      type: 'function',
      function: {
        name: CLIP_TOOL.name,
        description: CLIP_TOOL.description,
        parameters: CLIP_TOOL.input_schema,
      },
    };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        tools: [tool],
        tool_choice: { type: 'function', function: { name: CLIP_TOOL.name } },
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const data = await res.json();
    const call = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) throw new Error('OpenAI did not call submit_clip_candidates.');
    const parsed = JSON.parse(call.function.arguments);
    return { clips: parsed.clips || [], usage: data.usage, model };
  },
};

module.exports = { findClips, CLIP_TOOL };
