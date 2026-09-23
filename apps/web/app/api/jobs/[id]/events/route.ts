import { NextRequest } from 'next/server';
import db from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Server-Sent Events tailing the durable job_event log.
 *
 * Because every event is a row, reconnecting with ?after=<id> replays whatever was missed.
 * Close the tab mid-render, reopen it, and the log is intact — v1 polled a single
 * progress.json every 3s and a render reported nothing at all.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const after = Number(req.nextUrl.searchParams.get('after') || 0);

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let cursor = after;
      let closed = false;

      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      const tick = () => {
        if (closed) return;
        try {
          const rows = db.eventsSince(id, cursor);
          for (const r of rows) { cursor = r.id; send('progress', r); }
          const job = db.getJob(id);
          if (job) send('job', job);
          if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
            send('end', { status: job.status });
            closed = true;
            controller.close();
            return;
          }
        } catch {
          closed = true;
          try { controller.close(); } catch {}
          return;
        }
        setTimeout(tick, 400);
      };

      req.signal.addEventListener('abort', () => {
        closed = true;
        try { controller.close(); } catch {}
      });
      tick();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
