'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, X, Scissors, Clock, Play, Sparkles, Loader2, Film, Settings2, PenLine } from 'lucide-react';

/** Every 9:16 arrangement the renderer can produce. */
const FORMATS: { group: string; options: { id: string; label: string }[] }[] = [
  {
    group: 'Re-composed (fills the frame)',
    options: [
      { id: 'screen-top', label: 'Chart on top, trader below' },
      { id: 'camera-top', label: 'Trader on top, chart below' },
      { id: 'screen-big', label: 'Big chart, small trader' },
      { id: 'camera-big', label: 'Big trader, small chart' },
      { id: 'screen-full-pip-br', label: 'Full chart + trader inset (right)' },
      { id: 'screen-full-pip-bl', label: 'Full chart + trader inset (left)' },
      { id: 'screen-only', label: 'Chart only' },
      { id: 'camera-only', label: 'Trader only' },
    ],
  },
  {
    group: 'Band on black (keeps the original frame)',
    options: [
      { id: 'band-title-top', label: 'Title above, video centred' },
      { id: 'band-title-tight', label: 'Title high, video higher' },
      { id: 'band-title-low', label: 'Title mid, video low' },
      { id: 'band-no-title', label: 'Video centred, no title' },
    ],
  },
];

type Gate = { id: string; passed: boolean; name?: string; detail: string };

export type ClipRow = {
  id: string; start_s: number; end_s: number; duration_s: number | null;
  hook: string | null; prescore: number | null; cuts_count: number;
  silence_removed_ms: number; gate_json: string; ready: number;
  title_text?: string | null;
  verdict?: string | null; corpus_score?: number | null; corpus_why?: string | null;
  rank?: number | null;
  render_id?: string | null; render_passed?: number | null;
};

