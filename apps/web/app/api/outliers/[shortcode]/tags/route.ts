import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

/** Set a post's tags to exactly the given ids. */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ shortcode: string }> }) {
  const { shortcode } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.tagIds) ? body.tagIds.filter((x: unknown) => typeof x === 'string') : [];
  const tags = db.setPostTags(shortcode, ids);
  return NextResponse.json({ shortcode, tags });
}
