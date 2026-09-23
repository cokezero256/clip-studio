'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, Loader2, Square, ChevronDown } from 'lucide-react';

type Ev = { id: number; stage: string | null; message: string | null; progress: number | null; level: string };

const STAGES = ['ingest', 'transcribe', 'select', 'plan', 'compose', 'render', 'verify', 'done'];

export default function Ingest({ onFinished }: { onFinished: () => void }) {
  const [input, setInput] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState<string>('idle');
  const [showOpts, setShowOpts] = useState(false);
  const [format, setFormat] = useState('vertical');
  const [layout, setLayout] = useState('auto');
  const [paneOrder, setPaneOrder] = useState('screen-top');
  const [maxRender, setMaxRender] = useState(3);
  const logRef = useRef<HTMLDivElement>(null);

  const start = useCallback(async () => {
    if (!input.trim()) return;
    setEvents([]);
    setStatus('queued');
    const res = await fetch('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: input.trim(), format, layout, paneOrder, maxRender }),
    });
    const { jobId } = await res.json();
    setJobId(jobId);
  }, [input, format, layout, maxRender]);

  // Tail the durable event log. Reconnecting replays anything missed.
  useEffect(() => {
    if (!jobId) return;
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    es.addEventListener('progress', (e) => {
      setEvents((prev) => [...prev, JSON.parse((e as MessageEvent).data)]);
    });
    es.addEventListener('job', (e) => setStatus(JSON.parse((e as MessageEvent).data).status));
    es.addEventListener('end', () => { es.close(); setJobId(null); onFinished(); });
    return () => es.close();
  }, [jobId, onFinished]);

  useEffect(() => { logRef.current?.scrollTo({ top: 1e9 }); }, [events]);

  const running = status === 'running' || status === 'queued';
  const current = events.length ? events[events.length - 1] : null;
  const stageIdx = current?.stage ? STAGES.indexOf(current.stage) : -1;
  const pct = current?.progress != null ? current.progress * 100
    : stageIdx >= 0 ? ((stageIdx + 1) / STAGES.length) * 100 : 0;

  return (
    <section className="rounded-2xl border border-line bg-bg-2 p-5">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-3" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !running) start(); }}
            placeholder="Paste a livestream, YouTube or Instagram link — or a file path"
            disabled={running}
            className="w-full rounded-xl border border-line bg-bg-3 py-3 pl-10 pr-4 text-[15px] outline-none transition placeholder:text-fg-3 focus:border-accent disabled:opacity-50"
          />
        </div>
        {running ? (
          <button
            onClick={() => jobId && fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' })}
            className="flex items-center gap-2 rounded-xl border border-line bg-bg-3 px-4 py-3 text-sm font-medium transition hover:border-error hover:text-error"
          >
            <Square className="h-3.5 w-3.5" /> Cancel
          </button>
        ) : (
          <button
            onClick={start}
            disabled={!input.trim()}
            className="rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-35"
          >
            Make clips
          </button>
        )}
      </div>

      <button
        onClick={() => setShowOpts((s) => !s)}
        className="mt-3 flex items-center gap-1.5 text-xs text-fg-3 transition hover:text-fg-2"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition ${showOpts ? 'rotate-180' : ''}`} /> Options
      </button>
      {showOpts && (
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-3">Framing</span>
            <select value={layout} onChange={(e) => setLayout(e.target.value)}
              className="rounded-lg border border-line bg-bg-3 px-3 py-2 outline-none focus:border-accent">
              <option value="auto">Auto re-compose</option>
              <option value="single">Letterbox whole frame</option>
            </select>
          </label>
          {/* Camera position within 9:16. Both stacked orders exist in the references —
              rp.profits runs chart-over-trader, pjtradesnq runs trader-over-chart. */}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-3">Camera position</span>
            <select value={paneOrder} onChange={(e) => setPaneOrder(e.target.value)}
              disabled={layout !== 'auto'}
              className="rounded-lg border border-line bg-bg-3 px-3 py-2 outline-none focus:border-accent disabled:opacity-40">
              <option value="screen-top">Chart on top, trader below</option>
              <option value="camera-top">Trader on top, chart below</option>
              <option value="screen-big">Big chart, small trader</option>
              <option value="camera-big">Big trader, small chart</option>
              <option value="screen-full-pip-br">Full chart + trader inset (right)</option>
              <option value="screen-full-pip-bl">Full chart + trader inset (left)</option>
              <option value="screen-only">Chart only</option>
              <option value="camera-only">Trader only</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-3">Format</span>
            <select value={format} onChange={(e) => setFormat(e.target.value)}
              className="rounded-lg border border-line bg-bg-3 px-3 py-2 outline-none focus:border-accent">
              <option value="vertical">9:16 vertical</option>
              <option value="horizontal">16:9 horizontal</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-3">Clips to render</span>
            <input type="number" min={1} max={10} value={maxRender}
              onChange={(e) => setMaxRender(Number(e.target.value))}
              className="rounded-lg border border-line bg-bg-3 px-3 py-2 outline-none focus:border-accent" />
          </label>
        </div>
      )}

      {(running || events.length > 0) && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="flex items-center gap-2 font-medium">
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />}
              <span className={running ? 'text-fg-1' : 'text-fg-2'}>
                {current?.stage ?? 'starting'}
              </span>
              <span className="text-fg-3">{current?.message}</span>
            </span>
            <span className="text-fg-3">{Math.round(pct)}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-bg-4">
            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <div ref={logRef} className="mt-3 max-h-36 overflow-y-auto rounded-lg bg-bg-1/60 p-3 font-mono text-[11px] leading-relaxed">
            {events.map((e) => (
              <div key={e.id} className={e.level === 'error' ? 'text-error' : 'text-fg-3'}>
                <span className="text-fg-2">{e.stage}</span> {e.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
