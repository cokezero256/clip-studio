import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

export async function GET() {
  return NextResponse.json({ tags: db.listTags() });
}

/** Create a tag (or return the existing one with that name — names are unique, case-insensitive). */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    const tag = db.createTag({ name: body.name, color: body.color });
    return NextResponse.json({ tag });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message) }, { status: 400 });
  }
}
