/**
 * LLM provider abstraction.
 *
 * Added because the Anthropic balance ran out mid-build and took title generation and the
 * vision classifier down with it. A pipeline that stops entirely when one account empties
 * is fragile for no good reason — the calls here are small and several providers can serve
 * them. Set LLM_PROVIDER, or leave it unset and the first provider with a usable key wins.
 */

const PROVIDERS = ['anthropic', 'gemini', 'openai'];

function available() {
  return PROVIDERS.filter((p) =>
    (p === 'anthropic' && process.env.ANTHROPIC_API_KEY) ||
    (p === 'gemini' && process.env.GEMINI_API_KEY) ||
    (p === 'openai' && process.env.OPENAI_API_KEY));
}

function pick(preferred) {
  const want = preferred || process.env.LLM_PROVIDER;
  const have = available();
  if (want && have.includes(want)) return want;
  if (!have.length) throw new Error('No LLM key set (ANTHROPIC_API_KEY, GEMINI_API_KEY or OPENAI_API_KEY)');
  return have[0];
}

/* ------------------------------------------------------------- anthropic */

async function anthropicStructured({ system, userText, images = [], schema, toolName, model }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const content = [
    ...images.map((b64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })),
    { type: 'text', text: userText },
  ];
  const msg = await client.messages.create({
    model: model || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 1400,
    system,
    tools: [{ name: toolName, description: 'Structured result.', input_schema: schema }],
    tool_choice: { type: 'tool', name: toolName },
    messages: [{ role: 'user', content }],
  });
  const use = msg.content.find((c) => c.type === 'tool_use');
  if (!use) throw new Error('anthropic returned no structured result');
  return { data: use.input, usage: msg.usage, provider: 'anthropic' };
}

/* ---------------------------------------------------------------- gemini */

/** Gemini rejects several JSON-Schema keywords, so the schema is trimmed to what it takes. */
function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['additionalProperties', '$schema', 'default', 'examples'].includes(k)) continue;
    if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === 'items') out.items = toGeminiSchema(v);
    else if (k === 'type') out.type = String(v).toUpperCase();
    else out[k] = v;
  }
  return out;
}

async function geminiStructured({ system, userText, images = [], schema, model }) {
  const key = process.env.GEMINI_API_KEY;
  const m = model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const parts = [
    ...images.map((b64) => ({ inline_data: { mime_type: 'image/jpeg', data: b64 } })),
    { text: userText },
  ];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(schema),
          // Structured output for a batch of rated items runs long; truncation mid-JSON
          // surfaces as an unhelpful parse error rather than a clear limit message.
          maxOutputTokens: 16384,
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  if (!text) {
    const reason = j?.candidates?.[0]?.finishReason;
    throw new Error(`gemini returned no content${reason ? ` (finishReason: ${reason})` : ''}`);
  }
  const finish = j?.candidates?.[0]?.finishReason;
  if (finish && finish !== 'STOP') {
    throw new Error(`gemini stopped early (${finish}) — output likely truncated`);
  }
  return {
    data: JSON.parse(text),
    usage: {
      input_tokens: j.usageMetadata?.promptTokenCount,
      output_tokens: j.usageMetadata?.candidatesTokenCount,
    },
    provider: 'gemini',
  };
}

/* ---------------------------------------------------------------- openai */

async function openaiStructured({ system, userText, images = [], schema, model }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            ...images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } })),
            { type: 'text', text: userText },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'result', schema, strict: false } },
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { data: JSON.parse(j.choices[0].message.content), usage: j.usage, provider: 'openai' };
}

/**
 * Ask for a structured result, falling through providers on failure.
 * A credit or auth error on one provider should not stop the pipeline.
 */
/**
 * Providers that returned an auth or billing error are skipped for the rest of the process.
 * Without this, an empty Anthropic balance costs a failed round-trip on EVERY call before
 * falling through — slow, and it buries the real error from the provider that did run.
 */
const deadProviders = new Set();
const isTerminal = (msg) => /401|403|credit balance|invalid_api_key|quota|billing/i.test(String(msg));

async function structured(opts) {
  const first = pick(opts.provider);
  const order = [first, ...available().filter((p) => p !== first)].filter((p) => !deadProviders.has(p));
  if (!order.length) throw new Error('no usable LLM provider (all keys rejected)');

  const errors = [];
  for (const p of order) {
    try {
      if (p === 'anthropic') return await anthropicStructured(opts);
      if (p === 'gemini') return await geminiStructured(opts);
      if (p === 'openai') return await openaiStructured(opts);
    } catch (err) {
      const msg = String(err.message);
      if (isTerminal(msg)) {
        deadProviders.add(p);
        console.warn(`[llm] ${p} is unusable (${msg.slice(0, 80)}) — skipping it from now on`);
      }
      errors.push(`${p}: ${msg.slice(0, 200)}`);
    }
  }
  throw new Error(`every LLM provider failed:\n  ${errors.join('\n  ')}`);
}

module.exports = { structured, available, pick };
