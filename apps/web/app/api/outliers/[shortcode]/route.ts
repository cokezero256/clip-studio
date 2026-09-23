import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

/** Human correction of the classifier. A label set here always beats the model's guess. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ shortcode: string }> }) {
  const { shortcode } = await ctx.params;
  const body = await req.json();
  if (typeof body.format_label === 'string') {
    db.setFormatLabel(shortcode, body.format_label);
  }
  return NextResponse.json({ ok: true });
}
