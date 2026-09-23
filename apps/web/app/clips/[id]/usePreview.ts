'use client';

import { useEffect, useRef, useState } from 'react';
import type { Doc, Preview } from './types';

/**
 * Ask the server what this document looks like: snapped spans, caption events in output
 * time, the title plate PNG and its geometry. Debounced so a slider drag sends one request,
 * aborted when superseded, and the last good result is kept while the next one is in flight —
 * the video never blanks while a control is being dragged.
 */
export function usePreview(clipId: string, doc: Doc, enabled: boolean) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setPending(true);
      try {
        const r = await fetch(`/api/editor/${clipId}/preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ doc }), signal: ac.signal,
        });
        const body = await r.json();
        if (ac.signal.aborted) return;
        if (!r.ok) { setError(body.error || `preview failed (${r.status})`); return; }
        setPreview(body as Preview);
        setError(null);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(String((e as Error).message));
      } finally {
        if (!ac.signal.aborted) setPending(false);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [clipId, doc, enabled]);

  return { preview, pending, error };
}
