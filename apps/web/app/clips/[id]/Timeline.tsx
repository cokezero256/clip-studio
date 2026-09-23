'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FastForward, Magnet, Scissors, Trash2, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import type { Doc, Pause, Preview, Selection, WordRow } from './types';
import { fmtTimeMs } from './types';
import type { Playback } from './usePlayback';
import {
  blocks as blocksOf, duration as durationOf, outToSrc, srcToOut, blockAt,
  splitAt, restoreCut, trimBlockStart, trimBlockEnd, moveWord, moveWordEdge, snapTo, type Block, type WordRef,
} from './timelineModel';
import { IconBtn } from '../../components/ui';

type Peaks = { duration: number; sampleRate: number; peaks: Array<[number, number]> };

/**
 * The timeline — edited time, four tracks, one canvas.
 *
 *   ruler      timecode in the clip's own time
 *   Title      one block: how long the headline stays (drag its right edge)
 *   Words      every caption word as a block — drag to move it, trim its edges to fix timing
 *   Video      kept footage as clips with filmstrip thumbnails; trim edges, split, delete;
 *              a marker between clips is removed footage — click it to bring it back
 *   Audio      the waveform of what is kept
 *
 * Every mutation goes through timelineModel.ts (pure, tested); this file only maps pixels to
 * seconds and draws. `x = PAD + (t - scroll) * zoom`.
 */
const ROWS = { ruler: 22, title: 30, words: 38, video: 66, audio: 40 } as const;
const GAP = 4;
const PAD = 12;
const SELECT = '#FF2A93';

type Gesture =
  | { kind: 'scrub' }
  | { kind: 'block-start' | 'block-end'; block: Block; edgeSrc: number; x0: number }
  | { kind: 'word-move' | 'word-start' | 'word-end'; x0: number; w: WordRef; prev: WordRef | null; next: WordRef | null }
  | { kind: 'title-end'; x0: number; hold0: number }
  | { kind: 'marquee'; x0: number; y0: number; x: number; y: number; base: string[]; moved: boolean; anchorKey: string | null };

