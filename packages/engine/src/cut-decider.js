const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

const HAIKU = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const SONNET = process.env.CLAUDE_MODEL_HARD || 'claude-sonnet-4-5-20250929';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_MODEL_HARD = process.env.OPENAI_MODEL_HARD || 'gpt-4o';
const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

const CUT_TOOL = {
  name: 'submit_cut_decisions',
  description:
    'Submit the list of edit decisions for this transcript. ' +
    'Each entry covers a continuous span and either drops it (filler/silence/restart/mistake) ' +
    'or flags it as a high-quality highlight worth featuring.',
  input_schema: {
    type: 'object',
    properties: {
      cuts: {
        type: 'array',
        description: 'Edit decisions, ordered by start_seconds.',
        items: {
          type: 'object',
          properties: {
            start_seconds: { type: 'number', description: 'Start time in seconds (float).' },
            end_seconds: { type: 'number', description: 'End time in seconds (float).' },
            action: {
              type: 'string',
              enum: ['drop', 'keep_highlight'],
              description: 'drop = remove this span; keep_highlight = surface as opener/quote candidate.',
            },
            reason: {
              type: 'string',
              enum: ['silence', 'filler', 'restart', 'mistake', 'rambling', 'repetition', 'alt_take', 'hook', 'b_roll_cue'],
              description: 'Primary reason for this decision. alt_take = a stumbled/incomplete attempt at a sentence that the speaker tries again later — drop these aggressively, keep the final clean attempt.',
            },
            note: {
              type: 'string',
              description: 'One sentence on why, including the actual filler word or hook text if relevant.',
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: '0.85+ = auto-apply. 0.6–0.85 = suggest only. <0.6 = will be discarded.',
            },
          },
          required: ['start_seconds', 'end_seconds', 'action', 'reason', 'confidence'],
        },
      },
    },
    required: ['cuts'],
  },
};

const SYSTEM_PROMPT_BASE = `You are an editing assistant for a YouTube/social video editor. Given a sentence-level transcript with timestamps, decide which spans to drop and which to flag as highlights.

THE MOST IMPORTANT PATTERN — multi-take recordings:
The speaker records the same sentence multiple times in a row, stumbling and restarting until they nail it. The user has explicitly stated: **"ONLY put my best takes."** Translate that into this rule, applied aggressively:

  → When you see N consecutive attempts at the same sentence/phrase, KEEP ONLY THE LAST ONE. Drop the rest as "alt_take", regardless of how complete or fluent the earlier ones look.

  → ABSOLUTE RULE: ALWAYS keep the LAST take. Do not exercise judgment about which take is "best" — the user has stated explicitly that the LAST take is always the one they want, even if an earlier one sounds slightly cleaner to you. Do not drop the last take. Do not keep an earlier take. Last = kept, every other = dropped.

  → For each alt_take cut, the cut's end_seconds MUST be at or before the start time of the FINAL attempt's first transcribed word. Verify this before submitting: the segment whose start time is your cut's end_seconds should be the LAST attempt of the phrase, and it must NOT be inside your cut span.

  → BIAS IS AGGRESSIVE. If you're 60% sure something is a take of a phrase that gets re-attempted later, drop it. The user prefers over-cutting to under-cutting. Conservatism on multi-take detection is the wrong default for this user.

  → A single "alt_take" drop CAN span more than 8 seconds. A bad take is often 10-20 seconds. Don't artificially split it.

  → Mark "alt_take" with high confidence (0.90+) when the pattern is unambiguous: same opening words, same intent, multiple consecutive segments. Use 0.85+ even when only somewhat confident — the user wants aggressive cutting.

  → If a single segment ITSELF contains multiple attempts (e.g. "Traditional market is, traditional marketing is, traditional marketing is that..."), drop the FRONT of the segment up to where the final clean attempt begins. Use word-level timing in words[] to find where the last attempt starts. Set the cut's end_seconds to the start time of the final attempt's first word.

SECOND MOST IMPORTANT — in-line mistakes WITHIN kept segments:
For every segment you DON'T mark as alt_take, scan its word-level timing for:
  - **Struggled words**: a word with duration > 0.7s usually means the speaker stretched it out trying to remember what comes next, OR mispronounced and stretched the recovery. Cut these.
  - **Stuttered words**: same word appears twice back-to-back at the word level ("the the", "a a"). Cut the first one.
  - **Half-words / abandoned starts**: a word fragment followed by the same word starting fresh ("marke— marketing", "trad— traditional"). Cut the fragment.
  - **In-line restarts**: speaker says a few words, pauses, then restarts the SAME phrase mid-segment ("So the thing— so the thing is..."). Cut the first attempt up to the restart.
  - **In-line corrections**: speaker says wrong word, immediately corrects ("the marketin—, the advertising is..."). Cut the wrong word.

These are SHORT cuts (typically 0.2–2.0 seconds each). Look at the words[] array in each segment — duration gaps and word-level patterns reveal these. Be MORE aggressive on in-line mistakes than on alt_take — it's better to over-cut a stutter than to leave it.

OTHER drop reasons:
  - silence — long silent gap (above the per-client threshold). Long opening silences before the speaker starts ARE real cuts, even if 10+ seconds. Don't artificially split.
  - filler — "um", "uh", "like", "you know" etc. Cut just the filler, not surrounding words.
  - restart — see "in-line mistakes" above.
  - mistake — see "in-line mistakes" above.
  - rambling — low-information aside that doesn't advance the point.
  - repetition — TRUE redundant content where the same point is delivered cleanly twice (NOT failed takes — those are alt_take). Be conservative here.

Span limits:
  - "alt_take" and "silence": no upper limit, drop the full span.
  - All other reasons: cap each single drop at 8 seconds. If you want to drop more, split into multiple decisions.
  - Never drop content < 0.2 seconds.

PROCESS:
  1. First pass over segments: identify alt_take groups (multi-segment repetitions of the same line) and drop all but the LAST take.
  2. Then for each KEPT segment, scan its words[] for in-line mistakes. Drop those.
  3. Combine all drops into a single sorted list.

"keep_highlight" reasons:
  - hook (5–15s opener candidate — strong, declarative, intriguing)
  - b_roll_cue (the speaker mentions a visual concept the editor could illustrate: "imagine a...", "picture this...", "look at...")

DO NOT cut:
- Rhetorical repetition that's clearly intentional ("we will, we will, rock you")
- Pauses < the silence threshold (those are natural beats)
- Content the per-client style guide marks as protected

OUTPUT: call the submit_cut_decisions tool. Do not write prose. Do not summarize. Just call the tool.`;

