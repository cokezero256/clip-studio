'use client';

import { useCallback, useRef, useState } from 'react';
import type { Doc } from './types';

type Updater = (d: Doc) => Doc;

/**
 * The document plus undo/redo.
 *
 * Every `set` is one history entry, EXCEPT consecutive sets sharing a `coalesce` key — a
 * slider drag, typing a title, dragging the caption block — which fold into the previous
 * entry so ⌘Z undoes the whole gesture, not one pixel of it. A gesture ends when the key
 * changes, when `endGesture()` is called (pointer up), or after 5 s of silence. It is NOT a
 * short time window: a drag whose pointer moves arrive slowly (measured with automation)
 * split into several entries under a 600 ms rule.
 *
 * All bookkeeping happens OUTSIDE React's state-updater callbacks. In development, StrictMode
 * invokes updaters twice, and a first version that pushed history inside them recorded
 * duplicate entries: a single title drag needed three undos and a switch appeared not to
 * toggle. The current document is mirrored in a ref so successive sets in one tick compose.
 */
export function useEditorDoc(initial: Doc) {
  const [doc, setDocState] = useState<Doc>(initial);
  const docRef = useRef<Doc>(initial);
  const past = useRef<Doc[]>([]);
  const future = useRef<Doc[]>([]);
  const lastKey = useRef<string | null>(null);
  const lastAt = useRef(0);
  const savedRef = useRef<Doc>(initial);
  const [, bump] = useState(0);

  const commit = useCallback((next: Doc) => {
    docRef.current = next;
    setDocState(next);
    bump((n) => n + 1);
  }, []);

  const set = useCallback((updater: Updater | Doc, opts: { coalesce?: string } = {}) => {
    const prev = docRef.current;
    const next = typeof updater === 'function' ? (updater as Updater)(prev) : updater;
    if (next === prev) return;
    const now = Date.now();
    const sameGesture = !!opts.coalesce && lastKey.current === opts.coalesce && now - lastAt.current < 5000;
    if (!sameGesture) {
      past.current.push(prev);
      if (past.current.length > 200) past.current.shift();
    }
    future.current = [];
    lastKey.current = opts.coalesce ?? null;
    lastAt.current = now;
    commit(next);
  }, [commit]);

  /** Close the current gesture: the next `set`, even with the same key, starts a new entry. */
  const endGesture = useCallback(() => { lastKey.current = null; }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(docRef.current);
    lastKey.current = null;
    commit(prev);
  }, [commit]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(docRef.current);
    lastKey.current = null;
    commit(next);
  }, [commit]);

  /** Replace the document without touching history (a server conflict resolution). */
  const replace = useCallback((next: Doc) => {
    past.current = [];
    future.current = [];
    lastKey.current = null;
    savedRef.current = next;
    commit(next);
  }, [commit]);

  const markSaved = useCallback((saved: Doc) => { savedRef.current = saved; bump((n) => n + 1); }, []);

  return {
    doc, set, undo, redo, replace, markSaved, endGesture,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    dirty: savedRef.current !== doc,
    history: () => ({ past: past.current.length, future: future.current.length }),
  };
}
