import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { fontCatalog, FONTS_DIR } from '@/lib/editor';

/** Font files for the editor's @font-face — only those in the catalog, never arbitrary paths. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const name = decodeURIComponent(file);
  const entry = fontCatalog().fonts.find((f) => f.file === name);
  if (!entry) return new Response('unknown font', { status: 404 });
  const p = path.join(FONTS_DIR, entry.file);
  if (!fs.existsSync(p)) return new Response('missing font file', { status: 404 });
  const type = /\.otf$/i.test(entry.file) ? 'font/otf' : 'font/ttf';
  return new Response(fs.readFileSync(p), {
    headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}
