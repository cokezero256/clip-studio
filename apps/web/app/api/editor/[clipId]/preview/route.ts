import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import {
  getClipAndSource, loadTranscript, proxyState, sourceMeta, docLib, bandClip, compositionFor, ensurePanesJob, paneGeo,
} from '@/lib/editor';

/* eslint-disable @typescript-eslint/no-require-imports */
const phrases = require('@clip-studio/engine/src/captions/phrases');
const { applyCase } = require('@clip-studio/engine/src/captions/ass-generator');
const styles = require('@clip-studio/engine/src/captions/style-store');
/* eslint-enable @typescript-eslint/no-require-imports */

export const maxDuration = 30;

/**
 * Derive what the preview must draw from a document — the same way the export does.
 *
 * Parity by construction: spans come from `snapSpans`, captions from `phrases.js`, case from
 * ass-generator's `applyCase`, and the title is the very PNG `renderBandClip` will overlay.
 * The browser positions these; it never re-implements them.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ clipId: string }> }) {
  const { clipId } = await ctx.params;
  const found = getClipAndSource(clipId);
  if (!found) return NextResponse.json({ error: 'clip not found' }, { status: 404 });
  const { clip, source } = found;
  const transcript = loadTranscript(source);
  if (!transcript) return NextResponse.json({ error: 'no transcript' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const doc = docLib.normalizeDoc(body.doc, clip);
  const proxy = proxyState(clip, source, doc.range);
  const meta = await sourceMeta(source, proxy.manifest);

  // Geometry for ANY format. Re-composed ones need the detected pane regions; until the
  // worker has found them the preview says so instead of guessing.
  const variant = doc.format.variant;
  const composition = compositionFor(clip);
  let G: ReturnType<typeof paneGeo.layoutGeometry>;
  let panesPending: string | null = null;
  if (!paneGeo.isBandVariant(variant) && !composition) {
    panesPending = source.video_path ? ensurePanesJob(source, clip) : null;
    G = paneGeo.layoutGeometry('band-title-top', { srcW: meta.width, srcH: meta.height });
  } else {
    G = paneGeo.layoutGeometry(variant, { composition, srcW: meta.width, srcH: meta.height });
  }
  const layout = { canvas: G.canvas, background: '#000000', title: { fontSize: G.titleFontSize }, caption: { fontSize: G.captionFontSize } };
  const geo = G.kind === 'band'
    ? { ...G.band, titleY: G.titleY, captionY: G.captionY }
    : { x: 0, y: 0, w: G.canvas.width, h: G.canvas.height, titleY: G.titleY, captionY: G.captionY };

  const p = docLib.docToRenderParams(doc, transcript);
  const snapped = bandClip.snapSpans(p.spans, meta.fps);
  const outWords = bandClip.mapWordsToOutput(p.words, snapped);

  const captionSize = doc.captions.size;
  const maxLineChars = Math.max(8, Math.floor((layout.canvas.width * 0.9) / (captionSize * 0.6)));
  const rawEvents = doc.captions.enabled
    ? (doc.captions.mode === 'highlight'
      ? phrases.highlightEvents(outWords, { maxLineChars })
      : phrases.wordEvents(outWords))
    : [];
  const events = rawEvents.map((e: { start: number; end: number; lines: Array<Array<{ text: string; active: boolean }>> }) => ({
    ...e,
    lines: e.lines.map((line) => line.map((w) => ({ ...w, text: applyCase(w.text, doc.captions.case) }))),
  }));

  // The title plate — exactly what the export overlays.
  let title: null | { url: string; width: number; height: number; x: number; y: number; size: number } = null;
  if (doc.title.text && source.work_dir) {
    const platesDir = path.join(source.work_dir, 'editor', clip.id, 'plates');
    const style = styles.loadStyle('sequel-viral');
    const plate = bandClip.titlePlateFor({
      titleText: p.titleText, titleStyle: p.titleStyle, style, layout, geo, outDir: platesDir,
    });
    if (plate) {
      title = {
        url: `/api/editor/${clip.id}/media?kind=plate&f=${encodeURIComponent(path.basename(plate.path))}`,
        width: plate.width, height: plate.height, x: plate.x, y: plate.y,
        // The size the PNG was drawn at — the stage scales it live while a resize is in flight.
        size: doc.title.size,
      };
      prunePlates(platesDir, 50);
    }
  }

  return NextResponse.json({
    duration: snapped.durationSeconds,
    spans: snapped.spans.map((s: { a: number; b: number; outStart: number }) => ({ a: s.a, b: s.b, outStart: s.outStart })),
    empty: snapped.spans.length === 0,
    events,
    captions: {
      enabled: doc.captions.enabled,
      font: doc.captions.font, size: captionSize, color: doc.captions.color,
      highlightColor: doc.captions.highlightColor, y: doc.captions.y ?? geo.captionY,
      x: doc.captions.x ?? layout.canvas.width / 2,
    },
    title: title && { ...title, hold: doc.title.hold },
    geometry: {
      kind: G.kind, videoY: G.kind === 'band' ? geo.y : 0, videoH: G.kind === 'band' ? geo.h : 0,
      titleY: geo.titleY, captionY: geo.captionY,
      // Pane rectangles for the canvas preview: `visible` is the part of the SOURCE frame to
      // draw (normalised 0–1, so any proxy size works), `dst` is where it goes on the canvas.
      panes: G.kind === 'panes' ? G.panes.map((pn: { id: string; visible: { x: number; y: number; w: number; h: number }; dst: { x: number; y: number; w: number; h: number } }) => ({
        id: pn.id,
        visible: { x: pn.visible.x / meta.width, y: pn.visible.y / meta.height, w: pn.visible.w / meta.width, h: pn.visible.h / meta.height },
        dst: pn.dst,
      })) : null,
      panesPending,
    },
    fps: meta.fps,
  });
}

/** Keep the plate cache bounded: every distinct title/style renders a new PNG. */
function prunePlates(dir: string, keep: number) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
  } catch { /* no dir yet */ }
}
