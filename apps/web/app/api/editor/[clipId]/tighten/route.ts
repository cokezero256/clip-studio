import { NextRequest, NextResponse } from 'next/server';
import { getClipAndSource, loadTranscript, docLib, pausesFor, tightenLib } from '@/lib/editor';

/**
 * Take the dead air out of a document: pauses longer than `maxPause` inside the kept
 * footage become cuts (with air left at each join), word-less slivers go, quiet words are
 * fenced off. Returns the new cut list; the editor applies it as one undoable step.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ clipId: string }> }) {
  const { clipId } = await ctx.params;
  const found = getClipAndSource(clipId);
  if (!found) return NextResponse.json({ error: 'clip not found' }, { status: 404 });
  const { clip, source } = found;
  const transcript = loadTranscript(source);
  if (!transcript) return NextResponse.json({ error: 'no transcript' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const doc = docLib.normalizeDoc(body.doc, clip);
  const maxPause = Math.max(0.15, Math.min(2, Number(body.maxPause) || 0.35));
  const pauses = pausesFor(source, transcript, doc.range.start - 1, doc.range.end + 1);
  const r = tightenLib.tightenCuts(doc, pauses, transcript.words, { maxPause });
  return NextResponse.json({
    cuts: r.doc.cuts, added: r.added.length, removedSeconds: r.removedSeconds,
    remaining: tightenLib.deadAir(r.doc, pauses, { maxPause }),
  });
}
