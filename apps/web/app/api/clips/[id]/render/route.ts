import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

/**
 * Render one clip on demand.
 *
 * The corpus verdict is advice, not a veto — an editor must be able to render a moment the
 * ranker dismissed. Without this, a source where everything was rated "cut" shows nothing
 * but empty cards with no way to act.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const clip = db.getClip(id);
  if (!clip) return NextResponse.json({ error: 'clip not found' }, { status: 404 });

  const jobId = db.enqueue({
    type: 'render-clip',
    payload: {
      clipId: id,
      paneOrder: body.paneOrder ?? 'screen-top',
      styleId: body.styleId ?? 'sequel-viral',
      // undefined = keep whatever is saved; a string (including '') = set it.
      ...(body.title !== undefined ? { title: body.title } : {}),
    },
    sourceId: clip.source_id,
  });
  return NextResponse.json({ jobId });
}