type GateResult = { id: string; name: string; passed: boolean; detail: string };
type TitleCandidate = {
  title: string;
  result_promise: string;
  mechanism: string;
  verification: { passed: boolean; results: GateResult[] };
};

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function ClipCard({ clip, onRendered }: { clip: ClipRow; onRendered?: () => void }) {
  const [open, setOpen] = useState(false);
  const [titles, setTitles] = useState<{ accepted: TitleCandidate[]; rejected: TitleCandidate[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string | null>(clip.title_text ?? null);
  const [rendering, setRendering] = useState(false);
  const [renderMsg, setRenderMsg] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState(clip.title_text ?? '');
  const [fmt, setFmt] = useState('band-title-top');

  /** The corpus verdict is advice — an editor can always render a clip anyway. */
  const renderNow = async (opts: { paneOrder?: string; title?: string } = {}) => {
    setRendering(true);
    setRenderMsg('queued…');
    const { jobId } = await fetch(`/api/clips/${clip.id}/render`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }).then((x) => x.json());
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    es.addEventListener('progress', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setRenderMsg(`${d.stage}: ${d.message ?? ''}`.slice(0, 48));
    });
    es.addEventListener('end', () => {
      es.close(); setRendering(false); setRenderMsg(null);
      onRendered?.();
    });
  };

  const suggest = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/clips/${clip.id}/titles`, { method: 'POST' }).then((x) => x.json());
      setTitles(r.error ? { accepted: [], rejected: [] } : r);
    } finally { setBusy(false); }
  };

  const choose = async (t: string) => {
    setChosen(t);
    await fetch(`/api/clips/${clip.id}/titles`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t }),
    });
  };
  const gates: Gate[] = (() => { try { return JSON.parse(clip.gate_json)?.results ?? []; } catch { return []; } })();
  const failed = gates.filter((g) => !g.passed);
  const ready = clip.ready === 1;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-bg-2 transition hover:border-bg-4">
      <div className="relative aspect-[9/16] bg-bg-1">
        {clip.render_id ? (
          <video
            src={`/api/media?render=${clip.render_id}`}
            controls
            preload="metadata"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-fg-3">
            <Play className="h-6 w-6" />
            <span className="text-[11px] leading-snug">
              {clip.verdict === 'cut'
                ? 'Not rendered — the corpus rated this below the bar'
                : 'Not rendered yet'}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); renderNow({ paneOrder: fmt, title: titleDraft }); }}
              disabled={rendering}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[11px] font-medium text-fg-2 transition hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {rendering ? <Loader2 className="h-3 w-3 animate-spin" /> : <Film className="h-3 w-3" />}
              {rendering ? 'Rendering…' : 'Render anyway'}
            </button>
            {renderMsg && <span className="text-[10px] text-fg-3">{renderMsg}</span>}
          </div>
        )}
        {/* The editor is the primary action on a clip: timeline, transcript, title, captions. */}
        <Link href={`/clips/${clip.id}`} onClick={(e) => e.stopPropagation()}
          className="absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-white shadow-lg transition hover:bg-accent-hover">
          <PenLine className="h-3 w-3" /> Edit
        </Link>
        <div className="pointer-events-none absolute left-2 top-2 flex gap-1.5">
          {/* The corpus verdict leads, because it reflects real outcomes on the tracked
              pages. The technical gate is secondary — a clip can be flawlessly cut and
              still not be worth posting. */}
          {clip.verdict ? (
            <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold uppercase ${
              clip.verdict === 'ship' ? 'bg-accent text-white'
                : clip.verdict === 'maybe' ? 'bg-warning/20 text-warning'
                : 'bg-bg-4 text-fg-3'}`}>
              {clip.verdict}{clip.corpus_score != null ? ` ${clip.corpus_score}/10` : ''}
            </span>
          ) : (
            <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
              ready ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
              {ready ? 'Ready' : `${failed.length} gate${failed.length === 1 ? '' : 's'}`}
            </span>
          )}
        </div>
      </div>

      <div className="p-3">
        <p className="line-clamp-2 text-[13px] leading-snug text-fg-1">
          {clip.hook?.trim() || '—'}
        </p>
        {clip.corpus_why && (
          <p className="mt-1.5 line-clamp-3 text-[11px] leading-snug text-fg-3">
            {clip.corpus_why}
          </p>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-3">
          <span className="flex items-center gap-1"><Clock className="h-3 w-3" />
            {mmss(clip.start_s)} · {Math.round(clip.duration_s ?? clip.end_s - clip.start_s)}s
          </span>
          {clip.cuts_count > 0 && (
            <span className="flex items-center gap-1 text-fg-2">
              <Scissors className="h-3 w-3" />
              {clip.cuts_count} cuts · {(clip.silence_removed_ms / 1000).toFixed(1)}s silence out
            </span>
          )}
        </div>

        {/* Per-clip controls: what the title says, and how the frame is arranged. */}
        <div className="mt-3 border-t border-line pt-2.5">
          <button onClick={() => setMenuOpen((o) => !o)}
            className="mb-2 flex w-full items-center gap-1.5 text-[11px] font-medium text-fg-2 transition hover:text-accent">
            <Settings2 className="h-3 w-3" />
            Title &amp; format
            <span className="ml-auto text-fg-3">{menuOpen ? '−' : '+'}</span>
          </button>

          {menuOpen && (
            <div className="mb-3 space-y-2 rounded-lg border border-line bg-bg-1/50 p-2.5">
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wider text-fg-3">
                  On-screen title
                </span>
                <textarea
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  rows={2}
                  placeholder="Day Trading Is Insane 😳"
                  className="w-full resize-none rounded-md border border-line bg-bg-3 px-2 py-1.5 text-[12px] leading-snug outline-none focus:border-accent"
                />
                <span className="mt-0.5 block text-[10px] text-fg-3">
                  {titleDraft.length}/62 — emoji work
                </span>
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wider text-fg-3">
                  Format
                </span>
                <select value={fmt} onChange={(e) => setFmt(e.target.value)}
                  className="w-full rounded-md border border-line bg-bg-3 px-2 py-1.5 text-[12px] outline-none focus:border-accent">
                  {FORMATS.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>

              <button
                onClick={() => renderNow({ paneOrder: fmt, title: titleDraft })}
                disabled={rendering}
                className="w-full rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-accent-hover disabled:opacity-40"
              >
                {rendering ? (renderMsg ?? 'Rendering…') : 'Render with these settings'}
              </button>
            </div>
          )}

          {chosen && (
            <p className="mb-2 rounded-md bg-accent-soft px-2 py-1.5 text-[12px] font-semibold text-fg-1">
              {chosen}
            </p>
          )}
          <button onClick={suggest} disabled={busy}
            className="flex items-center gap-1.5 text-[11px] text-accent transition hover:underline disabled:opacity-50">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {busy ? 'Writing titles…' : chosen ? 'Suggest other titles' : 'Suggest titles'}
          </button>

          {titles && (
            <div className="mt-2 space-y-1.5">
              {titles.accepted.map((c) => (
                <button key={c.title} onClick={() => { choose(c.title); setTitleDraft(c.title); setMenuOpen(true); }}
                  className="block w-full rounded-md border border-line px-2 py-1.5 text-left text-[11px] leading-snug transition hover:border-accent">
                  <span className="font-medium text-fg-1">{c.title}</span>
                  <span className="mt-0.5 block text-fg-3">delivers: {c.mechanism}</span>
                </button>
              ))}
              {titles.rejected.length > 0 && (
                <details className="text-[10px] text-fg-3">
                  <summary className="cursor-pointer">{titles.rejected.length} rejected</summary>
                  {titles.rejected.map((c) => (
                    <div key={c.title} className="mt-1 leading-snug">
                      <span className="line-through">{c.title}</span>
                      {c.verification.results.filter((x: GateResult) => !x.passed).map((x: GateResult) => (
                        <span key={x.id} className="block text-error">{x.detail}</span>
                      ))}
                    </div>
                  ))}
                </details>
              )}
              {titles.accepted.length === 0 && titles.rejected.length === 0 && (
                <p className="text-[11px] text-fg-3">Couldn&apos;t write a title for this clip.</p>
              )}
            </div>
          )}
        </div>

        {gates.length > 0 && (
          <>
            <button onClick={() => setOpen((o) => !o)}
              className="mt-2.5 text-[11px] text-fg-3 underline-offset-2 transition hover:text-fg-2 hover:underline">
              {open ? 'Hide' : 'Why'}
            </button>
            {open && (
              <ul className="mt-2 space-y-1.5">
                {gates.map((g) => (
                  <li key={g.id} className="flex gap-2 text-[11px] leading-snug">
                    {g.passed
                      ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                      : <X className="mt-0.5 h-3 w-3 shrink-0 text-error" />}
                    <span className={g.passed ? 'text-fg-3' : 'text-fg-2'}>{g.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
