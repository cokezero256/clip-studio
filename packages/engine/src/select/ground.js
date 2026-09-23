/**
 * Ground clip selection in the outlier corpus.
 *
 * THE PROBLEM THIS FIXES: candidate ranking ran on nine coefficients I wrote by hand
 * (`numberDensity * 1.5`, `resultClaim * 2`, …). They were reasonable guesses about trading
 * clips, and nothing more — the corpus of what actually went viral on these pages never
 * reached them. So the top-ranked clips were "dense, number-y speech", not "the kind of
 * moment that works on these pages".
 *
 * Two rules shape the design:
 *
 *  1. RETRIEVE, don't summarise. Handing a model "what makes trading clips work" produces
 *     platitudes it would have written anyway. It has to see specific competing clips with
 *     their measured scores.
 *  2. SHOW THE FLOPS. With winners only, a model learns "a trading clip". The corpus holds
 *     more underperformers than outliers, and they are the more informative half — they
 *     mark what these same pages published that did NOT land.
 */

const { structured } = require('../llm/provider');

const STOP = new Set(('a an the and or but so then this that these those it its is are was were be been am i you he she we they my your our their of to in on at for with from as if by up down out over under again just now also very really kind sort like get got go going gonna know think see look want need make made take took put say said thing things one two some any all no not yes okay ok yeah right well here there what when where how why who which').split(' '));

/** Distinctive terms of a text — the basis for cheap topical retrieval, no embeddings API. */
function terms(text) {
  const counts = new Map();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9$%.]+/)) {
    const w = raw.replace(/^\.+|\.+$/g, '');
    if (!w || w.length < 3 || STOP.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return counts;
}

/** Cosine over term counts. Crude, free, and good enough to pick topically-near clips. */
function similarity(aTerms, bTerms) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of aTerms) na += v * v;
  for (const [w, v] of bTerms) {
    nb += v * v;
    const av = aTerms.get(w);
    if (av) dot += av * v;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Pick exemplars for one candidate: the most topically similar winners AND flops.
 * Both halves are drawn from the same corpus so the comparison is like-for-like.
 */
function retrieveExemplars(candidateText, corpus, { winners = 6, flops = 4 } = {}) {
  const ct = terms(candidateText);
  const scored = corpus
    .filter((c) => c.transcript && c.transcript.length > 40)
    .map((c) => ({ ...c, sim: similarity(ct, terms(`${c.transcript} ${c.ocr_title || ''}`)) }));

  const w = scored.filter((c) => c.z >= 0.8).sort((a, b) => b.sim - a.sim).slice(0, winners);
  const f = scored.filter((c) => c.z < -0.3).sort((a, b) => b.sim - a.sim).slice(0, flops);
  return { winners: w, flops: f };
}

const SCHEMA = {
  type: 'object',
  properties: {
    ratings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['ship', 'maybe', 'cut'] },
          score: { type: 'number', description: '0-10, how well this matches what wins on these pages' },
          closest_exemplar: { type: 'string', description: 'The title or opening words of the corpus clip this most resembles. Required.' },
          why: { type: 'string', description: 'One sentence, referring to the exemplars.' },
          failure_mode: { type: 'string', enum: ['none', 'no_payoff', 'needs_context', 'rambling', 'no_specifics', 'mid_thought', 'generic_advice'] },
        },
        required: ['id', 'verdict', 'score', 'closest_exemplar', 'why', 'failure_mode'],
      },
    },
  },
  required: ['ratings'],
};

const SYSTEM = `You rank moments cut from a trader's livestream by how well each matches what
actually performs on trading pages.

You are given, for each candidate, real clips from those pages WITH their measured results.
The multiplier is versus that page's own typical reel — 4.1x means four times their normal
reach. Clips marked UNDERPERFORMED are from the same pages and did NOT land.

THE STRUCTURE THAT WORKS on these pages, in order of importance:

1. It OPENS ON THE REACTION or the result — "oh my god that was crazy", "look at that",
   "I just caught 300 points". The viewer is hooked before anything is explained.
2. It then PAYS OFF with the how — "so basically what I'm saying is this, and this" — and
   shows the trade or the level on the chart.
3. It TEACHES something a viewer can take away. A clip that merely narrates what the
   trader is watching teaches nothing.

Score low, regardless of how articulate it sounds:
- Setup and housekeeping. "I didn't really notify anybody, but I was live yesterday" is
  someone clearing their throat, not a clip.
- Running commentary with no outcome — "I'm watching to see if VIX continues down".
- Anything needing context from earlier in the stream.
- Technical difficulties, audio checks, greeting the chat.

YOU ARE COMPARING RAW CUTS TO FINISHED REELS. The exemplars were edited, titled, scored
and tightened before release. The candidates are unedited spans lifted straight out of a
livestream, and they will be rougher: a filler word at the top, a thought that takes a beat
to land. Judge the STRUCTURE — does it open on a reaction or result, pay it off with the
how, and leave the viewer something to take away? Do not mark a candidate down for lacking
polish that only editing adds. Verbal roughness is not a reason to cut; having nothing to
say is.

Also:
- A clip resembling the UNDERPERFORMED examples scores low even if it sounds fine.
- "closest_exemplar" is required, and is corroborating evidence, not a gate. The corpus is
  small and does not cover everything that works. A candidate with the right structure is
  still good when the nearest exemplar is only a loose match — say so in "why" and score it
  on its structure. Only score low for novelty when the moment is genuinely unlike anything
  that performs in this niche.

BE HARSH, BUT BE USABLE. A multi-hour livestream typically contains two to five clips worth
posting, and often fewer — rating eight candidates "ship" would be wrong. Equally, rating
everything "cut" is only the right answer when the stream truly contains no moment that
opens strong and teaches something. If a handful are clearly the best of what is there,
rank them "ship" or "maybe" and say what an editor would need to fix.`;

