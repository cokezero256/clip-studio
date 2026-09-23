import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { getClipAndSource, saveDoc, activeJobFor, workerStatus } from '@/lib/editor';

/**
 * Save the document, then render it. The worker's render-clip job reads `clip.edit_json`,
 * so what the editor previewed is what gets burned in. One render per clip at a time: a
 * second request attaches to the running job instead of queueing a duplicate.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ clipId: string }> }) {
  const { clipId } = await ctx.params;
  const found = getClipAndSource(clipId);
  if (!found) return NextResponse.json({ error: 'clip not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));

  // The save stamps a new edit_updated_at; the editor must learn it, or its next autosave
  // reads as a conflict from "another tab".
  let updatedAt: string | null = found.clip.edit_updated_at ?? null;
  if (body.doc) {
    const r = saveDoc(found.clip, body.doc, body.baseUpdatedAt);
    if (r.conflict) return NextResponse.json({ error: 'changed elsewhere', doc: r.doc, updatedAt: r.updatedAt }, { status: 409 });
    updatedAt = r.updatedAt;
  }
  const running = activeJobFor(clipId, 'render-clip');
  if (running) return NextResponse.json({ error: 'already rendering', jobId: running.id, updatedAt }, { status: 409 });

  const worker = workerStatus();
  const jobId = db.enqueue({
    type: 'render-clip', sourceId: found.clip.source_id,
    payload: { clipId, styleId: body.styleId || 'sequel-viral' },
  });
  return NextResponse.json({ jobId, worker, updatedAt });
}