function buildSystemPrompt(clientConfig, aiNotes) {
  const lines = [
    SYSTEM_PROMPT_BASE,
    '',
    '## Client config',
    `- silence_threshold_seconds: ${clientConfig.silence_threshold_seconds}`,
    `- filler_words: ${JSON.stringify(clientConfig.filler_words)}`,
    `- never_cut_words: ${JSON.stringify(clientConfig.never_cut_words || [])}`,
    `- min_keep_segment_seconds: ${clientConfig.min_keep_segment_seconds}`,
    `- max_cut_span_seconds: ${clientConfig.max_cut_span_seconds || 8}`,
    '',
    '## Style guide',
    clientConfig.style_guide || '(none)',
  ];
  if (aiNotes && aiNotes.trim()) {
    lines.push(
      '',
      '## Editor notes for THIS video (highest priority — these override the generic guidance above)',
      'Read these carefully. If the editor names specific phrases / sentences / topics to cut, drop those segments even if Whisper transcribed them cleanly. If they reference timestamps (e.g. "00:15", "minute 2"), match by start_seconds.',
      '',
      aiNotes.trim(),
    );
  }
  return lines.join('\n');
}

function compressTranscript(verboseJson, { includeWords = true } = {}) {
  // Send segments WITH their word-level timing nested inside, so the model can see in-line
  // stutters, struggled words (long duration), half-words, and mispronunciations.
  // For very long transcripts, includeWords=false drops the word arrays so the payload
  // fits in the model context — Claude still handles alt_take / silence / filler from
  // segment boundaries alone.
  const segments = verboseJson.segments || [];
  const words = verboseJson.words || [];

  return segments.map((s, i) => {
    const base = {
      i,
      start: Number(s.start.toFixed(3)),
      end: Number(s.end.toFixed(3)),
      text: s.text.trim(),
    };
    if (!includeWords) return base;
    const segWords = words
      .filter((w) => w.start >= s.start - 0.05 && w.end <= s.end + 0.05)
      .map((w) => ({
        w: (w.word || '').trim(),
        s: Number(w.start.toFixed(3)),
        e: Number(w.end.toFixed(3)),
        d: Number((w.end - w.start).toFixed(3)), // duration — long values flag struggle
      }));
    return { ...base, words: segWords };
  });
}