function renderExemplar(c, label) {
  const head = (c.transcript || '').slice(0, 260).replace(/\s+/g, ' ');
  return `  [${label} ${c.display_mult}x @${c.username}] ${c.ocr_title ? `"${c.ocr_title}" — ` : ''}${head}`;
}

/**
 * Re-rank candidates against the corpus.
 * Returns each candidate with a corpusScore, the exemplar it matched, and why.
 */
async function groundedRank(candidates, corpus, { provider, model, batch = 5 } = {}) {
  if (!corpus.length) return candidates.map((c) => ({ ...c, corpusScore: null, grounded: false }));

  const out = [];
  for (let i = 0; i < candidates.length; i += batch) {
    const slice = candidates.slice(i, i + batch);

    // One exemplar set per batch, drawn from the batch's combined content — keeps the
    // prompt small while staying topically relevant.
    const combined = slice.map((c) => c.text || '').join(' ');
    const { winners, flops } = retrieveExemplars(combined, corpus);

    const block = [
      winners.length ? `Clips that WORKED on these pages:\n${winners.map((c) => renderExemplar(c, 'WON')).join('\n')}` : '',
      flops.length ? `\nClips that UNDERPERFORMED on the same pages:\n${flops.map((c) => renderExemplar(c, 'FLOP')).join('\n')}` : '',
    ].filter(Boolean).join('\n');

    const cands = slice.map((c, k) =>
      `[${i + k}] (${Math.round(c.durationSeconds || 0)}s) ${(c.text || '').slice(0, 520).replace(/\s+/g, ' ')}`
    ).join('\n\n');

    try {
      const r = await structured({
        provider, model,
        system: SYSTEM,
        schema: SCHEMA,
        toolName: 'rate_candidates',
        userText: `${block}\n\nNow rate these candidate moments:\n\n${cands}`,
      });
      const byId = new Map((r.data.ratings || []).map((x) => [String(x.id), x]));
      slice.forEach((c, k) => {
        const rating = byId.get(String(i + k)) || byId.get(String(k));
        out.push({
          ...c,
          corpusScore: rating ? rating.score : null,
          verdict: rating ? rating.verdict : null,
          closestExemplar: rating ? rating.closest_exemplar : null,
          why: rating ? rating.why : null,
          failureMode: rating ? rating.failure_mode : null,
          grounded: Boolean(rating),
          exemplarsUsed: { winners: winners.length, flops: flops.length },
        });
      });
    } catch (err) {
      // A ranking failure must not lose the candidates — fall back to the local score.
      slice.forEach((c) => out.push({ ...c, corpusScore: null, grounded: false, rankError: String(err.message).slice(0, 120) }));
    }
  }

  /**
   * Final order. The corpus score leads because it is the one grounded in real outcomes;
   * the local signal only breaks ties. Both are kept and surfaced separately so a
   * disagreement is visible rather than averaged away.
   */
  out.sort((a, b) => {
    const av = a.verdict === 'ship' ? 2 : a.verdict === 'maybe' ? 1 : 0;
    const bv = b.verdict === 'ship' ? 2 : b.verdict === 'maybe' ? 1 : 0;
    if (av !== bv) return bv - av;
    if ((b.corpusScore ?? -1) !== (a.corpusScore ?? -1)) return (b.corpusScore ?? -1) - (a.corpusScore ?? -1);
    return (b.prescore ?? 0) - (a.prescore ?? 0);
  });
  return out;
}

module.exports = { groundedRank, retrieveExemplars, terms, similarity };
