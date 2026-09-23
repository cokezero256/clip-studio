import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getClipAndSource, currentDoc, proxyState, streamFile, insideRoot } from '@/lib/editor';

/**
 * The editor's media: the preview proxy (Range-streamed) and title plate PNGs.
 * Paths come from database rows and a strict basename pattern — never from the query.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ clipId: string }> }) {
  const { clipId } = await ctx.params;
  const found = getClipAndSource(clipId);
  if (!found) return new Response('not found', { status: 404 });
  const { clip, source } = found;
  const kind = req.nextUrl.searchParams.get('kind');

  if (kind === 'proxy') {
    const doc = currentDoc(clip);
    const proxy = proxyState(clip, source, doc.range);
    if (!proxy.ready || !proxy.manifest) return new Response('proxy not ready', { status: 404 });
    return streamFile(req, proxy.manifest.video, 'video/mp4');
  }

  if (kind === 'filmstrip') {
    const doc = currentDoc(clip);
    const proxy = proxyState(clip, source, doc.range);
    const strip = proxy.ready && proxy.manifest ? proxy.manifest.filmstrip : null;
    if (!strip || !insideRoot(strip.path) || !fs.existsSync(strip.path)) return new Response('filmstrip not ready', { status: 404 });
    return new Response(fs.readFileSync(strip.path), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });
  }

  if (kind === 'plate') {
    const f = req.nextUrl.searchParams.get('f') || '';
    if (!/^title-[0-9a-f]{12}\.png$/.test(f) || !source.work_dir) return new Response('bad plate', { status: 400 });
    const file = path.join(source.work_dir, 'editor', clip.id, 'plates', f);
    if (!insideRoot(file) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(file), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  }

  return new Response('kind must be proxy or plate', { status: 400 });
}