function modelFor(clientConfig) {
  if (clientConfig.model === 'sonnet') return SONNET;
  return HAIKU;
}

// Rough token estimate: JSON serialisation / 4 chars-per-token heuristic.
function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

// Split segments into overlapping chunks so each chunk's transcript fits within
// MAX_CHUNK_TOKENS. Overlap ensures take-groups spanning a boundary are seen by
// both adjacent chunks — the merge step deduplicates them.
function chunkSegments(segments, maxTokens, overlap = 25) {
  const chunks = [];
  let i = 0;
  while (i < segments.length) {
    const chunk = [];
    let tokens = 0;
    let j = i;
    while (j < segments.length) {
      const t = estimateTokens(segments[j]);
      if (tokens + t > maxTokens && chunk.length >= overlap * 2) break;
      chunk.push(segments[j]);
      tokens += t;
      j++;
    }
    chunks.push(chunk);
    if (j >= segments.length) break;
    i = j - overlap; // step back for overlap
  }
  return chunks;
}

// Merge cut lists from multiple chunks. Cuts whose start_seconds are within
// DEDUP_WINDOW of an existing cut are considered duplicates — keep the higher-
// confidence one.
function mergeCuts(cutArrays) {
  const DEDUP_WINDOW = 0.5; // seconds
  const merged = [];
  for (const cuts of cutArrays) {
    for (const c of cuts) {
      const dup = merged.find(
        (m) =>
          Math.abs(m.start_seconds - c.start_seconds) < DEDUP_WINDOW &&
          m.reason === c.reason,
      );
      if (dup) {
        if (c.confidence > dup.confidence) Object.assign(dup, c);
      } else {
        merged.push({ ...c });
      }
    }
  }
  return merged.sort((a, b) => a.start_seconds - b.start_seconds);
}

