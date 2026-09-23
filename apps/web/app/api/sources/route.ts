import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

export async function GET() {
  return NextResponse.json({ sources: db.listSources(), jobs: db.listJobs(12) });
}

/** Queue a job. The web process does no work itself — the worker picks this up. */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const input = String(body.input || '').trim();
  if (!input) return NextResponse.json({ error: 'input is required' }, { status: 400 });

  const jobId = db.enqueue({
    type: 'process',
    payload: {
      input,
      clientId: body.clientId ?? null,
      format: body.format ?? 'vertical',
      layout: body.layout ?? 'auto',
      styleId: body.styleId ?? 'open-sans-viral',
      maxRender: Number(body.maxRender ?? 3),
      // Set when the job was started from an outlier — carries that clip's measured shape.
      paneOrder: body.paneOrder ?? null,
      selectOptions: body.selectOptions ?? {},
      referenceShortcode: body.referenceShortcode ?? null,
    },
  });
  return NextResponse.json({ jobId });
}
