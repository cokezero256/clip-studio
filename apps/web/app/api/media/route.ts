import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';

const DATA_ROOT = path.resolve(process.cwd(), '..', '..', 'data');

/**
 * Range-streaming media server.
 *
 * Paths are resolved from DB rows, never from the query string, and the resolved path must
 * still sit inside the data root — a render path is not a user-supplied file path.
 */
export async function GET(req: NextRequest) {
  const renderId = req.nextUrl.searchParams.get('render');
  if (!renderId) return new Response('render id required', { status: 400 });

  const row = db.getDb().prepare('SELECT path FROM render WHERE id=?').get(renderId) as { path?: string } | undefined;
  if (!row?.path) return new Response('not found', { status: 404 });

  const filePath = path.resolve(row.path);
  if (!filePath.startsWith(DATA_ROOT) && !filePath.startsWith('/tmp/')) {
    return new Response('forbidden', { status: 403 });
  }
  if (!fs.existsSync(filePath)) return new Response('file missing', { status: 404 });

  const size = fs.statSync(filePath).size;
  const range = req.headers.get('range');

  if (!range) {
    return new Response(fs.createReadStream(filePath) as unknown as ReadableStream, {
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    });
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m && m[1] ? parseInt(m[1], 10) : 0;
  const end = m && m[2] ? parseInt(m[2], 10) : Math.min(start + 4 * 1024 * 1024, size - 1);

  return new Response(fs.createReadStream(filePath, { start, end }) as unknown as ReadableStream, {
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