async function decideCuts(transcript, clientConfig, { client, twoPass = true, aiNotes = '' } = {}) {
  // Safe limit: model max is 200k; leave ~30k for system prompt + tool schema + response.
  const SAFE_TOKENS = 170000;

  // Try full word-level format first; fall back to segments-only if too large.
  let segments = compressTranscript(transcript, { includeWords: true });
  let totalTranscriptTokens = estimateTokens(segments);
  let includesWords = true;

  if (totalTranscriptTokens > SAFE_TOKENS) {
    segments = compressTranscript(transcript, { includeWords: false });
    totalTranscriptTokens = estimateTokens(segments);
    includesWords = false;
    console.log(
      `[cut-decider] transcript too large with word timing (~${estimateTokens(compressTranscript(transcript))} est tokens) — ` +
      `using segments-only format (~${totalTranscriptTokens} est tokens). In-line stutter detection disabled for this video.`,
    );
  }

  const systemPrompt = buildSystemPrompt(clientConfig, aiNotes);
  const provider = pickProvider();

  // If segments-only STILL exceeds the safe limit, chunk it.
  const MAX_CHUNK_TOKENS = SAFE_TOKENS;
  const needsChunking = totalTranscriptTokens > MAX_CHUNK_TOKENS;

  if (needsChunking) {
    console.log(
      `[cut-decider] transcript ~${totalTranscriptTokens} tokens — splitting into chunks of ≤${MAX_CHUNK_TOKENS}`,
    );
  }

  const chunks = needsChunking
    ? chunkSegments(segments, MAX_CHUNK_TOKENS)
    : [segments];

  const allValidated = [];
  let totalUsage = null;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const chunkStart = chunk[0]?.start ?? 0;
    const chunkEnd = chunk[chunk.length - 1]?.end ?? transcript.duration;

    if (needsChunking) {
      console.log(
        `[cut-decider] chunk ${ci + 1}/${chunks.length}: ${chunk.length} segments (${chunkStart.toFixed(1)}s – ${chunkEnd.toFixed(1)}s)`,
      );
    }

    const userText =
      (needsChunking
        ? `This is chunk ${ci + 1} of ${chunks.length} (${chunkStart.toFixed(1)}s–${chunkEnd.toFixed(1)}s of ${transcript.duration.toFixed(1)}s total).\n`
        : '') +
      'TRANSCRIPT (segments-level, JSON):\n' +
      JSON.stringify({
        duration_seconds: transcript.duration,
        chunk_start: chunkStart,
        chunk_end: chunkEnd,
        language: transcript.language,
        segments: chunk,
      }) +
      '\n\nReturn cut decisions for this chunk. Cover the full chunk range where relevant. Use submit_cut_decisions.';

    const pass1 = await provider.callWithTool({ systemPrompt, userText, clientConfig });

    // Merge usage across chunks
    if (!totalUsage) totalUsage = pass1.usage;
    else if (pass1.usage) {
      totalUsage = {
        input_tokens: (totalUsage.input_tokens || 0) + (pass1.usage.input_tokens || 0),
        output_tokens: (totalUsage.output_tokens || 0) + (pass1.usage.output_tokens || 0),
      };
    }

    const validated = sanitizeAndClampCuts(pass1.cuts || [], {
      duration: transcript.duration,
      maxSpan: clientConfig.max_cut_span_seconds || 8,
      suggestThreshold: clientConfig.suggest_confidence ?? 0.6,
    });

    // Two-pass re-evaluation (only for single chunk or last chunk to keep cost down).
    const autoApply = clientConfig.auto_apply_confidence ?? 0.85;
    const suggest = clientConfig.suggest_confidence ?? 0.6;

    if (twoPass && (!needsChunking || ci === chunks.length - 1)) {
      const ambiguous = validated.filter(
        (c) => c.action === 'drop' && c.confidence >= suggest && c.confidence < autoApply,
      );
      if (ambiguous.length > 0) {
        const reEvalText =
          'Re-evaluate these candidate cuts with ±5s of surrounding context. Watch for rhetorical repetition.\n\n' +
          'Candidates:\n' +
          JSON.stringify(
            ambiguous.map((cut) => {
              const lo = Math.max(0, cut.start_seconds - 5);
              const hi = cut.end_seconds + 5;
              const window = chunk.filter((s) => s.end >= lo && s.start <= hi);
              return { cut, window };
            }),
            null,
            2,
          );
        const pass2 = await provider.callWithTool({
          systemPrompt,
          userText: reEvalText,
          clientConfig,
          maxTokens: 4096,
        });
        const reEvalMap = new Map();
        for (const c of pass2.cuts || []) {
          if (typeof c.start_seconds === 'number') {
            reEvalMap.set(c.start_seconds.toFixed(3), c.confidence ?? 0.5);
          }
        }
        allValidated.push(...mergeReEvaluations(validated, reEvalMap));
        continue;
      }
    }

    allValidated.push(...validated);
  }

  const finalCuts = needsChunking ? mergeCuts([allValidated]) : allValidated;

  return {
    cuts: finalCuts,
    usage: { pass1: totalUsage },
    model: provider.modelName(clientConfig),
    provider: provider.name,
  };
}

function pickProvider() {
  if (PROVIDER === 'openai') return openaiProvider;
  return anthropicProvider;
}

const anthropicProvider = {
  name: 'anthropic',
  modelName(clientConfig) {
    return clientConfig.model === 'sonnet' ? SONNET : HAIKU;
  },
  async callWithTool({ systemPrompt, userText, clientConfig, maxTokens = 8192 }) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env, or set LLM_PROVIDER=openai.');
    }
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: this.modelName(clientConfig),
      max_tokens: maxTokens,
      tools: [CUT_TOOL],
      tool_choice: { type: 'tool', name: CUT_TOOL.name },
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    });
    for (const block of response.content || []) {
      if (block.type === 'tool_use' && block.name === CUT_TOOL.name) {
        return { cuts: block.input.cuts || [], usage: response.usage };
      }
    }
    throw new Error('Anthropic did not call submit_cut_decisions.');
  },
};

const openaiProvider = {
  name: 'openai',
  modelName(clientConfig) {
    return clientConfig.model === 'sonnet' ? OPENAI_MODEL_HARD : OPENAI_MODEL;
  },
  async callWithTool({ systemPrompt, userText, clientConfig, maxTokens = 8192 }) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set.');
    }
    const tool = {
      type: 'function',
      function: {
        name: CUT_TOOL.name,
        description: CUT_TOOL.description,
        parameters: CUT_TOOL.input_schema,
      },
    };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.modelName(clientConfig),
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        tools: [tool],
        tool_choice: { type: 'function', function: { name: CUT_TOOL.name } },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = await res.json();
    const call = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!call || call.function?.name !== CUT_TOOL.name) {
      throw new Error('OpenAI did not call submit_cut_decisions.');
    }
    let parsed;
    try {
      parsed = JSON.parse(call.function.arguments);
    } catch (err) {
      throw new Error(`OpenAI returned invalid JSON in tool call: ${err.message}`);
    }
    return { cuts: parsed.cuts || [], usage: data.usage };
  },
};

