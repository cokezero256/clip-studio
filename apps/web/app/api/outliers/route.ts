import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const rows = db.listOutliers({
    targetOnly: sp.get('all') !== '1',
    minZ: sp.get('minZ') ? Number(sp.get('minZ')) : null,
    page: sp.get('page') || null,
    topic: sp.get('topic') || null,
    layout: sp.get('layout') || null,
    downloadedOnly: sp.get('includePending') !== '1',
    limit: Number(sp.get('limit') || 200),
  });
  // Tags: the team's own labels. Filtering happens here rather than in the SQL so the
  // corpus query stays exactly what the clips-only definition says.
  const tagFilter = sp.get('tag') || null;
  const tagMap = db.tagsForPosts(rows.map((r: { shortcode: string }) => r.shortcode)) as Record<string, string[]>;
  const filtered = tagFilter ? rows.filter((r: { shortcode: string }) => (tagMap[r.shortcode] || []).includes(tagFilter)) : rows;
  return NextResponse.json({
    outliers: filtered.map((r: { shortcode: string }) => ({ ...r, tags: tagMap[r.shortcode] || [] })),
    pages: db.listPages(),
    layouts: db.layoutCounts(),
    allTags: db.listTags(),
  });
}

/** Queue a corpus refresh. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const jobId = db.enqueue({
    type: 'outliers',
    payload: {
      pages: body.pages ?? null,
      days: Number(body.days ?? 60),
      maxDownloads: Number(body.maxDownloads ?? 8),
      classify: body.classify !== false,
    },
  });
  return NextResponse.json({ jobId });
}
