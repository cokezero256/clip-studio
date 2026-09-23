import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';

const DATA_ROOT = path.resolve(process.cwd(), '..', '..', 'data');

/** Serve a downloaded outlier reel or its poster frame, by shortcode. */
export async function GET(req: NextRequest) {
  const sc = req.nextUrl.searchParams.get('sc');
  const kind = req.nextUrl.searchParams.get('kind') || 'video';
  if (!sc) return new Response('shortcode required', { status: 400 });

  const row = db.getDb().prepare('SELECT media_dir FROM post WHERE shortcode=?').get(sc) as
    { media_dir?: string } | undefined;
  if (!row?.media_dir) return new Response('not downloaded', { status: 404 });

  const dir = path.resolve(row.media_dir);
  if (!dir.startsWith(DATA_ROOT)) return new Response('forbidden', { status: 403 });

  const file = kind === 'poster'
    ? path.join(dir, 'frames', 'f02.jpg')
    : path.join(dir, 'source.mp4');
  if (!fs.existsSync(file)) return new Response('missing', { status: 404 });

  const size = fs.statSync(file).size;
  const type = kind === 'poster' ? 'image/jpeg' : 'video/mp4';
  const range = req.headers.get('range');

  if (!range || kind === 'poster') {
    return new Response(fs.createReadStream(file) as unknown as ReadableStream, {
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m && m[1] ? parseInt(m[1], 10) : 0;
  const end = m && m[2] ? parseInt(m[2], 10) : Math.min(start + 4 * 1024 * 1024, size - 1);
  return new Response(fs.createReadStream(file, { start, end }) as unknown as ReadableStream, {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
