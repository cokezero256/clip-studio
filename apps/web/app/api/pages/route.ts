import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

/**
 * Add a trading account to the corpus.
 *
 * Accepts "@handle", "handle" or a profile URL. The page row is created and a scrape of
 * just that page is queued, so the gallery fills in without waiting for the weekly refresh.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const raw = String(body.username || '').trim();
  const m = raw.match(/(?:instagram\.com\/)?@?([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/);
  const username = m ? m[1].toLowerCase() : null;
  if (!username) return NextResponse.json({ error: 'that does not look like an Instagram handle' }, { status: 400 });

  const page = db.upsertPage({ username, vertical: 'trading', label: body.label || null });
  const jobId = db.enqueue({
    type: 'outliers',
    payload: { pages: [username], days: Number(body.days ?? 60), maxDownloads: Number(body.maxDownloads ?? 12), classify: true },
  });
  return NextResponse.json({ page, jobId });
}

export async function GET() {
  return NextResponse.json({ pages: db.listPages() });
}
