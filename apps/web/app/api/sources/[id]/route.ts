import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

/**
 * Delete a stream: its clips, renders, tags, jobs and its media folder on disk.
 *
 * If a job is still running for it, the web process cannot pull files from under the
 * worker's ffmpeg/whisper: it asks the job to cancel and marks the source `deleting`; the
 * worker finishes the deletion the moment the job stops (see runJob in the worker). The
 * dashboard shows the source as "deleting…" until it is gone.
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const source = db.getSource(id);
  if (!source) return NextResponse.json({ error: 'source not found' }, { status: 404 });

  const active = db.activeJobsForSource(id) as Array<{ id: string; type: string; status: string }>;
  if (active.length) {
    for (const j of active) db.requestCancel(j.id);
    db.updateSource(id, { status: 'deleting' });
    return NextResponse.json({
      deleting: true,
      message: `Stopping ${active.map((j) => j.type).join(', ')} first — the files go as soon as it stops.`,
    }, { status: 202 });
  }

  const r = db.deleteSource(id);
  return NextResponse.json({ deleted: true, ...r });
}
