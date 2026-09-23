'use client';

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Pause as PauseIcon, Play, Redo2, Undo2, Upload } from 'lucide-react';
import type { Doc, EditorData, Selection, WordRow } from './types';
import { fmtTime, fmtTimeMs } from './types';
import { useEditorDoc } from './useEditorDoc';
import { usePreview } from './usePreview';
import { usePlayback, useTick } from './usePlayback';
import { blocks as blocksOf, deleteBlocks, cutWords, hideWords, splitAt } from './timelineModel';
import PreviewStage from './PreviewStage';
import Timeline from './Timeline';
import TranscriptPanel from './TranscriptPanel';
import Inspector from './Inspector';
import { Glass, IconBtn, Kbd, PrimaryBtn } from '../../components/ui';

/** Loads the clip, waits for its preview proxy, then hands off to the editor proper. */
export default function Editor({ clipId }: { clipId: string }) {
  const [data, setData] = useState<EditorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proxyMsg, setProxyMsg] = useState<string>('preparing preview…');

  const load = useCallback(async () => {
    const r = await fetch(`/api/editor/${clipId}`, { cache: 'no-store' });
    const body = await r.json();
    if (!r.ok) { setError(body.error || `load failed (${r.status})`); return null; }
    setData(body as EditorData);
    return body as EditorData;
  }, [clipId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!data || data.proxy.ready) return;
    const es = new EventSource(`/api/jobs/${data.proxy.jobId}/events`);
    es.addEventListener('progress', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      if (d.message) setProxyMsg(d.message);
    });
    es.addEventListener('end', () => { es.close(); load(); });
    return () => es.close();
  }, [data, load]);

  if (error) {
    return (
      <Shell title="Editor">
        <Glass className="m-auto max-w-md p-6 text-sm">
          <div className="font-medium text-error">Couldn&apos;t open this clip</div>
          <div className="mt-2 text-fg-2">{error}</div>
          <Link href="/" className="mt-4 inline-block text-accent hover:text-accent-hover">← Back to the dashboard</Link>
        </Glass>
      </Shell>
    );
  }
  if (!data) return <Shell title="Editor"><div className="m-auto text-sm text-fg-3">Loading…</div></Shell>;
  if (!data.proxy.ready) {
    return (
      <Shell title={data.source.title || 'Editor'}>
        <Glass className="m-auto flex flex-col items-center gap-3 px-10 py-8 text-sm text-fg-2">
          <div className="h-2 w-64 overflow-hidden rounded-full bg-white/10"><div className="pulsing h-full w-1/3 rounded-full bg-accent" /></div>
          <div>{proxyMsg}</div>
          <WorkerBanner worker={data.worker} />
        </Glass>
      </Shell>
    );
  }
  return (
    <Boundary>
      <EditorLoaded key={data.clip.id + data.proxy.origin} data={data} reload={load} />
    </Boundary>
  );
}

class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <Shell title="Editor">
        <Glass className="m-auto max-w-lg p-6 text-sm">
          <div className="font-medium text-error">The editor hit an error</div>
          <pre className="mt-2 whitespace-pre-wrap text-xs text-fg-2">{String(this.state.err.message)}</pre>
          <div className="mt-3 text-xs text-fg-3">Your edits autosave, so nothing is lost. Reload the page to continue.</div>
          <button onClick={() => location.reload()} className="pill pill-accent mt-4 px-4 py-1.5 text-xs font-medium">Reload</button>
        </Glass>
      </Shell>
    );
  }
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col text-fg-1">
      <div className="flex h-12 items-center gap-3 px-4 text-sm">
        <Link href="/" className="text-fg-3 hover:text-fg-1"><ArrowLeft className="h-4 w-4" /></Link>
        <span className="text-fg-2">{title}</span>
      </div>
      <div className="flex min-h-0 flex-1">{children}</div>
    </div>
  );
}

function WorkerBanner({ worker }: { worker: EditorData['worker'] }) {
  if (worker.alive && !worker.stale) return null;
  return (
    <div className={`glass-flat mx-2 mb-2 flex items-center gap-3 rounded-xl px-4 py-2 text-xs ${worker.alive ? 'text-warning' : 'text-error'}`}>
      {worker.alive
        ? <>The worker is running code older than the current build — restart it so exports match the preview: <code className="rounded bg-white/10 px-1.5 py-0.5">npm run worker</code></>
        : <>The worker isn&apos;t running — previews and exports will wait forever. Start it: <code className="rounded bg-white/10 px-1.5 py-0.5">npm run worker</code></>}
    </div>
  );
}

