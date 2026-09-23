import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import {
  getClipAndSource, loadTranscript, openingDoc, pausesFor, proxyState, sourceMeta, geometryFor,
  activeJobFor, workerStatus, saveDoc, fontCatalog, docLib, compositionFor, listFormats,
} from '@/lib/editor';

/**
 * Everything the editor needs to open one clip, in a single round trip.
 *
 * The words returned are those inside the PREVIEW WINDOW (the clip's range padded by the
 * proxy's 30 s each side), not the whole 10k-word transcript — the editor must be able to
 * drag a trim handle outward into real footage, and nothing more is needed on screen.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ clipId: string }> }) {
  try {
    return await loadEditor(ctx);
  } catch (err) {
    // An empty 500 hides the cause; the editor shows this message in its error state.
    return NextResponse.json({ error: `editor load failed: ${String((err as Error).message).slice(0, 400)}` }, { status: 500 });
  }
}

async function loadEditor(ctx: { params: Promise<{ clipId: string }> }) {
  const { clipId } = await ctx.params;
  const found = getClipAndSource(clipId);
  if (!found) return NextResponse.json({ error: 'clip not found' }, { status: 404 });
  const { clip, source } = found;

  const transcript = loadTranscript(source);
  if (!transcript) {
    return NextResponse.json({ error: 'this source has no transcript on disk — process it again' }, { status: 400 });
  }
  const doc = openingDoc(clip, source, transcript);
  const proxy = proxyState(clip, source, doc.range);
  const meta = await sourceMeta(source, proxy.manifest);

  const windowStart = proxy.ready ? proxy.origin : Math.max(0, doc.range.start - 30);
  const windowEnd = proxy.ready ? proxy.origin + proxy.duration : doc.range.end + 30;
  const words = docLib.wordsInWindow(doc, transcript, windowStart, windowEnd);

  const renders = db.listRenders(clip.id);
  const activeRender = activeJobFor(clip.id, 'render-clip') || null;

  // Neighbouring picks, for prev/next.
  const siblings = db.getDb().prepare(
    `SELECT id, start_s, hook, verdict FROM clip WHERE source_id=? AND ready=1 AND (verdict IS NULL OR verdict!='cut')
     ORDER BY CASE verdict WHEN 'ship' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END, corpus_score DESC, rank`,
  ).all(clip.source_id) as Array<{ id: string; start_s: number; hook: string | null; verdict: string | null }>;

  const { manifest, ...proxyPublic } = proxy;
  void manifest;
  return NextResponse.json({
    clip: {
      id: clip.id, source_id: clip.source_id, start_s: clip.start_s, end_s: clip.end_s,
      title_text: clip.title_text, verdict: clip.verdict, corpus_score: clip.corpus_score,
      hook: clip.hook, updatedAt: clip.edit_updated_at,
    },
    source: { id: source.id, title: source.title, duration_s: source.duration_s, fps: meta.fps, width: meta.width, height: meta.height },
    doc,
    words,
    pauses: pausesFor(source, transcript, windowStart, windowEnd),
    window: { start: windowStart, end: windowEnd },
    proxy: proxyPublic,
    geometry: geometryFor(meta.width, meta.height),
    formats: listFormats(),
    composition: compositionFor(clip),
    fonts: fontCatalog().fonts,
    renders,
    activeRender,
    worker: workerStatus(),
    siblings,
  });
}

/** Save the document. 409 when another tab saved first (the response carries theirs). */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ clipId: string }> }) {
  const { clipId } = await ctx.params;
  const found = getClipAndSource(clipId);
  if (!found) return NextResponse.json({ error: 'clip not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const r = saveDoc(found.clip, body.doc, body.baseUpdatedAt);
  if (r.conflict) return NextResponse.json({ error: 'changed elsewhere', doc: r.doc, updatedAt: r.updatedAt }, { status: 409 });
  return NextResponse.json({ doc: r.doc, updatedAt: r.updatedAt });
}
