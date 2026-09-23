'use client';

import { useEffect, useRef, useState } from 'react';
import { Eye, Clock, Monitor, UserRound, Sparkles, Plus, Check } from 'lucide-react';

export type Tag = { id: string; name: string; color: string; post_count?: number; clip_count?: number };

export type Outlier = {
  shortcode: string; username: string; is_client: number;
  post_url: string; views: number; likes: number; comments: number;
  duration_s: number | null; z: number | null; display_mult: number | null;
  is_outlier: number; ocr_title: string | null; caption: string | null;
  format: string | null; format_label: string | null; format_conf: number | null;
  has_chart: number | null; chart_share: number | null;
  topic: string | null; hook_type: string | null; evidence: string | null;
  media_state: string; posted_at: string | null;
  tags?: string[];
};

/** Banded by z, so the colour means "how far above this page's normal", not raw views. */
function multColor(z: number | null) {
  if (z == null) return 'bg-bg-4 text-fg-2';
  if (z >= 2.5) return 'bg-accent text-white';
  if (z >= 1.5) return 'bg-warning/20 text-warning';
  if (z >= 0.8) return 'bg-success/15 text-success';
  return 'bg-bg-4 text-fg-3';
}

const fmtViews = (n: number) =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

const FORMAT_ICON: Record<string, React.ReactNode> = {
  screenshare_teach: <Monitor className="h-3 w-3" />,
  screenshare_recap: <Monitor className="h-3 w-3" />,
  talking_head: <UserRound className="h-3 w-3" />,
  talking_head_broll: <UserRound className="h-3 w-3" />,
  lifestyle: <Sparkles className="h-3 w-3" />,
};

/**
 * One reel. The root is a div, not a button: the tag chips and the tag picker are
 * interactive and interactive elements may not nest inside a button.
 */
export default function OutlierCard({ o, onOpen, allTags = [], onTags }: {
  o: Outlier;
  onOpen: (o: Outlier) => void;
  allTags?: Tag[];
  onTags?: (shortcode: string, tagIds: string[]) => void;
}) {
  const [hover, setHover] = useState(false);
  const vid = useRef<HTMLVideoElement>(null);
  const has = o.media_state === 'downloaded';
  const mine = new Set(o.tags || []);

  return (
    <div
      role="button" tabIndex={0}
      onClick={() => onOpen(o)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(o); }}
      onMouseEnter={() => { setHover(true); vid.current?.play().catch(() => {}); }}
      onMouseLeave={() => { setHover(false); if (vid.current) { vid.current.pause(); vid.current.currentTime = 0; } }}
      className="group cursor-pointer overflow-hidden rounded-xl border border-line bg-bg-2 text-left transition hover:border-accent/40"
    >
      <div className="relative aspect-[9/16] overflow-hidden bg-bg-1">
        {has ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/outliers/media?sc=${o.shortcode}&kind=poster`}
              alt=""
              className={`absolute inset-0 h-full w-full object-cover transition ${hover ? 'opacity-0' : 'opacity-100'}`}
            />
            <video
              ref={vid}
              src={`/api/outliers/media?sc=${o.shortcode}`}
              muted loop playsInline preload="none"
              className={`h-full w-full object-cover transition ${hover ? 'opacity-100' : 'opacity-0'}`}
            />
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-fg-3">
            not downloaded
          </div>
        )}

        <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5">
          <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${multColor(o.z)}`}>
            {o.display_mult ? `${o.display_mult}×` : '—'}
          </span>
          {o.is_client === 1 && (
            <span className="rounded-md bg-bg-1/80 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              client
            </span>
          )}
        </div>
        {o.format && (
          <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-bg-1/80 p-1 text-fg-2">
            {FORMAT_ICON[o.format_label || o.format] ?? <Monitor className="h-3 w-3" />}
          </span>
        )}

        {/* The OCR'd burned-in title — the whole reason this gallery is useful. The
            Instagram caption on these pages is literally "Crazy" or "True". */}
        {o.ocr_title && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg-1 via-bg-1/85 to-transparent p-2.5 pt-8">
            <p className="line-clamp-3 text-[12px] font-semibold leading-tight text-fg-1">
              {o.ocr_title}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2.5 px-2.5 py-2 text-[11px] text-fg-3">
        {/* min-w-0 is required: `truncate` on a flex child with no min-width collapses the
            element to zero and the handle disappears entirely. */}
        <span className="min-w-0 flex-1 truncate font-medium text-fg-2">@{o.username}</span>
        <span className="flex shrink-0 items-center gap-1"><Eye className="h-3 w-3" />{fmtViews(o.views)}</span>
        {o.duration_s && (
          <span className="flex shrink-0 items-center gap-1"><Clock className="h-3 w-3" />{Math.round(o.duration_s)}s</span>
        )}
      </div>

      {/* The team's own tags — what this reel teaches, in their words. */}
      {onTags && (
        <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2" onClick={(e) => e.stopPropagation()}>
          {allTags.filter((t) => mine.has(t.id)).map((t) => (
            <span key={t.id} className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white" style={{ background: t.color }}>{t.name}</span>
          ))}
          <TagPicker allTags={allTags} selected={mine} onChange={(ids) => onTags(o.shortcode, ids)} />
        </div>
      )}
    </div>
  );
}

/** A small popover: toggle existing tags, or type a new one and press Enter. */
function TagPicker({ allTags, selected, onChange }: { allTags: Tag[]; selected: Set<string>; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  };
  const create = async () => {
    const name = draft.trim();
    if (!name) return;
    const r = await fetch('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then((x) => x.json());
    if (r.tag) { onChange([...selected, r.tag.id]); setDraft(''); }
  };

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} title="Tag this reel"
        className="flex h-5 w-5 items-center justify-center rounded-full border border-line text-fg-3 transition hover:border-accent hover:text-accent">
        <Plus className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute bottom-7 left-0 z-30 w-52 rounded-xl border border-line bg-bg-2 p-2 shadow-2xl">
          <input value={draft} autoFocus onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setOpen(false); e.stopPropagation(); }}
            placeholder="New tag… (Enter)"
            className="mb-2 w-full rounded-md bg-bg-1 px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-accent" />
          <div className="max-h-44 space-y-0.5 overflow-y-auto">
            {allTags.length === 0 && <div className="px-1 py-1 text-[11px] text-fg-3">No tags yet — type one above.</div>}
            {allTags.map((t) => (
              <button key={t.id} onClick={() => toggle(t.id)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-bg-3">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
                <span className="flex-1 truncate">{t.name}</span>
                {selected.has(t.id) && <Check className="h-3 w-3 text-accent" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