/** Words as the current document sees them: the server's window list plus the live edits. */
function applyDoc(words: WordRow[], doc: Doc): WordRow[] {
  return words.map((w) => {
    const o = doc.words[String(w.i)] || {};
    const start = o.start ?? w.start;
    const inRange = start >= doc.range.start - 0.05 && start < doc.range.end;
    const cut = inRange && doc.cuts.some((c) => start >= c.start && start < c.end);
    return { ...w, text: o.text ?? w.word, edited: o.text != null, start, end: o.end ?? w.end, hidden: !!o.hidden, inRange, cut };
  });
}

function EditorLoaded({ data, reload }: { data: EditorData; reload: () => Promise<EditorData | null> }) {
  const proxy = data.proxy as Extract<EditorData['proxy'], { ready: true }>;
  const { doc, set, undo, redo, replace, markSaved, endGesture, canUndo, canRedo, dirty, history } = useEditorDoc(data.doc);
  const { preview, pending, error: previewError } = usePreview(data.clip.id, doc, true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fps = preview?.fps ?? proxy.fps;
  const spans = useMemo(() => blocksOf(doc, fps).map((b) => ({ a: b.a, b: b.b, outStart: b.outStart })), [doc, fps]);
  const totalDuration = spans.length ? spans[spans.length - 1].outStart + (spans[spans.length - 1].b - spans[spans.length - 1].a) : 0;
  const playback = usePlayback({ videoRef, spans, duration: totalDuration, origin: proxy.origin });
  const words = useMemo(() => applyDoc(data.words, doc), [data.words, doc]);

  const [selection, setSelection] = useState<Selection>(null);
  // Defensive: a page loaded before the API grew `pauses` (or an older cached response) must not crash the timeline.
  const pauses = useMemo(() => (Array.isArray(data.pauses) ? data.pauses : []), [data.pauses]);
  const [maxPause, setMaxPause] = useState(0.35);

  // When re-composed formats are waiting on pane detection, follow that job and refresh.
  useEffect(() => {
    const jobId = preview?.geometry.panesPending;
    if (!jobId) return;
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    es.addEventListener('end', async () => { es.close(); await reload(); set((d) => ({ ...d })); });
    return () => es.close();
  }, [preview?.geometry.panesPending, reload, set]);

  // ── autosave ──
  const updatedAt = useRef<string | null>(data.clip.updatedAt);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error' | 'conflict'>('saved');
  const [conflict, setConflict] = useState<{ doc: Doc; updatedAt: string } | null>(null);
  const save = useCallback(async (d: Doc) => {
    setSaveState('saving');
    const r = await fetch(`/api/editor/${data.clip.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: d, baseUpdatedAt: updatedAt.current }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 409) { setConflict({ doc: body.doc, updatedAt: body.updatedAt }); setSaveState('conflict'); return false; }
    if (!r.ok) { setSaveState('error'); return false; }
    updatedAt.current = body.updatedAt;
    markSaved(d);
    setSaveState('saved');
    return true;
  }, [data.clip.id, markSaved]);
  useEffect(() => {
    if (!dirty || conflict) return;
    const t = setTimeout(() => { save(doc); }, 800);
    return () => clearTimeout(t);
  }, [doc, dirty, conflict, save]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // ── export ──
  const [exporting, setExporting] = useState<{ jobId: string; msg: string } | null>(data.activeRender ? { jobId: data.activeRender.id, msg: 'rendering…' } : null);
  const [renders, setRenders] = useState(data.renders);
  const [toast, setToast] = useState<string | null>(null);
  // Tighten pauses: the server measures, the document takes the cuts as one undoable step.
  const tighten = useCallback(async () => {
    const r = await fetch(`/api/editor/${data.clip.id}/tighten`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc, maxPause }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { setToast(body.error || 'could not measure pauses'); return; }
    if (body.removedSeconds > 0.05) {
      set((d) => ({ ...d, cuts: body.cuts }));
      setToast(`Removed ${body.removedSeconds.toFixed(1)} s of dead air · ${body.added} cut${body.added === 1 ? '' : 's'} added`);
    } else setToast(`No dead air longer than ${maxPause} s`);
  }, [data.clip.id, doc, maxPause, set]);
  const exportNow = useCallback(async () => {
    if (exporting) return;
    const ok = dirty ? await save(doc) : true;
    if (!ok) return;
    const r = await fetch(`/api/editor/${data.clip.id}/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc, baseUpdatedAt: updatedAt.current }),
    });
    const body = await r.json().catch(() => ({}));
    if (body.updatedAt) { updatedAt.current = body.updatedAt; markSaved(doc); }
    if (r.status === 409 && body.jobId) { setExporting({ jobId: body.jobId, msg: 'already rendering…' }); return; }
    if (!r.ok) { setToast(body.error || 'export failed'); return; }
    if (body.worker && !body.worker.alive) setToast('Queued — but the worker is not running, so nothing will render until it is.');
    setExporting({ jobId: body.jobId, msg: 'queued…' });
  }, [exporting, dirty, save, doc, data.clip.id, markSaved]);
  useEffect(() => {
    if (!exporting) return;
    const es = new EventSource(`/api/jobs/${exporting.jobId}/events`);
    es.addEventListener('progress', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setExporting((x) => (x ? { ...x, msg: `${d.stage}: ${d.message ?? ''}`.slice(0, 80) } : x));
    });
    es.addEventListener('end', async (e) => {
      es.close();
      const d = JSON.parse((e as MessageEvent).data);
      setExporting(null);
      const fresh = await reload();
      if (fresh) setRenders(fresh.renders);
      const newest = fresh?.renders?.[0];
      let verify: { passed?: boolean; detail?: string } | null = null;
      try { verify = newest?.verify_json ? JSON.parse(newest.verify_json) : null; } catch { verify = null; }
      if (d.status !== 'succeeded') setToast(`Render ${d.status}`);
      else if (verify && verify.passed === false) setToast(`Rendered — check it: ${verify.detail || 'the silence gate failed'}`);
      else setToast('Rendered ✓ — clean');
    });
    return () => es.close();
  }, [exporting?.jobId, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);

  // ── one delete rule for the timeline, the transcript and ⌫ ──
  // Clips: the footage goes (a cut). Words: the footage under them goes too — the transcript
  // and the Words track are two views of the same thing. H hides captions without cutting.
  const deleteSelection = useCallback(() => {
    if (selection?.kind === 'blocks' && selection.keys.length) {
      if (blocksOf(doc, fps).length <= 1) return false;
      set((d) => deleteBlocks(d, selection.keys, fps));
      setSelection(null);
      return true;
    }
    if (selection?.kind === 'words' && selection.is.length) {
      const is = new Set(selection.is);
      const sel = words.filter((w) => is.has(w.i) && !w.cut);
      if (sel.length) set((d) => cutWords(d, sel, pauses));
      setSelection(null);
      return true;
    }
    return false;
  }, [selection, words, set, doc, fps, pauses]);
  const hideSelection = useCallback(() => {
    if (selection?.kind !== 'words' || !selection.is.length) return false;
    set((d) => hideWords(d, selection.is, true));
    setSelection(null);
    return true;
  }, [selection, set]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(doc); return; }
      if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); exportNow(); return; }
      if (e.key === ' ') { e.preventDefault(); playback.toggle(); return; }
      if (e.key === 's' || e.key === 'S') { set((d) => splitAt(d, playback.getTime(), fps)); return; }
      if (e.key === 'k' || e.key === 'K') { playback.pause(); return; }
      if (e.key === 'l' || e.key === 'L') { playback.play(); return; }
      if (e.key === 'j' || e.key === 'J') { playback.stepFrames(-fps, fps); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); playback.stepFrames(e.shiftKey ? -10 : -1, fps); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); playback.stepFrames(e.shiftKey ? 10 : 1, fps); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { if (deleteSelection()) e.preventDefault(); return; }
      if (e.key === 'h' || e.key === 'H') { hideSelection(); return; }
      if (e.key === 'Escape') { setSelection(null); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, save, doc, exportNow, playback, fps, deleteSelection, hideSelection, set]);

  useEffect(() => {
    (window as unknown as { __editorDebug: unknown }).__editorDebug = {
      getTime: playback.getTime, doc: () => doc, preview: () => preview, spans: () => spans, history, selection: () => selection,
    };
  }, [playback, doc, preview, history, spans, selection]);

  const outsideWindow = doc.range.start < data.window.start + 0.01 || doc.range.end > data.window.end - 0.01;
  const latest = renders[0];
  const idx = data.siblings.findIndex((s) => s.id === data.clip.id);
  const prev = idx > 0 ? data.siblings[idx - 1] : null;
  const next = idx >= 0 && idx < data.siblings.length - 1 ? data.siblings[idx + 1] : null;
  const focusTitleText = () => { const el = document.getElementById('title-text') as HTMLTextAreaElement | null; el?.focus(); el?.select(); };

  return (
    <div className="flex h-screen flex-col gap-2 p-2 text-fg-1">
      {/* Header */}
      <Glass className="flex h-12 shrink-0 items-center gap-2 px-3 text-sm">
        <Link href="/" className="pill grid h-8 w-8 place-items-center text-fg-3 hover:text-fg-1" title="Back to dashboard"><ArrowLeft className="h-4 w-4" /></Link>
        <div className="hidden min-w-0 max-w-[26ch] truncate text-fg-2 md:block">{data.source.title || 'Source'}</div>
        <span className="text-fg-3">›</span>
        <span className="tabular font-medium">{fmtTime(data.clip.start_s)}</span>
        {data.clip.verdict && data.clip.verdict !== 'cut' && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${data.clip.verdict === 'ship' ? 'bg-accent text-white' : 'bg-warning/20 text-warning'}`}>
            {data.clip.verdict.toUpperCase()}{data.clip.corpus_score != null ? ` ${data.clip.corpus_score}/10` : ''}
          </span>
        )}
        <div className="ml-1 flex items-center gap-0.5">
          {prev ? <Link href={`/clips/${prev.id}`} className="pill grid h-8 w-8 place-items-center text-fg-3 hover:text-fg-1" title="Previous clip"><ChevronLeft className="h-4 w-4" /></Link> : <span className="grid h-8 w-8 place-items-center opacity-25"><ChevronLeft className="h-4 w-4" /></span>}
          {next ? <Link href={`/clips/${next.id}`} className="pill grid h-8 w-8 place-items-center text-fg-3 hover:text-fg-1" title="Next clip"><ChevronRight className="h-4 w-4" /></Link> : <span className="grid h-8 w-8 place-items-center opacity-25"><ChevronRight className="h-4 w-4" /></span>}
        </div>
        <div className="flex-1" />
        <span className={`text-xs ${saveState === 'saved' && !dirty ? 'text-fg-3' : saveState === 'error' || saveState === 'conflict' ? 'text-error' : 'text-fg-2'}`}>
          {saveState === 'conflict' ? 'Changed elsewhere' : saveState === 'error' ? 'Save failed — retrying' : dirty || saveState === 'saving' ? 'Saving…' : 'Saved'}
        </span>
        <IconBtn onClick={undo} disabled={!canUndo} title="Undo (⌘Z)"><Undo2 className="h-4 w-4" /></IconBtn>
        <IconBtn onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)"><Redo2 className="h-4 w-4" /></IconBtn>
        {latest && !exporting && (
          <a href={`/api/media?render=${latest.id}`} download className="pill inline-flex h-8 items-center gap-1.5 px-3 text-xs text-fg-2 hover:text-fg-1" title={`Rendered ${latest.created_at}`}>
            <Download className="h-3.5 w-3.5" /> Download
          </a>
        )}
        <PrimaryBtn onClick={exportNow} disabled={!!exporting || !!preview?.empty} title={preview?.empty ? 'Nothing left to render' : 'Export (⌘E)'}>
          <Upload className="h-3.5 w-3.5" /> {exporting ? exporting.msg : 'Export'}
        </PrimaryBtn>
      </Glass>
      <WorkerBanner worker={data.worker} />
      {outsideWindow && (
        <div className="glass-flat mx-1 flex items-center gap-3 rounded-xl px-4 py-1.5 text-xs text-fg-2">
          The clip now reaches the edge of the preview footage.
          <button onClick={async () => { if (await save(doc)) await reload(); }} className="text-accent hover:text-accent-hover">Extend preview</button>
        </div>
      )}
      {previewError && <div className="glass-flat mx-1 rounded-xl px-4 py-1.5 text-xs text-error">Preview: {previewError}</div>}

      {/* Body */}
      <div className="grid min-h-0 flex-1 gap-2" style={{ gridTemplateColumns: 'minmax(220px, 340px) minmax(0, 1fr) minmax(220px, 300px)' }}>
        <Glass className="min-h-0 overflow-hidden">
          <TranscriptPanel doc={doc} words={words} spans={spans} playback={playback} setDoc={set}
            selection={selection} setSelection={setSelection} cutSelection={() => { deleteSelection(); }} />
        </Glass>
        <div className="flex min-h-0 flex-col gap-2">
          <div className="relative min-h-0 flex-1">
            <PreviewStage clipId={data.clip.id} doc={doc} preview={preview} fonts={data.fonts}
              videoRef={videoRef} playback={playback} setDoc={set} endGesture={endGesture}
              selection={selection} setSelection={setSelection} pending={pending} onEditTitleText={focusTitleText} />
          </div>
          <Transport playback={playback} duration={totalDuration} />
        </div>
        <Glass className="min-h-0 overflow-hidden">
          <Inspector clipId={data.clip.id} doc={doc} fonts={data.fonts} formats={data.formats} composition={data.composition}
            selection={selection} setDoc={set} endGesture={endGesture} />
        </Glass>
      </div>

      {/* Timeline */}
      <Glass className="h-[clamp(190px,29vh,262px)] shrink-0 overflow-hidden">
        <Timeline clipId={data.clip.id} doc={doc} preview={preview} words={words} window={data.window} fps={fps}
          proxy={{ origin: proxy.origin, duration: proxy.duration, filmstrip: proxy.filmstrip }}
          playback={playback} setDoc={set} endGesture={endGesture} selection={selection} setSelection={setSelection} onDelete={() => { deleteSelection(); }}
          pauses={pauses} maxPause={maxPause} setMaxPause={setMaxPause} onTighten={tighten} />
      </Glass>

      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <Glass strong className="w-[420px] p-5 text-sm">
            <div className="font-medium">This clip was changed in another tab</div>
            <div className="mt-2 text-fg-2">Reload their version, or overwrite it with yours.</div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => { replace(conflict.doc); updatedAt.current = conflict.updatedAt; setConflict(null); setSaveState('saved'); }} className="pill px-3 py-1.5">Reload theirs</button>
              <button onClick={async () => { updatedAt.current = conflict.updatedAt; setConflict(null); await save(doc); }} className="pill pill-accent px-3 py-1.5">Overwrite</button>
            </div>
          </Glass>
        </div>
      )}
      {toast && <div className="glass-strong rise fixed bottom-[calc(clamp(190px,29vh,262px)+28px)] left-1/2 z-40 -translate-x-1/2 rounded-full px-4 py-2 text-xs text-fg-1">{toast}</div>}
    </div>
  );
}

function Transport({ playback, duration }: { playback: ReturnType<typeof usePlayback>; duration: number }) {
  const t = useTick(playback);
  return (
    <Glass className="flex h-11 shrink-0 items-center gap-3 px-3 text-xs text-fg-2">
      <button onClick={playback.toggle} className="pill pill-accent grid h-8 w-8 place-items-center" title="Play/pause (Space)">
        {playback.playing ? <PauseIcon className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
      <span className="tabular text-[13px] text-fg-1">{fmtTimeMs(t)}</span>
      <span className="tabular text-fg-3">/ {fmtTimeMs(duration)}</span>
      <span className="ml-auto hidden items-center gap-2 text-fg-3 lg:flex">
        <Kbd>Space</Kbd> play <Kbd>S</Kbd> split <Kbd>⌫</Kbd> delete <Kbd>H</Kbd> hide captions <Kbd>←</Kbd><Kbd>→</Kbd> frame <Kbd>⌘Z</Kbd> undo <Kbd>⌘E</Kbd> export
      </span>
    </Glass>
  );
}