function extractToolInput(response, toolName) {
  for (const block of response.content || []) {
    if (block.type === 'tool_use' && block.name === toolName) return block.input;
  }
  return null;
}

function sanitizeAndClampCuts(rawCuts, { duration, maxSpan, suggestThreshold }) {
  return rawCuts
    .filter((c) => typeof c.start_seconds === 'number' && typeof c.end_seconds === 'number')
    .map((c) => ({
      start_seconds: Math.max(0, Math.min(c.start_seconds, duration)),
      end_seconds: Math.max(0, Math.min(c.end_seconds, duration)),
      action: c.action === 'keep_highlight' ? 'keep_highlight' : 'drop',
      reason: c.reason || 'unknown',
      note: c.note || '',
      confidence: clamp(typeof c.confidence === 'number' ? c.confidence : 0.5, 0, 1),
    }))
    .filter((c) => c.end_seconds > c.start_seconds + 0.05) // discard sub-50ms cuts
    .filter((c) => c.confidence >= suggestThreshold)
    .map((c) => {
      // Clamp drop spans that exceed maxSpan — defensive against runaway cuts.
      // Exception: silence, alt_take, and mistake/restart are allowed to exceed because
      // long opening silences, multi-take stumbles, and elongated stutter regions are
      // legitimately long.
      const exempt =
        c.reason === 'silence' ||
        c.reason === 'alt_take' ||
        c.reason === 'mistake' ||
        c.reason === 'restart';
      if (c.action === 'drop' && !exempt && c.end_seconds - c.start_seconds > maxSpan) {
        c.end_seconds = c.start_seconds + maxSpan;
        c.note = `${c.note} [clamped to ${maxSpan}s max span]`.trim();
      }
      return c;
    })
    .sort((a, b) => a.start_seconds - b.start_seconds);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

async function reEvaluateAmbiguous(anthropic, ambiguous, segments, clientConfig, systemPrompt) {
  // For each ambiguous cut, build a small context window (segments overlapping the cut ± 5s)
  // and ask Claude to confirm or reject. Returns a map keyed by start_seconds.
  const items = ambiguous.map((cut) => {
    const lo = Math.max(0, cut.start_seconds - 5);
    const hi = cut.end_seconds + 5;
    const window = segments.filter((s) => s.end >= lo && s.start <= hi);
    return { cut, window };
  });

  const prompt =
    'Re-evaluate these candidate cuts with ±5s of surrounding context. For each, return your confidence (0–1) ' +
    'that the cut should be APPLIED (high = yes, drop it; low = no, keep it). Watch for rhetorical repetition.\n\n' +
    'Candidates:\n' +
    JSON.stringify(items, null, 2);

  const response = await anthropic.messages.create({
    model: modelFor(clientConfig),
    max_tokens: 4096,
    tools: [CUT_TOOL],
    tool_choice: { type: 'tool', name: CUT_TOOL.name },
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  });

  const out = extractToolInput(response, CUT_TOOL.name);
  if (!out || !Array.isArray(out.cuts)) return new Map();

  const map = new Map();
  for (const c of out.cuts) {
    if (typeof c.start_seconds === 'number') {
      map.set(c.start_seconds.toFixed(3), c.confidence ?? 0.5);
    }
  }
  return map;
}

function mergeReEvaluations(originalCuts, reEvalMap) {
  if (!(reEvalMap instanceof Map) || reEvalMap.size === 0) return originalCuts;
  return originalCuts.map((c) => {
    const key = c.start_seconds.toFixed(3);
    if (reEvalMap.has(key)) {
      const newConf = clamp(reEvalMap.get(key), 0, 1);
      // Average the two passes — pass 2 has context, pass 1 has full-document view.
      c.confidence = (c.confidence + newConf) / 2;
    }
    return c;
  });
}

module.exports = { decideCuts, CUT_TOOL };
