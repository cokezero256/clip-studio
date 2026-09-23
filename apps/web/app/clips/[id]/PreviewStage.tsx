'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import type { Doc, FontEntry, Preview, Selection } from './types';
import { CANVAS_H, CANVAS_W } from './types';
import { useTick, type Playback } from './usePlayback';

/**
 * The 9:16 canvas, drawn the way the export draws it.
 *
 * A 1080×1920 stage is scaled to fit its box; everything inside is positioned in canvas
 * pixels — the same numbers the renderer uses. Band formats place the whole source frame as
 * a `<video>`; re-composed formats draw the detected panes onto a canvas from the same
 * rectangles the ffmpeg chain crops. The title is the export's own PNG; the captions are
 * the server's events in the same font, size, colours and case.
 *
 * Touch the words: click the title or the captions to select them, drag anywhere to move,
 * pull the corner to resize. A glass toolbar follows the selection.
 */
export default function PreviewStage(props: {
  clipId: string;
  doc: Doc;
  preview: Preview | null;
  fonts: FontEntry[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playback: Playback;
  setDoc: (u: (d: Doc) => Doc, o?: { coalesce?: string }) => void;
  endGesture: () => void;
  selection: Selection;
  setSelection: (s: Selection) => void;
  pending: boolean;
  onEditTitleText: () => void;
}) {
  const { doc, preview, videoRef, playback, setDoc, selection, setSelection } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const paneCanvas = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(0.3);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [wrap, setWrap] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const s = Math.min((r.width - 32) / CANVAS_W, (r.height - 32) / CANVAS_H);
      setScale(s);
      setOffset({ x: (r.width - CANVAS_W * s) / 2, y: (r.height - CANVAS_H * s) / 2 });
      setWrap({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = preview?.geometry ?? { kind: 'band' as const, videoY: 700, videoH: 608, titleY: 470, captionY: 1420, panes: null, panesPending: null };
  const time = useTick(playback);
  const event = useMemo(() => {
    if (!preview?.captions.enabled) return null;
    const ev = preview.events;
    for (let i = ev.length - 1; i >= 0; i--) if (time >= ev[i].start && time < ev[i].end) return ev[i];
    return null;
  }, [preview, time]);
  const titleVisible = !!preview?.title && (doc.title.hold == null || time <= doc.title.hold);

  // Re-composed layouts: draw the panes every frame.
  useEffect(() => {
    const v = videoRef.current;
    const c = paneCanvas.current;
    if (!v || !c || geo.kind !== 'panes' || !geo.panes) return;
    const ctx = c.getContext('2d')!;
    let handle = 0;
    let alive = true;
    const vfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
    const draw = () => {
      if (!alive) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      const vw = v.videoWidth || 1, vh = v.videoHeight || 1;
      for (const p of geo.panes!) {
        try {
          ctx.drawImage(v, p.visible.x * vw, p.visible.y * vh, p.visible.w * vw, p.visible.h * vh, p.dst.x, p.dst.y, p.dst.w, p.dst.h);
        } catch { /* frame not ready */ }
      }
      handle = typeof vfc === 'function' && !v.paused ? vfc.call(v, draw) : requestAnimationFrame(draw);
    };
    draw();
    return () => { alive = false; cancelAnimationFrame(handle); (v as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }).cancelVideoFrameCallback?.(handle); };
  }, [videoRef, geo.kind, geo.panes]);

  // ── layer geometry (canvas px), live from the document so dragging is instant ──
  const titleCx = doc.title.x ?? CANVAS_W / 2;
  const titleCy = doc.title.y ?? geo.titleY ?? 470;
  const plateW = preview?.title?.width ?? 0, plateH = preview?.title?.height ?? 0;
  // Between server round-trips the PNG is still the old size: scale it so a resize feels live.
  const plateScale = preview?.title?.size ? doc.title.size / preview.title.size : 1;
  const capX = doc.captions.x ?? CANVAS_W / 2;
  const capY = doc.captions.y ?? geo.captionY;
  const capSize = doc.captions.size;

  // ── drag / resize ──
  type Drag = { layer: 'title' | 'captions'; mode: 'move' | 'resize'; x0: number; y0: number; baseX: number; baseY: number; baseSize: number; baseW: number };
  const drag = useRef<Drag | null>(null);
  const start = (layer: 'title' | 'captions', mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    e.stopPropagation();
    setSelection({ kind: layer });
    drag.current = {
      layer, mode, x0: e.clientX, y0: e.clientY,
      baseX: layer === 'title' ? titleCx : capX,
      baseY: layer === 'title' ? titleCy : capY,
      baseSize: layer === 'title' ? doc.title.size : capSize,
      baseW: layer === 'title' ? plateW * plateScale : 700,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x0) / scale;
    const dy = (e.clientY - d.y0) / scale;
    if (d.mode === 'move') {
      // The title plate stays whole on the canvas (the export would clip it, and its resize
      // grip would fall off the stage); captions keep a generous margin.
      const halfW = d.layer === 'title' ? Math.min(CANVAS_W / 2, (plateW * plateScale) / 2) : 60;
      const halfH = d.layer === 'title' ? Math.min(CANVAS_H / 2, (plateH * plateScale) / 2) : 0;
      const x = Math.round(Math.max(halfW, Math.min(CANVAS_W - halfW, d.baseX + dx)));
      const y = Math.round(Math.max(d.layer === 'title' ? Math.max(80, halfH) : 200, Math.min(d.layer === 'title' ? CANVAS_H - halfH - 40 : 1880, d.baseY + dy)));
      if (d.layer === 'title') setDoc((o) => ({ ...o, title: { ...o.title, x, y } }), { coalesce: 'drag-title' });
      else setDoc((o) => ({ ...o, captions: { ...o.captions, x, y } }), { coalesce: 'drag-captions' });
    } else {
      const factor = Math.max(0.3, 1 + dx / Math.max(200, d.baseW));
      const size = Math.round(d.baseSize * factor);
      if (d.layer === 'title') setDoc((o) => ({ ...o, title: { ...o.title, size: Math.max(32, Math.min(130, size)) } }), { coalesce: 'resize-title' });
      else setDoc((o) => ({ ...o, captions: { ...o.captions, size: Math.max(40, Math.min(160, size)) } }), { coalesce: 'resize-captions' });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    if (drag.current) { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); props.endGesture(); }
    drag.current = null;
  };

  const fontFaces = props.fonts.map((f) =>
    `@font-face{font-family:"${f.name}";src:url("/api/fonts/${encodeURIComponent(f.file)}");font-display:block;}`).join('\n');

  const sel = selection?.kind === 'title' || selection?.kind === 'captions' ? selection.kind : null;
  const bump = (layer: 'title' | 'captions', delta: number) => {
    if (layer === 'title') setDoc((o) => ({ ...o, title: { ...o.title, size: Math.max(32, Math.min(130, o.title.size + delta)) } }));
    else setDoc((o) => ({ ...o, captions: { ...o.captions, size: Math.max(40, Math.min(160, o.captions.size + delta)) } }));
  };
  const resetPos = (layer: 'title' | 'captions') => {
    if (layer === 'title') setDoc((o) => ({ ...o, title: { ...o.title, x: null, y: null } }));
    else setDoc((o) => ({ ...o, captions: { ...o.captions, x: null, y: null } }));
  };
  // Toolbar anchor (screen px) above the selected layer.
  const TOOLBAR_W = 330;
  const rawPos = sel === 'title'
    ? { x: offset.x + titleCx * scale, y: offset.y + (titleCy - (plateH * plateScale) / 2) * scale - 14 }
    : sel === 'captions'
      ? { x: offset.x + capX * scale, y: offset.y + (capY - capSize * 1.4) * scale - 14 }
      : null;
  const toolbarPos = rawPos && {
    x: Math.max(TOOLBAR_W / 2 + 8, Math.min(Math.max(wrap.w, TOOLBAR_W + 16) - TOOLBAR_W / 2 - 8, rawPos.x)),
    y: Math.max(44, rawPos.y),
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden" onPointerDown={() => setSelection(null)}>
      <style dangerouslySetInnerHTML={{ __html: fontFaces }} />
      <div
        ref={stageRef}
        className="absolute origin-top-left overflow-hidden rounded-[28px] bg-black shadow-[0_30px_80px_rgba(0,0,0,.6)] ring-1 ring-white/10"
        style={{ left: offset.x, top: offset.y, width: CANVAS_W, height: CANVAS_H, transform: `scale(${scale})` }}
        onPointerMove={onMove} onPointerUp={onUp}
      >
        {/* The footage. */}
        <video
          ref={videoRef}
          src={`/api/editor/${props.clipId}/media?kind=proxy`}
          preload="auto" playsInline
          className="absolute left-0 block"
          style={geo.kind === 'band'
            ? { top: geo.videoY, width: CANVAS_W, height: geo.videoH, objectFit: 'fill' }
            : { top: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
          onClick={(e) => { e.stopPropagation(); playback.toggle(); }}
        />
        {geo.kind === 'panes' && (
          <canvas ref={paneCanvas} width={CANVAS_W} height={CANVAS_H} className="absolute inset-0"
            onClick={(e) => { e.stopPropagation(); playback.toggle(); }} />
        )}
        {geo.panesPending && (
          <div className="absolute inset-x-0 top-[46%] text-center text-[40px] text-fg-2">
            <div className="mx-auto mb-4 h-2 w-72 overflow-hidden rounded-full bg-white/10"><div className="pulsing h-full w-1/3 rounded-full bg-accent" /></div>
            Finding the webcam and the chart…
          </div>
        )}

        {/* Title — the export's own PNG, centred on (x, y). */}
        {preview?.title && (
          <div className="absolute" style={{ left: titleCx - plateW / 2, top: titleCy - plateH / 2, width: plateW, height: plateH, transform: `scale(${plateScale})`, transformOrigin: 'center' }}>
            <img
              src={preview.title.url} alt="" draggable={false}
              onPointerDown={start('title', 'move')}
              onDoubleClick={(e) => { e.stopPropagation(); props.onEditTitleText(); }}
              className={`block h-full w-full cursor-grab select-none transition-opacity duration-200 active:cursor-grabbing ${titleVisible ? 'opacity-100' : 'opacity-25'}`}
            />
            {sel === 'title' && <Handles scale={scale * plateScale} onResize={start('title', 'resize')} />}
          </div>
        )}

        {/* Captions — the server's events, drawn live in the document's style. */}
        {doc.captions.enabled && (
          <div
            onPointerDown={start('captions', 'move')}
            className="absolute cursor-grab select-none text-center active:cursor-grabbing"
            style={{ left: capX, bottom: CANVAS_H - capY, transform: 'translateX(-50%)', minWidth: 420, minHeight: capSize * 1.2, padding: '0 24px',
              fontFamily: `"${doc.captions.font}"`, fontSize: capSize, lineHeight: 1.15, color: doc.captions.color,
              textShadow: '0 5px 9px rgba(0,0,0,.55)', fontWeight: 700 }}
          >
            {event ? event.lines.map((line, li) => (
              <div key={li} style={{ whiteSpace: 'pre' }}>
                {line.map((w, wi) => (
                  <span key={wi} style={{ color: w.active && doc.captions.mode === 'highlight' ? doc.captions.highlightColor : doc.captions.color }}>
                    {wi ? ' ' : ''}{w.text}
                  </span>
                ))}
              </div>
            )) : <div style={{ opacity: sel === 'captions' ? 0.35 : 0, whiteSpace: 'pre' }}>captions</div>}
            {sel === 'captions' && <Handles scale={scale} onResize={start('captions', 'resize')} />}
          </div>
        )}

        {props.pending && <div className="absolute right-8 top-8 h-4 w-4 animate-pulse rounded-full bg-accent/70" />}
        {preview?.empty && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-[44px] text-fg-2">Everything is cut — nothing to play</div>
        )}
      </div>

      {/* Floating glass toolbar for the selected layer (screen space, so it stays crisp). */}
      {sel && toolbarPos && (
        <div className="glass-strong rise absolute z-20 flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-full px-1.5 py-1 text-[12px] text-fg-1"
          style={{ left: toolbarPos.x, top: Math.max(8, toolbarPos.y) }}
          onPointerDown={(e) => e.stopPropagation()}>
          <span className="px-2 text-[11px] uppercase tracking-wider text-fg-3">{sel === 'title' ? 'Title' : 'Captions'}</span>
          <button onClick={() => bump(sel, -4)} className="pill h-7 w-7 grid place-items-center" title="Smaller"><Minus className="h-3.5 w-3.5" /></button>
          <span className="tabular w-10 text-center text-[11px]">{sel === 'title' ? doc.title.size : capSize}px</span>
          <button onClick={() => bump(sel, 4)} className="pill h-7 w-7 grid place-items-center" title="Bigger"><Plus className="h-3.5 w-3.5" /></button>
          <span className="mx-1 h-4 w-px bg-white/10" />
          {['#FFFFFF', '#111111', '#FFE500', '#EC0B7A'].map((c) => (
            <button key={c} title={c} onClick={() => sel === 'title' ? setDoc((o) => ({ ...o, title: { ...o.title, color: c } })) : setDoc((o) => ({ ...o, captions: { ...o.captions, color: c } }))}
              className="h-5 w-5 rounded-full border border-white/20 transition-transform hover:scale-110" style={{ background: c }} />
          ))}
          <span className="mx-1 h-4 w-px bg-white/10" />
          <button onClick={() => resetPos(sel)} className="pill h-7 w-7 grid place-items-center" title="Reset position"><RotateCcw className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </div>
  );
}

/**
 * Selection outline with a resize grip at the bottom-right corner. The layer lives in canvas
 * pixels under a CSS scale, so everything here is divided by that scale: the outline is 2
 * screen px and the grip 18 screen px whether the stage is a phone-sized column or a monitor.
 */
function Handles({ scale, onResize }: { scale: number; onResize: (e: React.PointerEvent) => void }) {
  const px = (n: number) => n / Math.max(0.05, scale);
  const border = `${px(2)}px solid var(--select)`;
  const dot = { width: px(10), height: px(10), border, background: '#fff', borderRadius: px(2) };
  return (
    <>
      {/* Everything sits INSIDE the layer's box: the stage clips at the canvas edge, and a layer
          pushed to that edge must keep its grip reachable. */}
      <div className="pointer-events-none absolute" style={{ inset: -px(2), border, borderRadius: px(6), boxShadow: `0 0 0 ${px(1)}px rgba(0,0,0,.35)` }} />
      <div className="pointer-events-none absolute" style={{ ...dot, top: -px(2), left: -px(2) }} />
      <div className="pointer-events-none absolute" style={{ ...dot, top: -px(2), right: -px(2) }} />
      <div className="pointer-events-none absolute" style={{ ...dot, bottom: -px(2), left: -px(2) }} />
      <div onPointerDown={onResize} title="Drag to resize" className="absolute cursor-nwse-resize"
        style={{ width: px(18), height: px(18), bottom: -px(2), right: -px(2), border, background: '#fff', borderRadius: px(3), boxShadow: `0 ${px(1)}px ${px(3)}px rgba(0,0,0,.4)` }} />
    </>
  );
}
