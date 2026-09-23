import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import db from '@/lib/db';

export const maxDuration = 120;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateVerifiedTitles } = require('@clip-studio/engine/src/titles/generate');

/**
 * Suggest burned-in titles for one clip.
 *
 * Grounded on the outlier corpus — winners AND flops, because without duds the model
 * learns "a trading title" rather than what separates one that worked from one that
 * didn't. Every candidate is then gated against this clip's own transcript.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const clip = db.getClip(id);
  if (!clip) return NextResponse.json({ error: 'clip not found' }, { status: 404 });

  const source = db.getSource(clip.source_id);
  if (!source?.audio_path) return NextResponse.json({ error: 'no transcript for this source' }, { status: 400 });

  const tPath = `${source.audio_path}.transcript.json`;
  if (!fs.existsSync(tPath)) return NextResponse.json({ error: 'transcript missing on disk' }, { status: 400 });

  const transcript = JSON.parse(fs.readFileSync(tPath, 'utf-8'));
  const text = (transcript.words || [])
    .filter((w: { start: number; end: number }) => w.end > clip.start_s && w.start < clip.end_s)
    .map((w: { word: string }) => w.word)
    .join(' ');

  if (text.trim().length < 40) {
    return NextResponse.json({ error: 'clip has too little speech to title' }, { status: 400 });
  }

  const exemplars = db.getDb().prepare(
    `SELECT ocr_title, display_mult FROM post
     WHERE ocr_title IS NOT NULL AND z >= 0.8 ORDER BY z DESC LIMIT 8`).all();
  const flops = db.getDb().prepare(
    `SELECT ocr_title, display_mult FROM post
     WHERE ocr_title IS NOT NULL AND z < -0.3 ORDER BY z LIMIT 4`).all();

  try {
    const r = await generateVerifiedTitles({ transcriptText: text, exemplars, flops });
    return NextResponse.json({
      accepted: r.accepted, rejected: r.rejected, provider: r.provider,
      groundedOn: { winners: exemplars.length, flops: flops.length },
    });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message).slice(0, 400) }, { status: 502 });
  }
}

/** Save the chosen title onto the clip. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  db.getDb().prepare('UPDATE clip SET title_text=? WHERE id=?').run(body.title ?? null, id);
  return NextResponse.json({ ok: true });
}
