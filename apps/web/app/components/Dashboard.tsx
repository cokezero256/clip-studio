'use client';

import { useCallback, useEffect, useState } from 'react';
import Ingest from './Ingest';
import ClipCard, { type ClipRow } from './ClipCard';
import Processing, { type JobRow } from './Processing';
import { Film, Inbox, Trash2, TrendingUp } from 'lucide-react';
import Link from 'next/link';

type Source = {
  id: string; input: string; title: string | null; uploader: string | null;
  duration_s: number | null; status: string; clip_count: number; ready_count: number;
};

export default function Dashboard() {
  const [sources, setSources] = useState<Source[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [worker, setWorker] = useState<{ alive: boolean; stale: boolean; missing: Array<{ tool: string; hint: string | null; what: string | null }> } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [clips, setClips] = useState<ClipRow[]>([]);
  const [showRejects, setShowRejects] = useState(false);
  // Deleting a stream: the trash icon arms a confirm inside the card; a second click deletes.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch('/api/sources').then((x) => x.json());
    setSources(r.sources);
    setJobs(r.jobs ?? []);
    setWorker(r.worker ?? null);
    if (!selected && r.sources.length) setSelected(r.sources[0].id);
  }, [selected]);

  useEffect(() => { refresh(); }, [refresh]);

  // While a stream is processing or being deleted, keep the list current.
  const busy = sources.some((s) => s.status === 'processing' || s.status === 'deleting');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [busy, refresh]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); }, [notice]);

  const removeSource = useCallback(async (s: Source) => {
    setDeleting(s.id);
    setConfirmDelete(null);
    try {
      const r = await fetch(`/api/sources/${s.id}`, { method: 'DELETE' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 202) { setNotice(body.error || 'could not delete'); return; }
      if (body.deleting) setNotice(body.message);
      else setNotice(`Deleted “${body.title}” — ${body.clips} clip${body.clips === 1 ? '' : 's'}, ${(body.bytes / 1e9).toFixed(2)} GB freed`);
      if (selected === s.id) setSelected(null);
      await refresh();
    } finally { setDeleting(null); }
  }, [selected, refresh]);

  useEffect(() => {
    if (!selected) return;
    fetch(`/api/clips/${selected}`).then((x) => x.json()).then((r) => setClips(r.clips ?? []));
  }, [selected, sources]);

  const active = sources.find((s) => s.id === selected);
  const jobFor = (sourceId: string) => jobs.find((j) => j.source_id === sourceId && j.type === 'process' && (j.status === 'running' || j.status === 'queued'));
  const activeJob = active ? jobFor(active.id) : undefined;

  const reloadClips = useCallback(() => {
    if (!selected) return;
    fetch(`/api/clips/${selected}`).then((x) => x.json()).then((r) => setClips(r.clips ?? []));
  }, [selected]);

  /**
   * THE PICKS ARE THE PRODUCT. Everything else is evidence.
   *
   * The list used to render all 43 candidates as identical cards. A real run on a 71-minute
   * stream produced 4 picks and 39 rejects, so the first thing on screen was a wall of
   * moments the pipeline had already decided against — mic checks, 12-second fragments,
   * an empty "Why" — each with a "Render anyway" button. The selection was working and the
   * page was hiding it. Rejects are kept, because a silent drop teaches an editor nothing,
   * but they go behind a disclosure and never compete with the picks.
   */
  const VERDICT_ORDER: Record<string, number> = { ship: 0, maybe: 1 };
  const picks = clips
    .filter((c) => c.ready && c.verdict !== 'cut')
    .sort((a, b) => {
      const av = VERDICT_ORDER[a.verdict ?? ''] ?? 2;
      const bv = VERDICT_ORDER[b.verdict ?? ''] ?? 2;
      if (av !== bv) return av - bv;
      if ((b.corpus_score ?? 0) !== (a.corpus_score ?? 0)) {
        return (b.corpus_score ?? 0) - (a.corpus_score ?? 0);
      }
      return (a.rank ?? 0) - (b.rank ?? 0);
    });
  const rejects = clips
    .filter((c) => !(c.ready && c.verdict !== 'cut'))
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <header className="mb-7 flex items-baseline justify-between">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">
            Clip <span className="text-accent">Studio</span>
          </h1>
          <p className="mt-0.5 text-sm text-fg-3">
            Link in, client-ready clips out. Every clip is silence-checked against the rendered file.
          </p>
        </div>
        <Link href="/outliers"
          className="flex items-center gap-2 rounded-xl border border-line bg-bg-2 px-4 py-2.5 text-sm font-medium transition hover:border-accent">
          <TrendingUp className="h-4 w-4 text-accent" /> Outlier gallery
        </Link>
      </header>

      <Ingest onFinished={refresh} />

      {/* This machine's setup problems, said plainly: a fresh clone showed "spawn yt-dlp ENOENT"
          five times and nothing else. The worker probes its tools at start and reports here. */}
      {worker && (!worker.alive || worker.missing.length > 0) && (
        <div className="mt-6 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] text-fg-1">
          {!worker.alive ? (
            <div>The worker isn&apos;t running on this machine — nothing will download, transcribe or render until it is. Start it in a terminal: <code className="rounded bg-white/10 px-1.5 py-0.5">npm run worker</code></div>
          ) : (
            <ul className="space-y-1">
              {worker.missing.map((m) => (
                <li key={m.tool}>
                  <span className="font-medium">{m.tool === 'ytdlp' ? 'yt-dlp' : m.tool === 'whisper' ? 'whisper-cli' : m.tool === 'model' ? 'whisper model' : m.tool === 'titlePlate' ? 'title renderer' : m.tool}</span>
                  {' '}is missing on this machine{m.what ? ` — ${m.what}` : ''}.
                  {m.hint && <> Install: <code className="rounded bg-white/10 px-1.5 py-0.5">{m.hint}</code>, then restart the worker.</>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-7 md:grid-cols-[260px_1fr]">
        {/* Sticky: scrolling a long clip list used to carry the source list off-screen,
            which read as "there is only one page". */}
        <aside className="sticky top-6 self-start max-h-[calc(100vh-3rem)] overflow-y-auto">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-3">Sources</h2>
          {notice && <div className="mb-2 rounded-lg border border-line bg-bg-2 px-3 py-2 text-[11px] text-fg-2">{notice}</div>}
          {sources.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line p-6 text-center text-xs text-fg-3">
              <Inbox className="mx-auto mb-2 h-5 w-5" />
              Nothing yet — paste a link above.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {sources.map((s) => (
                <li key={s.id} className={`group relative ${s.status === 'deleting' || deleting === s.id ? 'opacity-50' : ''}`}>
                  <button
                    onClick={() => setSelected(s.id)}
                    disabled={s.status === 'deleting'}
                    className={`w-full rounded-lg border px-3 py-2.5 pr-9 text-left transition ${
                      selected === s.id
                        ? 'border-accent/40 bg-accent-soft'
                        : 'border-line bg-bg-2 hover:border-bg-4'}`}
                  >
                    <div className="truncate text-[13px] font-medium">
                      {s.title || s.input}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-3">
                      <span className={
                        s.status === 'ready' ? 'text-success'
                        : s.status === 'failed' ? 'text-error'
                        : s.status === 'processing' || s.status === 'deleting' ? 'text-accent pulsing' : ''}>
                        {s.status === 'deleting' ? 'deleting…' : s.status}
                      </span>
                      {s.status === 'processing' && jobFor(s.id)?.started_at && (
                        <span>· {Math.max(0, Math.round((Date.now() - new Date(jobFor(s.id)!.started_at!).getTime()) / 60000))} min</span>
                      )}
                      {s.clip_count > 0 && <span>· {s.ready_count}/{s.clip_count} ready</span>}
                    </div>
                  </button>
                  {/* Delete: shows on hover (always on the selected card); the confirm sits inside the card. */}
                  {s.status !== 'deleting' && confirmDelete !== s.id && (
                    <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(s.id); }} title="Delete this stream and its clips"
                      className={`absolute right-2 top-2 rounded-md p-1.5 text-fg-3 transition hover:bg-error/15 hover:text-error ${selected === s.id ? 'opacity-70' : 'opacity-0 group-hover:opacity-70 focus:opacity-100'}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {confirmDelete === s.id && (
                    <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-[11px]">
                      <span className="text-fg-2">
                        Delete this stream{s.clip_count > 0 ? `, its ${s.clip_count} clips` : ''} and its files{s.status === 'processing' ? ' (stops processing)' : ''}?
                      </span>
                      <span className="flex shrink-0 gap-1">
                        <button onClick={() => setConfirmDelete(null)} className="rounded-md px-2 py-1 text-fg-3 hover:bg-white/10">Keep</button>
                        <button onClick={() => removeSource(s)} disabled={deleting === s.id} className="rounded-md bg-error px-2 py-1 font-medium text-white hover:bg-error/80 disabled:opacity-50">Delete</button>
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>

        <main>
          {active && (
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="flex items-center gap-2 text-sm font-medium">
                <Film className="h-4 w-4 text-fg-3" />
                {active.title || active.input}
              </h2>
              <span className="text-xs text-fg-3">
                {picks.length} {picks.length === 1 ? 'pick' : 'picks'} from {clips.length} candidates
              </span>
            </div>
          )}
          {/* When the ranker cut everything, say so — a wall of empty cards explains nothing. */}
          {clips.length > 0 && picks.length === 0 && clips.every((c) => !c.render_id) && (
            <div className="mb-4 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-[13px] text-fg-2">
              Nothing rendered from this source.{' '}
              {clips.some((c) => c.verdict === 'cut')
                ? 'Every candidate scored below the bar against the outlier corpus — this recording may simply not contain a strong moment.'
                : 'These clips passed the technical gates but were never ranked.'}{' '}
              <span className="text-fg-3">Use “Render anyway” on any clip to produce it regardless.</span>
            </div>
          )}

          {active && activeJob && (
            <div className="mb-4"><Processing key={activeJob.id} job={activeJob} onDone={refresh} /></div>
          )}
          {clips.length === 0 ? (
            !activeJob && (
              <div className="rounded-xl border border-dashed border-line py-20 text-center text-sm text-fg-3">
                No clips for this source yet.
              </div>
            )
          ) : (
            <>
              {picks.length > 0 ? (
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
                  {picks.map((c) => (
                    <ClipCard key={c.id} clip={c} onRendered={reloadClips} />
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-line py-16 text-center text-sm text-fg-3">
                  Nothing from this recording cleared the bar.
                  <div className="mt-1 text-xs">
                    Open the rejected clips below to see why each one was dropped.
                  </div>
                </div>
              )}

              {rejects.length > 0 && (
                <div className="mt-8">
                  <button
                    onClick={() => setShowRejects((v) => !v)}
                    className="flex w-full items-center justify-between rounded-lg border border-line px-4 py-3 text-left text-[13px] text-fg-2 transition-colors hover:bg-bg-2"
                  >
                    <span>
                      <span className="font-medium">{rejects.length} rejected</span>
                      <span className="text-fg-3">
                        {' '}· {rejects.filter((c) => !c.ready).length} failed a gate
                        {' '}· {rejects.filter((c) => c.ready && c.verdict === 'cut').length} cut on content
                      </span>
                    </span>
                    <span className="text-fg-3">{showRejects ? 'Hide' : 'Show'}</span>
                  </button>
                  {showRejects && (
                    <div className="mt-4 grid grid-cols-2 gap-4 opacity-60 lg:grid-cols-3 xl:grid-cols-4">
                      {rejects.map((c) => (
                        <ClipCard key={c.id} clip={c} onRendered={reloadClips} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
