import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getClipAndSource, currentDoc, proxyState, insideRoot } from '@/lib/editor';

/** Waveform peaks for the timeline — produced next to the proxy by the worker. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ clipId: string }> }) {
  const { clipId } = await ctx.params;
  const found = getClipAndSource(clipId);
  if (!found) return NextResponse.json({ error: 'clip not found' }, { status: 404 });
  const { clip, source } = found;
  const proxy = proxyState(clip, source, currentDoc(clip).range);
  if (!proxy.ready || !proxy.manifest || !insideRoot(proxy.manifest.peaks) || !fs.existsSync(proxy.manifest.peaks)) {
    return NextResponse.json({ error: 'peaks not ready' }, { status: 404 });
  }
  return new Response(fs.readFileSync(proxy.manifest.peaks), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
