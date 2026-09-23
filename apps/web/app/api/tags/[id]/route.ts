import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const tag = db.updateTag(id, { name: body.name, color: body.color });
  if (!tag) return NextResponse.json({ error: 'tag not found' }, { status: 404 });
  return NextResponse.json({ tag });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const changes = db.deleteTag(id);
  return NextResponse.json({ ok: changes > 0 });
}
