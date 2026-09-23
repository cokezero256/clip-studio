'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import OutlierCard, { type Outlier, type Tag } from './OutlierCard';
import { RefreshCw, X, ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react';

type Page = { id: string; username: string; is_client: number; post_count: number; outlier_count: number };

const LAYOUT_LABELS: Record<string, string> = {
  split: 'Split screen',
  pip: 'Chart + webcam inset',
  fullscreen_chart: 'Chart only',
  fullscreen_cam: 'Camera only',
  other: 'Other',
};

const FORMAT_LABELS: Record<string, string> = {
  screenshare_teach: 'Teaching over a chart',
  screenshare_recap: 'Trade recap',
  talking_head: 'Talking head',
  talking_head_broll: 'Talking head + b-roll',
  lifestyle: 'Lifestyle',
  meme_repost: 'Meme / repost',
  podcast_clip: 'Podcast clip',
  promo: 'Promo',
  other: 'Other',
};

export default function OutlierGallery() {
  const [rows, setRows] = useState<Outlier[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobMsg, setJobMsg] = useState('');
  const [selected, setSelected] = useState<Outlier | null>(null);

  const [page, setPage] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [layout, setLayout] = useState<string | null>(null);
  const [minZ, setMinZ] = useState(-1);
  const [layouts, setLayouts] = useState<{ layout: string; n: number }[]>([]);
  const [tag, setTag] = useState<string | null>(null);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [manageTags, setManageTags] = useState(false);
  const [handle, setHandle] = useState('');
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (showAll) q.set('all', '1');
    if (page) q.set('page', page);
    if (layout) q.set('layout', layout);
    if (tag) q.set('tag', tag);
    q.set('minZ', String(minZ));
    const r = await fetch(`/api/outliers?${q}`).then((x) => x.json());
    setRows(r.outliers ?? []);
    setPages(r.pages ?? []);
    setLayouts(r.layouts ?? []);
    setAllTags(r.allTags ?? []);
    setLoading(false);
  }, [page, showAll, minZ, layout, tag]);

  /** Add a trading account and scrape it right away. */
  const addAccount = async () => {
    if (!handle.trim()) return;
    setAdding(true); setAddMsg(null);
    const r = await fetch('/api/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: handle }) }).then((x) => x.json());
    setAdding(false);
    if (r.error) { setAddMsg(r.error); return; }
    setHandle('');
    setAddMsg(`@${r.page.username} added — scraping the last 60 days`);
    setRefreshing(true);
    setJobId(r.jobId);
  };

  const setPostTags = async (shortcode: string, tagIds: string[]) => {
    setRows((prev) => prev.map((r) => (r.shortcode === shortcode ? { ...r, tags: tagIds } : r)));
    await fetch(`/api/outliers/${shortcode}/tags`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tagIds }) });
    const t = await fetch('/api/tags').then((x) => x.json());
    setAllTags(t.tags ?? []);
  };
  const renameTag = async (id: string, name: string) => {
    await fetch(`/api/tags/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    load();
  };
  const recolourTag = async (id: string, color: string) => {
    await fetch(`/api/tags/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color }) });
    load();
  };
  const removeTag = async (id: string) => {
    if (!confirm('Delete this tag from every reel?')) return;
    await fetch(`/api/tags/${id}`, { method: 'DELETE' });
    if (tag === id) setTag(null);
    load();
  };

  useEffect(() => { load(); }, [load]);

  // Tail the refresh job so the corpus build shows progress like any other job.
  useEffect(() => {
    if (!jobId) return;
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    es.addEventListener('progress', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setJobMsg(`${d.stage}: ${d.message ?? ''}`);
    });
    es.addEventListener('end', () => { es.close(); setJobId(null); setRefreshing(false); setJobMsg(''); load(); });
    return () => es.close();
  }, [jobId, load]);

  const refresh = async () => {
    setRefreshing(true);
    const { jobId } = await fetch('/api/outliers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 60, maxDownloads: 8 }),
    }).then((x) => x.json());
    setJobId(jobId);
  };

  const byFormat = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const f = r.format_label || r.format || 'unclassified';
      m.set(f, (m.get(f) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  return (
    <div className="mx-auto max-w-[1500px] px-6 py-8">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <Link href="/" className="mb-1 inline-flex items-center gap-1.5 text-xs text-fg-3 transition hover:text-fg-2">
            <ArrowLeft className="h-3 w-3" /> Clip Studio
          </Link>
          <h1 className="text-[26px] font-semibold tracking-tight">
            Outlier <span className="text-accent">gallery</span>
          </h1>
          <p className="mt-0.5 text-sm text-fg-3">
            What&apos;s actually working on the trading pages right now. Titles are read off the
            video — the Instagram captions carry nothing.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <form onSubmit={(e) => { e.preventDefault(); addAccount(); }} className="flex items-center gap-1.5 rounded-xl border border-line bg-bg-2 px-3 py-1.5">
              <Plus className="h-3.5 w-3.5 text-fg-3" />
              <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="Add a trading account (@handle or URL)"
                className="w-64 bg-transparent text-sm outline-none placeholder:text-fg-3" />
              <button type="submit" disabled={adding || !handle.trim()} className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40">
                {adding ? 'Adding…' : 'Add'}
              </button>
            </form>
            <button
              onClick={refresh}
              disabled={refreshing}
              className="flex items-center gap-2 rounded-xl border border-line bg-bg-2 px-4 py-2.5 text-sm font-medium transition hover:border-accent disabled:opacity-50"
            >
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {refreshing ? 'Refreshing…' : 'Refresh corpus'}
            </button>
          </div>
          {addMsg && <div className="text-xs text-fg-3">{addMsg}</div>}
        </div>
      </header>

      {jobMsg && (
        <div className="mb-4 rounded-lg border border-line bg-bg-2 px-4 py-2.5 font-mono text-[11px] text-fg-2">
          {jobMsg}
        </div>
      )}

      <div className="grid grid-cols-[210px_1fr] gap-7">
        <aside className="space-y-6 text-sm">
          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-3">Pages</h2>
            <ul className="space-y-0.5">
              <li>
                <button onClick={() => setPage(null)}
                  className={`w-full rounded-md px-2 py-1.5 text-left text-[13px] transition ${!page ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-bg-2'}`}>
                  All pages
                </button>
              </li>
              {pages.map((p) => (
                <li key={p.id}>
                  <button onClick={() => setPage(p.username === page ? null : p.username)}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] transition ${page === p.username ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-bg-2'}`}>
                    <span className="truncate">@{p.username}{p.is_client ? ' ★' : ''}</span>
                    <span className="text-[11px] text-fg-3">{p.post_count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-3">
              Above typical
            </h2>
            <input type="range" min={-1} max={3} step={0.1} value={minZ}
              onChange={(e) => setMinZ(Number(e.target.value))}
              className="w-full accent-[var(--accent)]" />
            <div className="mt-1 text-[11px] text-fg-3">
              z ≥ {minZ.toFixed(1)} — {minZ >= 1.5 ? 'clear outliers' : minZ >= 0.8 ? 'above average' : 'everything'}
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-3">Show</h2>
            <div className="space-y-1">
              <button onClick={() => setShowAll(false)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-[13px] transition ${!showAll ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-bg-2'}`}>
                Clips only
                <span className="block text-[11px] text-fg-3">a chart must be on screen</span>
              </button>
              <button onClick={() => setShowAll(true)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-[13px] transition ${showAll ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-bg-2'}`}>
                Everything
                <span className="block text-[11px] text-fg-3">includes selfies, lifestyle, memes</span>
              </button>
            </div>
          </div>

          {/* Camera layout — tagged automatically by the classifier on every clip. */}
          {layouts.length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-3">
                Camera layout
              </h2>
              <ul className="space-y-0.5">
                <li>
                  <button onClick={() => setLayout(null)}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-[13px] transition ${!layout ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-bg-2'}`}>
                    Any layout
                  </button>
                </li>
                {layouts.map((l) => (
                  <li key={l.layout}>
                    <button onClick={() => setLayout(l.layout === layout ? null : l.layout)}
                      className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] transition ${layout === l.layout ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-bg-2'}`}>
                      <span>{LAYOUT_LABELS[l.layout] ?? l.layout}</span>
                      <span className="text-[11px] text-fg-3">{l.n}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Tags — the team's own labels, and the filter that turns them into a search. */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-3">Tags</h2>
              {allTags.length > 0 && (
                <button onClick={() => setManageTags((v) => !v)} className="text-[11px] text-fg-3 hover:text-fg-1">{manageTags ? 'Done' : 'Manage'}</button>
              )}
            </div>
            {allTags.length === 0 ? (
              <div className="text-[11px] text-fg-3">Tag a reel with the + on its card. Tags are saved and reusable.</div>
            ) : (
              <ul className="space-y-0.5">
                <li>
                  <button onClick={() => setTag(null)}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-[13px] transition ${!tag ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-bg-2'}`}>
                    Any tag
                  </button>
                </li>
                {allTags.map((t) => (
                  <li key={t.id}>
                    {manageTags ? (
                      <div className="flex items-center gap-1.5 px-1 py-1">
                        <label className="relative h-3.5 w-3.5 shrink-0 cursor-pointer overflow-hidden rounded-full" style={{ background: t.color }} title="Colour">
                          <input type="color" defaultValue={t.color} onChange={(e) => recolourTag(t.id, e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
                        </label>
                        <input defaultValue={t.name}
                          onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== t.name) renameTag(t.id, e.target.value); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          className="min-w-0 flex-1 rounded bg-bg-2 px-1.5 py-0.5 text-[12px] outline-none focus:ring-1 focus:ring-accent" />
                        <button onClick={() => removeTag(t.id)} className="text-fg-3 hover:text-error" title="Delete tag"><Trash2 className="h-3 w-3" /></button>
                      </div>
                    ) : (
                      <button onClick={() => setTag(t.id === tag ? null : t.id)}
                        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition ${tag === t.id ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-bg-2'}`}>
                        <span className="flex min-w-0 items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color }} /><span className="truncate">{t.name}</span></span>
                        <span className="text-[11px] text-fg-3">{t.post_count ?? 0}</span>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {byFormat.length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-3">Formats</h2>
              <ul className="space-y-1 text-[12px] text-fg-3">
                {byFormat.map(([f, n]) => (
                  <li key={f} className="flex justify-between">
                    <span className="truncate">{FORMAT_LABELS[f] ?? f}</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <main>
          {loading ? (
            <div className="py-24 text-center text-sm text-fg-3">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line py-24 text-center text-sm text-fg-3">
              Nothing yet — hit <span className="text-fg-2">Refresh corpus</span> to scrape the last 60 days.
            </div>
          ) : (
            <>
              <div className="mb-3 text-xs text-fg-3">{rows.length} clips</div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {rows.map((o) => <OutlierCard key={o.shortcode} o={o} onOpen={setSelected} allTags={allTags} onTags={setPostTags} />)}
              </div>
            </>
          )}
        </main>
      </div>

      {selected && (
        <DetailSheet
          o={selected}
          onClose={() => setSelected(null)}
          onRelabel={async (sc, label) => {
            await fetch(`/api/outliers/${sc}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ format_label: label }),
            });
            setSelected((prev) => (prev ? { ...prev, format_label: label } : prev));
            setRows((prev) => prev.map((r) => (r.shortcode === sc ? { ...r, format_label: label } : r)));
          }}
        />
      )}
    </div>
  );
}

function DetailSheet({ o, onClose, onRelabel }: {
  o: Outlier; onClose: () => void; onRelabel: (sc: string, label: string) => void;
}) {
  const current = o.format_label || o.format;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div className="h-full w-[680px] overflow-y-auto border-l border-line bg-bg-1 p-6"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="text-xs text-fg-3">@{o.username}</div>
            <h3 className="mt-1 text-lg font-semibold leading-snug">
              {o.ocr_title || <span className="text-fg-3">no on-screen title found</span>}
            </h3>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-fg-3 transition hover:bg-bg-3 hover:text-fg-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Turning a reference into a brief is the point of the gallery — otherwise it is
            a mood board. This carries the measured shape of THIS clip (length, format,
            hook type, title pattern) into a new job. */}
        <UseAsReference o={o} />

        <div className="grid grid-cols-[260px_1fr] gap-5">
          {o.media_state === 'downloaded' ? (
            <video src={`/api/outliers/media?sc=${o.shortcode}`} controls
              className="w-full rounded-lg border border-line bg-black" />
          ) : (
            <div className="flex aspect-[9/16] items-center justify-center rounded-lg border border-dashed border-line text-xs text-fg-3">
              not downloaded
            </div>
          )}

          <dl className="space-y-3 text-[13px]">
            <Row k="Outlier score" v={`${o.display_mult}× this page's typical reel (z ${o.z})`} />
            <Row k="Views" v={`${o.views.toLocaleString()} · ${o.likes.toLocaleString()} likes · ${o.comments.toLocaleString()} comments`} />
            {o.duration_s && <Row k="Length" v={`${Math.round(o.duration_s)}s`} />}
            {o.format && <Row k="Format" v={`${FORMAT_LABELS[o.format_label || o.format] ?? o.format}${o.format_conf ? ` (${o.format_conf})` : ''}`} />}
            {o.has_chart != null && (
              <Row k="Chart on screen"
                v={o.has_chart ? `yes — about ${Math.round((o.chart_share ?? 0) * 100)}% of the frame` : 'no'} />
            )}
            {o.topic && <Row k="Topic" v={o.topic.replace(/_/g, ' ')} />}
            {o.hook_type && <Row k="Hook" v={o.hook_type.replace(/_/g, ' ')} />}
            {o.evidence && <Row k="What's on screen" v={o.evidence} />}
            {o.caption && <Row k="IG caption" v={o.caption.slice(0, 160)} />}

            {/* Correcting the classifier is the only thing that makes it improve. A label
                set here always beats the model's guess, and later refits fit to these. */}
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-fg-3">
                Wrong format? Fix it
              </dt>
              <dd className="mt-1.5 flex flex-wrap gap-1.5">
                {Object.entries(FORMAT_LABELS).map(([k, v]) => (
                  <button
                    key={k}
                    onClick={() => onRelabel(o.shortcode, k)}
                    className={`rounded-md border px-2 py-1 text-[11px] transition ${
                      current === k
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-fg-3 hover:border-fg-3 hover:text-fg-1'}`}
                  >
                    {v}
                  </button>
                ))}
              </dd>
              {o.format_label && (
                <p className="mt-1.5 text-[11px] text-success">
                  Corrected by hand — overrides the model.
                </p>
              )}
            </div>
            <div className="flex items-center gap-3 pt-1">
              <a href={o.post_url} target="_blank" rel="noreferrer"
                className="text-[12px] text-accent underline-offset-2 hover:underline">
                Open on Instagram →
              </a>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}

function UseAsReference({ o }: { o: Outlier }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [sent, setSent] = useState<string | null>(null);

  const target = Math.round(o.duration_s ?? 45);
  const paneOrder = 'camera-top';

  const submit = async () => {
    if (!url.trim()) return;
    const { jobId } = await fetch('/api/sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: url.trim(),
        layout: 'auto',
        paneOrder,
        styleId: 'sequel-viral',
        // Constraints lifted from the reference so the new clips inherit its shape.
        selectOptions: { minSeconds: Math.max(15, target - 12), maxSeconds: target + 15 },
        referenceShortcode: o.shortcode,
      }),
    }).then((x) => x.json());
    setSent(jobId);
  };

  return (
    <div className="mb-5 rounded-lg border border-accent/30 bg-accent-soft/40 p-3.5">
      {!open ? (
        <button onClick={() => setOpen(true)}
          className="text-[13px] font-semibold text-accent hover:underline">
          Make a clip like this →
        </button>
      ) : sent ? (
        <p className="text-[12px] text-success">
          Queued. It&apos;ll appear on the <Link href="/" className="underline">dashboard</Link>.
        </p>
      ) : (
        <>
          <p className="mb-2 text-[12px] text-fg-2">
            Paste the livestream or video to cut from. This clip&apos;s shape carries over:
            <span className="text-fg-1"> ~{target}s</span>,
            <span className="text-fg-1"> {(o.format_label || o.format || 'chart').replace(/_/g, ' ')}</span>
            {o.hook_type && <>, <span className="text-fg-1">{o.hook_type.replace(/_/g, ' ')}</span> hook</>}.
          </p>
          <div className="flex gap-2">
            <input value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="YouTube / livestream link or file path"
              className="flex-1 rounded-md border border-line bg-bg-3 px-2.5 py-1.5 text-[12px] outline-none focus:border-accent" />
            <button onClick={submit} disabled={!url.trim()}
              className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40">
              Queue
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-fg-3">{k}</dt>
      <dd className="mt-0.5 leading-snug text-fg-1">{v}</dd>
    </div>
  );
}
