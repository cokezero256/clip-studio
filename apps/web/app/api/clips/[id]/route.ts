import { NextResponse } from 'next/server';
import db from '@/lib/db';

/**
 * Clips for a source, each joined to its MOST RECENT render.
 *
 * Renders are rows rather than overwritten files, so a clip can have several. The UI shows
 * the latest; the history stays queryable instead of being lost the way v1 lost it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const clips = db.getDb().prepare(`
    SELECT c.*,
           r.id     AS render_id,
           r.passed AS render_passed,
           r.bytes  AS render_bytes
    FROM clip c
    LEFT JOIN render r ON r.id = (
      SELECT id FROM render WHERE clip_id = c.id ORDER BY created_at DESC LIMIT 1
    )
    WHERE c.source_id = ?
    ORDER BY
      CASE c.verdict WHEN 'ship' THEN 0 WHEN 'maybe' THEN 1 WHEN 'cut' THEN 2 ELSE 3 END,
      c.corpus_score DESC,
      c.rank
  `).all(id);
  return NextResponse.json({ clips, source: db.getSource(id) });
}