export default function Timeline(props: {
  clipId: string;
  doc: Doc;
  preview: Preview | null;
  words: WordRow[];
  window: { start: number; end: number };
  fps: number;
  proxy: { origin: number; duration: number; filmstrip: { columns: number; rows: number; tileW: number; tileH: number; secondsPerTile: number; count: number } | null };
  playback: Playback;
  setDoc: (u: (d: Doc) => Doc, o?: { coalesce?: string }) => void;
  endGesture: () => void;
  selection: Selection;
  setSelection: (s: Selection) => void;
  /** Delete whatever is selected (the Editor owns the rule, ⌫ uses the same path). */
  onDelete: () => void;
  /** Measured pauses in the window; dead air above `maxPause` is tinted and can be tightened away. */
  pauses: Pause[];
  maxPause: number;
  setMaxPause: (s: number) => void;
  onTighten: () => void;
}) {
  const { doc, words, playback, setDoc, selection, setSelection, fps } = props;
  const selectedKeys = useMemo(() => new Set(selection?.kind === 'blocks' ? selection.keys : []), [selection]);
  const selectedWords = useMemo(() => new Set(selection?.kind === 'words' ? selection.is : []), [selection]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 240 });
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const strip = useRef<HTMLImageElement | null>(null);
  const [, bump] = useState(0);
  const redraw = useCallback(() => bump((n) => n + 1), []);
  const view = useRef({ zoom: 20, scroll: 0 });
  const playhead = useRef(0);
  const playing = useRef(false);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const [snap, setSnap] = useState(true);

  const bl = useMemo(() => blocksOf(doc, fps), [doc, fps]);
  const total = durationOf(bl);
  // Dead air: pauses longer than the limit that are still inside kept footage (edited time).
  const deadAir = useMemo(() => {
    const out: Array<{ out0: number; out1: number }> = [];
    const pauses = Array.isArray(props.pauses) ? props.pauses : [];
    for (const b of bl) for (const p of pauses) {
      const a = Math.max(p.start, b.a), z = Math.min(p.end, b.b);
      if (z - a > props.maxPause) out.push({ out0: b.outStart + (a - b.a), out1: b.outStart + (z - b.a) });
    }
    return out;
  }, [bl, props.pauses, props.maxPause]);
  const deadAirTotal = deadAir.reduce((s, d) => s + (d.out1 - d.out0), 0);
  const titleEnd = props.preview?.title ? (doc.title.hold ?? total) : 0;

  // Word blocks in edited time (kept, visible words only).
  const wordBlocks = useMemo(() => {
    const out: Array<{ w: WordRow; out0: number; out1: number }> = [];
    for (const w of words) {
      if (!w.inRange || w.cut || w.hidden) continue;
      const o0 = srcToOut(w.start, bl);
      if (o0 == null) continue;
      const b = blockAt(o0, bl);
      if (!b) continue;
      const end = Math.min(w.end, b.b);
      out.push({ w, out0: o0, out1: Math.max(o0 + 0.03, b.outStart + (end - b.a)) });
    }
    return out;
  }, [words, bl]);

  useEffect(() => {
    fetch(`/api/editor/${props.clipId}/peaks`).then((r) => (r.ok ? r.json() : null)).then(setPeaks).catch(() => setPeaks(null));
    if (props.proxy.filmstrip) {
      const img = new Image();
      img.onload = () => { strip.current = img; redraw(); };
      img.src = `/api/editor/${props.clipId}/media?kind=filmstrip`;
    }
  }, [props.clipId, props.proxy.filmstrip, redraw]);

  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, r.width), h: Math.max(160, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit reads the duration through a ref so a trim (which changes `total`) never re-zooms
  // the view under the pointer; only a panel resize refits, and only until the user zooms.
  const totalRef = useRef(total);
  totalRef.current = total;
  const userZoomed = useRef(false);
  const fit = useCallback(() => {
    const usable = size.w - PAD * 2;
    view.current = { zoom: Math.max(2, usable / Math.max(1, totalRef.current)), scroll: 0 };
    redraw();
  }, [size.w, redraw]);
  useEffect(() => { if (size.w > 300 && totalRef.current > 0 && !userZoomed.current) fit(); }, [size.w, fit]);

  useEffect(() => playback.subscribe((t, isPlaying) => {
    playing.current = isPlaying;
    playhead.current = t;
    const { zoom, scroll } = view.current;
    const x = PAD + (t - scroll) * zoom;
    if (isPlaying && (x > size.w * 0.85 || x < PAD)) view.current.scroll = Math.max(0, t - (size.w * 0.15) / zoom);
    redraw();
  }), [playback, size.w, redraw]);

  // Debug handle (same spirit as window.__editorDebug): the view, the rows and the word blocks.
  useEffect(() => {
    (window as unknown as { __timelineDebug: unknown }).__timelineDebug = {
      view: () => ({ ...view.current }), size, rows: ROWS, pad: PAD,
      words: () => wordBlocks.map((wb) => ({ i: wb.w.i, text: wb.w.text, out0: wb.out0, out1: wb.out1 })),
      blocks: () => bl,
    };
  });

  const xOf = (t: number) => PAD + (t - view.current.scroll) * view.current.zoom;
  const tOf = (x: number) => view.current.scroll + (x - PAD) / view.current.zoom;
  const rows = useMemo(() => {
    let y = 0;
    const r: Record<'ruler' | 'title' | 'words' | 'video' | 'audio', { y: number; h: number }> = {} as never;
    for (const k of ['ruler', 'title', 'words', 'video', 'audio'] as const) { r[k] = { y, h: ROWS[k] }; y += ROWS[k] + GAP; }
    return r;
  }, []);

  // ───────────────────────────── draw ─────────────────────────────
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr; c.height = size.h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const W = size.w;
    const { zoom, scroll } = view.current;
    ctx.clearRect(0, 0, W, size.h);

    const rr = (x: number, y: number, w: number, h: number, r: number) => {
      const rad = Math.max(0, Math.min(r, w / 2, h / 2));
      ctx.beginPath();
      ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath();
    };
    const lane = (row: { y: number; h: number }) => { ctx.fillStyle = 'rgba(255,255,255,0.03)'; rr(0, row.y, W, row.h, 8); ctx.fill(); };
    const FONT = 'ui-sans-serif, -apple-system, system-ui';

    // Ruler.
    const step = zoom > 120 ? 0.5 : zoom > 50 ? 1 : zoom > 20 ? 2 : zoom > 8 ? 5 : zoom > 3 ? 10 : 30;
    ctx.font = `10px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let t = Math.ceil(scroll / step) * step; xOf(t) < W; t += step) {
      const x = xOf(t);
      if (x < PAD - 1) continue;
      ctx.fillRect(x, rows.ruler.y + 14, 1, 6);
      ctx.fillText(fmtTimeMs(t).replace(/\.0$/, ''), x + 3, rows.ruler.y + 11);
    }

    // Title track.
    lane(rows.title);
    if (props.preview?.title) {
      const x0 = xOf(0), x1 = xOf(titleEnd);
      const sel = selection?.kind === 'title';
      ctx.fillStyle = sel ? 'rgba(236,11,122,0.35)' : 'rgba(236,11,122,0.18)';
      rr(x0, rows.title.y + 3, Math.max(8, x1 - x0), rows.title.h - 6, 7); ctx.fill();
      if (sel) { ctx.strokeStyle = SELECT; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = `11px ${FONT}`;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, rows.title.y, Math.max(8, x1 - x0) - 6, rows.title.h); ctx.clip();
      ctx.fillText(`T  ${doc.title.text}`, x0 + 8, rows.title.y + rows.title.h / 2 + 4); ctx.restore();
      ctx.fillStyle = sel ? '#fff' : 'rgba(255,255,255,0.55)';
      rr(x1 - 3, rows.title.y + 7, 4, rows.title.h - 14, 2); ctx.fill();
      if (doc.title.hold != null) { ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.fillText(`${doc.title.hold}s`, x1 + 6, rows.title.y + rows.title.h / 2 + 4); }
    }

    // Words track.
    lane(rows.words);
    ctx.font = `11px ${FONT}`;
    for (const wb of wordBlocks) {
      const x0 = xOf(wb.out0), x1 = xOf(wb.out1);
      if (x1 < 0 || x0 > W) continue;
      const sel = selectedWords.has(wb.w.i);
      const moved = doc.words[String(wb.w.i)]?.start != null || doc.words[String(wb.w.i)]?.end != null;
      ctx.fillStyle = sel ? 'rgba(255,229,0,0.6)' : moved ? 'rgba(96,165,250,0.38)' : wb.w.edited ? 'rgba(236,11,122,0.3)' : 'rgba(255,255,255,0.12)';
      rr(x0, rows.words.y + 5, Math.max(3, x1 - x0 - 1), rows.words.h - 10, 5); ctx.fill();
      if (sel) {
        ctx.strokeStyle = '#FFE500'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = '#fff';
        rr(x0 - 2, rows.words.y + 3, 4, rows.words.h - 6, 2); ctx.fill();
        rr(x1 - 3, rows.words.y + 3, 4, rows.words.h - 6, 2); ctx.fill();
      }
      if (x1 - x0 > 22) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + 2, rows.words.y, x1 - x0 - 6, rows.words.h); ctx.clip();
        ctx.fillStyle = sel ? '#111' : 'rgba(255,255,255,0.85)';
        ctx.fillText(wb.w.text, x0 + 5, rows.words.y + rows.words.h / 2 + 4); ctx.restore();
      }
    }

    // Video track: filmstrip per block.
    lane(rows.video);
    const img = strip.current;
    const fs = props.proxy.filmstrip;
    for (const b of bl) {
      const x0 = xOf(b.outStart), x1 = xOf(b.outEnd);
      if (x1 < 0 || x0 > W) continue;
      const sel = selectedKeys.has(b.key);
      ctx.save();
      rr(x0 + 1, rows.video.y + 2, Math.max(2, x1 - x0 - 2), rows.video.h - 4, 8); ctx.clip();
      ctx.fillStyle = '#18181c'; ctx.fillRect(x0, rows.video.y, x1 - x0, rows.video.h);
      if (img && fs) {
        const tileH = rows.video.h - 4;
        const tileW = tileH * (fs.tileW / fs.tileH);
        for (let x = Math.max(x0, PAD - tileW); x < Math.min(x1, W); x += tileW) {
          const tOut = tOf(x);
          const src = outToSrc(Math.min(Math.max(tOut, b.outStart), b.outEnd - 1e-3), bl);
          const k = Math.max(0, Math.min(fs.count - 1, Math.floor((src - props.proxy.origin) / fs.secondsPerTile)));
          const sx = (k % fs.columns) * fs.tileW, sy = Math.floor(k / fs.columns) * fs.tileH;
          ctx.drawImage(img, sx, sy, fs.tileW, fs.tileH, x, rows.video.y + 2, tileW + 0.5, tileH);
        }
      }
      ctx.restore();
      rr(x0 + 1, rows.video.y + 2, Math.max(2, x1 - x0 - 2), rows.video.h - 4, 8);
      ctx.strokeStyle = sel ? SELECT : 'rgba(255,255,255,0.12)'; ctx.lineWidth = sel ? 2 : 1; ctx.stroke();
      // A split is a razor mark: a bright seam, so "Split" visibly did something.
      if (b.startsAt === 'split') { ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(x0 - 1, rows.video.y - 3, 2, rows.video.h + 6); }
      if (sel) {
        ctx.fillStyle = '#fff';
        rr(x0 + 1, rows.video.y + 2, 8, rows.video.h - 4, 8); ctx.fill();
        rr(x1 - 9, rows.video.y + 2, 8, rows.video.h - 4, 8); ctx.fill();
        ctx.fillStyle = SELECT;
        ctx.fillRect(x0 + 4, rows.video.y + rows.video.h / 2 - 8, 2, 16);
        ctx.fillRect(x1 - 6, rows.video.y + rows.video.h / 2 - 8, 2, 16);
      }
    }
    // Removed-footage markers, clickable.
    ctx.font = `10px ${FONT}`;
    for (const cut of doc.cuts) {
      const at = srcToOut(cut.end, bl);
      const x = at != null ? xOf(at) : (cut.end <= doc.range.start + 1e-6 ? xOf(0) : xOf(total));
      if (x < 0 || x > W) continue;
      const hov = hover.current && Math.abs(hover.current.x - x) < 8 && hover.current.y >= rows.video.y - 10 && hover.current.y <= rows.video.y + 10;
      ctx.fillStyle = hov ? '#EF4444' : 'rgba(239,68,68,0.8)';
      ctx.beginPath(); ctx.arc(x, rows.video.y - 2, hov ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
      if (hov) { ctx.fillStyle = '#fff'; ctx.fillText(`restore ${(cut.end - cut.start).toFixed(1)}s`, x + 8, rows.video.y - 4); }
    }

    // Audio track: kept waveform, with dead air the tools can remove tinted underneath.
    lane(rows.audio);
    for (const d of deadAir) {
      const x0 = xOf(d.out0), x1 = xOf(d.out1);
      if (x1 < 0 || x0 > W) continue;
      ctx.fillStyle = 'rgba(251,146,60,0.22)';
      rr(x0, rows.audio.y + 2, Math.max(2, x1 - x0), rows.audio.h - 4, 4); ctx.fill();
    }
    if (peaks && peaks.peaks.length) {
      const bps = peaks.peaks.length / peaks.duration;
      const mid = rows.audio.y + rows.audio.h / 2;
      for (let x = PAD; x < W; x++) {
        const tOut = tOf(x);
        if (tOut < 0 || tOut >= total) continue;
        const src = outToSrc(tOut, bl);
        const i = Math.floor((src - props.proxy.origin) * bps);
        if (i < 0 || i >= peaks.peaks.length) continue;
        const [mn, mx] = peaks.peaks[i];
        const amp = Math.max(Math.abs(mn), Math.abs(mx));
        const h = Math.max(1, amp * (rows.audio.h - 8));
        ctx.fillStyle = 'rgba(236,11,122,0.75)';
        ctx.fillRect(x, mid - h / 2, 1, h);
      }
    }

    // Playhead + time badge.
    const px = xOf(playhead.current);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(px - 0.75, rows.ruler.y + 14, 1.5, size.h - rows.ruler.y - 14);
    const bx = Math.max(24, Math.min(W - 24, px));
    rr(bx - 24, rows.ruler.y, 48, 15, 5); ctx.fillStyle = 'rgba(255,255,255,0.94)'; ctx.fill();
    ctx.fillStyle = '#0A0A0B'; ctx.font = `10px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText(fmtTimeMs(playhead.current), bx, rows.ruler.y + 11); ctx.textAlign = 'left';

    // Hover guide.
    if (hover.current && !playing.current) {
      const t = tOf(hover.current.x);
      if (t >= 0 && t <= total) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(hover.current.x, rows.title.y, 1, size.h - rows.title.y); }
    }

    // Marquee (rubber band) while dragging across clips.
    const m = marquee.current;
    if (m) {
      const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
      ctx.fillStyle = 'rgba(255,42,147,0.12)';
      ctx.fillRect(x0, rows.video.y, x1 - x0, rows.video.h);
      ctx.strokeStyle = SELECT; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.strokeRect(x0 + 0.5, rows.video.y + 0.5, x1 - x0, rows.video.h - 1); ctx.setLineDash([]);
    }
  });

  // ───────────────────────────── interaction ─────────────────────────────
  const gesture = useRef<Gesture | null>(null);
  const marquee = useRef<{ x0: number; x1: number } | null>(null);
  const blocksBetween = (xa: number, xb: number) => {
    const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
    return bl.filter((b) => xOf(b.outEnd) >= lo && xOf(b.outStart) <= hi).map((b) => b.key);
  };
  const local = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const inRow = (y: number, row: { y: number; h: number }) => y >= row.y && y <= row.y + row.h;
  const snapTargets = useMemo(() => {
    const t: number[] = [];
    for (const b of bl) t.push(b.outStart, b.outEnd);
    for (const wb of wordBlocks) t.push(wb.out0);
    return t;
  }, [bl, wordBlocks]);
  const maybeSnap = (t: number) => (snap ? snapTo(t, [...snapTargets, playhead.current], 6 / view.current.zoom) : t);

  const onDown = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const t = tOf(x);

    if (inRow(y, rows.ruler)) { gesture.current = { kind: 'scrub' }; playback.seekOutput(Math.max(0, Math.min(total, t))); return; }

    // Removed-footage marker?
    for (const cut of doc.cuts) {
      const at = srcToOut(cut.end, bl);
      const mx = at != null ? xOf(at) : (cut.end <= doc.range.start + 1e-6 ? xOf(0) : xOf(total));
      if (Math.abs(x - mx) < 8 && y >= rows.video.y - 10 && y <= rows.video.y + 10) {
        setDoc((d) => restoreCut(d, cut));
        return;
      }
    }

    if (inRow(y, rows.title) && props.preview?.title) {
      const x1 = xOf(titleEnd);
      if (Math.abs(x - x1) <= 6) { gesture.current = { kind: 'title-end', x0: x, hold0: titleEnd }; setSelection({ kind: 'title' }); return; }
      if (x >= xOf(0) && x <= x1) { setSelection({ kind: 'title' }); return; }
    }

    if (inRow(y, rows.words)) {
      const hit = wordBlocks.find((wb) => x >= xOf(wb.out0) && x <= xOf(wb.out1))
        || wordBlocks.find((wb) => x >= xOf(wb.out0) - 4 && x <= xOf(wb.out1) + 4);
      if (hit) {
        const kept = words.filter((w) => w.inRange && !w.cut && !w.hidden);
        const kIdx = kept.findIndex((w) => w.i === hit.w.i);
        const ref = (w: WordRow | undefined): WordRef | null => (w ? { i: w.i, start: w.start, end: w.end } : null);
        const base = { x0: x, w: ref(hit.w)!, prev: ref(kept[kIdx - 1]), next: ref(kept[kIdx + 1]) };
        const x0 = xOf(hit.out0), x1 = xOf(hit.out1);
        const edge = Math.min(5, (x1 - x0) / 3);
        if (e.shiftKey && selection?.kind === 'words' && selection.is.length) {
          // Extend the run of words from the selection to this one (kept words only).
          const lo = Math.min(...selection.is, hit.w.i), hi = Math.max(...selection.is, hit.w.i);
          setSelection({ kind: 'words', is: kept.filter((w) => w.i >= lo && w.i <= hi).map((w) => w.i) });
          return;
        }
        if (Math.abs(x - x0) <= edge) gesture.current = { kind: 'word-start', ...base };
        else if (Math.abs(x - x1) <= edge) gesture.current = { kind: 'word-end', ...base };
        else gesture.current = { kind: 'word-move', ...base };
        setSelection({ kind: 'words', is: [hit.w.i] });
        playback.seekOutput(hit.out0);
        return;
      }
      setSelection(null);
      gesture.current = { kind: 'scrub' };
      playback.seekOutput(Math.max(0, Math.min(total, t)));
      return;
    }

    if (inRow(y, rows.video) || inRow(y, rows.audio)) {
      const b = t >= 0 && t < total ? blockAt(t, bl) : null;
      if (b) {
        const x0 = xOf(b.outStart), x1 = xOf(b.outEnd);
        if (Math.abs(x - x0) <= 7) { gesture.current = { kind: 'block-start', block: b, edgeSrc: b.a, x0: x }; setSelection({ kind: 'blocks', keys: [b.key] }); return; }
        if (Math.abs(x - x1) <= 7) { gesture.current = { kind: 'block-end', block: b, edgeSrc: b.b, x0: x }; setSelection({ kind: 'blocks', keys: [b.key] }); return; }
      }
      // Press on a clip selects it (⇧ adds); a drag from here is a marquee across clips —
      // the ruler is where scrubbing lives, like Premiere and CapCut.
      const base = e.shiftKey && selection?.kind === 'blocks' ? selection.keys : [];
      gesture.current = { kind: 'marquee', x0: x, y0: y, x, y, base, moved: false, anchorKey: b ? b.key : null };
      return;
    }
    setSelection(null);
    gesture.current = { kind: 'scrub' };
    playback.seekOutput(Math.max(0, Math.min(total, t)));
  };

  const onMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    hover.current = { x, y };
    const g = gesture.current;
    const el = e.currentTarget as HTMLElement;
    if (!g) {
      let cur = 'default';
      if (inRow(y, rows.ruler)) cur = 'col-resize';
      else {
        const t = tOf(x);
        const b = blockAt(t, bl);
        if (b && (Math.abs(x - xOf(b.outStart)) <= 7 || Math.abs(x - xOf(b.outEnd)) <= 7) && (inRow(y, rows.video) || inRow(y, rows.audio))) cur = 'ew-resize';
        else if (inRow(y, rows.video) || inRow(y, rows.audio)) cur = 'crosshair';
        else if (inRow(y, rows.words)) {
          const wb = wordBlocks.find((q) => x >= xOf(q.out0) - 4 && x <= xOf(q.out1) + 4);
          if (wb) { const x0 = xOf(wb.out0), x1 = xOf(wb.out1); const edge = Math.min(5, (x1 - x0) / 3); cur = Math.abs(x - x0) <= edge || Math.abs(x - x1) <= edge ? 'col-resize' : 'grab'; }
        }
        else if (inRow(y, rows.title) && Math.abs(x - xOf(titleEnd)) <= 6) cur = 'ew-resize';
      }
      el.style.cursor = cur;
      redraw();
      return;
    }
    const dt = 'x0' in g ? (x - g.x0) / view.current.zoom : 0;
    if (g.kind === 'scrub') { playback.seekOutput(Math.max(0, Math.min(total, tOf(x)))); return; }
    if (g.kind === 'marquee') {
      g.x = x; g.y = y;
      if (!g.moved && Math.abs(x - g.x0) < 4) return;
      g.moved = true;
      marquee.current = { x0: g.x0, x1: x };
      const keys = [...new Set([...g.base, ...blocksBetween(g.x0, x)])];
      setSelection(keys.length ? { kind: 'blocks', keys } : null);
      redraw();
      return;
    }
    if (g.kind === 'block-start') {
      setDoc((d) => trimBlockStart(d, g.block, g.edgeSrc + dt, { windowStart: props.window.start, fps }), { coalesce: 'trim-start-' + g.block.key });
    } else if (g.kind === 'block-end') {
      setDoc((d) => trimBlockEnd(d, g.block, g.edgeSrc + dt, { windowEnd: props.window.end, fps }), { coalesce: 'trim-end-' + g.block.key });
    } else if (g.kind === 'word-move') {
      setDoc((d) => moveWord(d, g.w, dt, g.prev, g.next), { coalesce: 'word-' + g.w.i });
    } else if (g.kind === 'word-start' || g.kind === 'word-end') {
      const t = g.kind === 'word-start' ? g.w.start + dt : g.w.end + dt;
      setDoc((d) => moveWordEdge(d, g.w, g.kind === 'word-start' ? 'start' : 'end', t, g.prev, g.next), { coalesce: 'word-' + g.w.i });
    } else if (g.kind === 'title-end') {
      const t = maybeSnap(Math.max(1, g.hold0 + dt));
      const hold = t >= total - 0.4 ? null : +t.toFixed(1);
      setDoc((d) => ({ ...d, title: { ...d.title, hold } }), { coalesce: 'title-hold' });
    }
    redraw();
  };
  const onUp = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'marquee') {
      marquee.current = null;
      if (!g.moved) {
        // A plain press: select the clip under it (⇧ toggles it in the set), or clear.
        if (g.anchorKey) {
          const set = new Set(g.base);
          if (e.shiftKey && set.has(g.anchorKey)) set.delete(g.anchorKey); else set.add(g.anchorKey);
          setSelection(set.size ? { kind: 'blocks', keys: [...set] } : null);
        } else setSelection(null);
      }
      redraw();
      gesture.current = null;
      return;
    }
    if (g && g.kind !== 'scrub') props.endGesture();
    gesture.current = null;
  };
  const onWheel = useCallback((e: React.WheelEvent) => {
    const { zoom, scroll } = view.current;
    if (e.metaKey || e.ctrlKey) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - r.left;
      const tAt = scroll + (x - PAD) / zoom;
      const nz = Math.max(2, Math.min(600, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      view.current = { zoom: nz, scroll: Math.max(0, tAt - (x - PAD) / nz) };
      userZoomed.current = true;
    } else {
      view.current.scroll = Math.max(0, scroll + (e.deltaX || e.deltaY) / zoom);
    }
    redraw();
  }, [redraw]);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const prevent = (e: WheelEvent) => { e.preventDefault(); };
    c.addEventListener('wheel', prevent, { passive: false });
    return () => c.removeEventListener('wheel', prevent);
  }, []);

  const doSplit = () => { setDoc((d) => splitAt(d, playhead.current, fps)); };
  const selCount = selection?.kind === 'blocks' ? selection.keys.length : selection?.kind === 'words' ? selection.is.length : 0;
  const zoomBy = (f: number) => { userZoomed.current = true; view.current.zoom = Math.max(2, Math.min(600, view.current.zoom * f)); redraw(); };
  const refit = () => { userZoomed.current = false; fit(); };

  const band = total < 25 ? 'text-warning' : total > 120 ? 'text-error' : 'text-success';
  const canDelete = selection?.kind === 'blocks' ? bl.length > 1 && selCount > 0 : selection?.kind === 'words' && selCount > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap px-3 py-1.5 text-[12px] text-fg-3">
        <IconBtn onClick={doSplit} title="Split at the playhead (S)"><Scissors className="h-3.5 w-3.5" /> Split</IconBtn>
        <IconBtn onClick={props.onDelete} disabled={!canDelete} title={selection?.kind === 'words' ? 'Cut the footage under the selected words (⌫) · H hides just their captions' : 'Delete the selected clips (⌫)'}>
          <Trash2 className="h-3.5 w-3.5" /> Delete{selCount > 1 ? ` ${selCount}` : ''}
        </IconBtn>
        <IconBtn onClick={() => setSnap((s) => !s)} active={snap} title="Snap to edges and words"><Magnet className="h-3.5 w-3.5" /></IconBtn>
        <span className="mx-1 h-4 w-px bg-white/10" />
        <IconBtn onClick={props.onTighten} title={`Cut every pause longer than ${props.maxPause} s (air is kept at each join); word-less slivers go too`}>
          <FastForward className="h-3.5 w-3.5" /> <span className="hidden lg:inline">Tighten pauses</span><span className="lg:hidden">Tighten</span>
        </IconBtn>
        <select value={props.maxPause} onChange={(e) => props.setMaxPause(+e.target.value)} title="Longest pause to keep"
          className="pill h-8 bg-transparent px-2 text-[12px] text-fg-2 outline-none">
          {[0.25, 0.35, 0.5, 0.8].map((v) => <option key={v} value={v} className="bg-bg-2">≤ {v} s</option>)}
        </select>
        {deadAirTotal > 0.05 && <span className="text-warning">{deadAirTotal.toFixed(1)} s dead air</span>}
        <span className="mx-1 h-4 w-px bg-white/10" />
        <span className={`tabular font-medium ${band}`}>{fmtTimeMs(total)}</span>
        <span className="hidden xl:inline">of 25–120 s</span>
        <span className="hidden lg:inline text-fg-3/60">·</span>
        <span className="hidden lg:inline">{bl.length} clip{bl.length === 1 ? '' : 's'} · {doc.cuts.length} removed</span>
        <div className="flex-1" />
        <IconBtn onClick={() => zoomBy(1 / 1.4)} title="Zoom out"><ZoomOut className="h-3.5 w-3.5" /></IconBtn>
        <IconBtn onClick={refit} title="Fit"><Maximize2 className="h-3.5 w-3.5" /></IconBtn>
        <IconBtn onClick={() => zoomBy(1.4)} title="Zoom in"><ZoomIn className="h-3.5 w-3.5" /></IconBtn>
      </div>
      <div className="relative min-h-0 flex-1 px-1 pb-1">
        <canvas ref={canvasRef} style={{ width: size.w, height: size.h, display: 'block' }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          onPointerLeave={() => { hover.current = null; redraw(); }} onWheel={onWheel} />
      </div>
    </div>
  );
}
