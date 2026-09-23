'use client';

import { useEffect, useState } from 'react';
import { Loader2, Square } from 'lucide-react';

type Ev = { id: number; stage: string | null; message: string | null; progress: number | null; level: string; ts: string };
export type JobRow = {
  id: string; type: string; status: string; source_id: string | null; stage: string | null;
  message: string | null; progress: number | null; started_at: string | null; created_at: string;
};

const STAGES = ['ingest', 'transcribe', 'select', 'plan', 'rank', 'compose', 'render', 'verify', 'done'];
const LABEL: Record<string, string> = {
  ingest: 'Downloading', transcribe: 'Transcribing', select: 'Finding moments', plan: 'Planning cuts',
  rank: 'Ranking against the corpus', compose: 'Framing', render: 'Rendering', verify: 'Checking the render', done: 'Done',
};

const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

/**
 * What a stream is doing right now, for anyone looking at the dashboard — not only the tab
 * that pasted the link. A two-hour stream takes ~10 minutes (most of it whisper); with only
 * a "processing" label and an empty clip list that read as "stuck". This tails the job's
 * durable event log and shows the stage, the live message, a bar and the elapsed time.
 */
export default function Processing({ job, onDone }: { job: JobRow; onDone: () => void }) {
  const [last, setLast] = useState<Ev | null>(null);
  const [status, setStatus] = useState(job.status);
  const [, tick] = useState(0);

  useEffect(() => {
    const es = new EventSource(`/api/jobs/${job.id}/events`);
    es.addEventListener('progress', (e) => setLast(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('job', (e) => setStatus(JSON.parse((e as MessageEvent).data).status));
    es.addEventListener('end', () => { es.close(); onDone(); });
    return () => es.close();
  }, [job.id, onDone]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const stage = last?.stage || job.stage || (status === 'queued' ? 'queued' : 'ingest');
  const stageIdx = STAGES.indexOf(stage);
  const pct = last?.progress != null ? last.progress * 100
    : job.progress != null ? job.progress * 100
      : stageIdx >= 0 ? ((stageIdx + 0.5) / STAGES.length) * 100 : 3;
  const startedAt = job.started_at ? new Date(job.started_at).getTime() : new Date(job.created_at + 'Z').getTime();
  const elapsed = Date.now() - startedAt;
  const message = last?.message || job.message || (status === 'queued' ? 'waiting for the worker' : '');

  return (
    <div className="rounded-xl border border-accent/30 bg-accent-soft/40 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          {LABEL[stage] || (status === 'queued' ? 'Queued' : 'Processing')}
          <span className="text-fg-3">· {fmtElapsed(elapsed)}</span>
        </div>
        <button onClick={() => fetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' })}
          className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-fg-2 transition hover:border-error hover:text-error">
          <Square className="h-3 w-3" /> Cancel
        </button>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-fg-3">
        <span className="truncate">{message}</span>
        <span className="shrink-0 tabular">{Math.round(pct)}%</span>
      </div>
      <ol className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {STAGES.filter((s) => s !== 'done').map((s, i) => (
          <li key={s} className={i < stageIdx ? 'text-success' : i === stageIdx ? 'text-fg-1' : 'text-fg-3/50'}>
            {i < stageIdx ? '✓ ' : ''}{LABEL[s]}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[11px] text-fg-3">
        A stream takes about a minute per 15 minutes of footage, most of it transcription, plus a minute or two to rank and render the picks.
      </p>
    </div>
  );
}
