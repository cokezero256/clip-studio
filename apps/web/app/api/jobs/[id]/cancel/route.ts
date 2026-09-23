import { NextResponse } from 'next/server';
import db from '@/lib/db';

/** Cancel is a flag the worker observes — the web process never signals a child itself. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  db.requestCancel(id);
  return NextResponse.json({ ok: true });
}
