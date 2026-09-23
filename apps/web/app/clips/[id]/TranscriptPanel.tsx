'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { Doc, Selection, Span, WordRow } from './types';
import { fmtTime } from './types';
import { useTick, type Playback } from './usePlayback';

/**
 * The transcript as an editing surface.
 *
 * Click a word to jump to it. Drag across words, or shift-click, to select a run and press
 * ⌫ to cut the footage under them (H hides just their captions). Double-click a word to fix
 * what the caption says — whisper's "Vic's" becomes "VIX" — which changes ONLY the caption,
 * never the audio. Struck-through words are cut; click one to restore that cut.
 *
 * The selection is the editor's: the same words light up on the timeline's Words track.
 */
export default function TranscriptPanel(props: {
  doc: Doc;
  words: WordRow[];
  spans: Span[];
  playback: Playback;
  setDoc: (u: (d: Doc) => Doc, o?: { coalesce?: string }) => void;
  selection: Selection;
  setSelection: (s: Selection) => void;
  cutSelection: () => void;
}) {
  const { doc, words, spans, playback, setDoc, selection, setSelection } = props;
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef(0);
  const selected = useMemo(() => new Set(selection?.kind === 'words' ? selection.is : []), [selection]);
  const kept = useMemo(() => words.filter((w) => w.inRange && !w.cut), [words]);
  const keptBetween = (a: number, b: number) => kept.filter((w) => w.i >= Math.min(a, b) && w.i <= Math.max(a, b)).map((w) => w.i);
  // Drag-to-select: the anchor word and whether the pointer has moved onto another word.
  // No pointer capture here — capturing retargets pointerup to the list, and the browser
  // then never delivers `click` to the word span, which is what a plain click-to-jump uses.
  const drag = useRef<{ anchor: number; moved: boolean } | null>(null);
  const suppressClickUntil = useRef(0);

  const time = useTick(playback);
  // Active word: the kept word whose start is the latest one at/before the playhead.
  const activeIdx = useMemo(() => {
    let s = -1;
    for (const sp of spans) { const len = sp.b - sp.a; if (time >= sp.outStart && time < sp.outStart + len) { s = sp.a + (time - sp.outStart); break; } }
    if (s < 0) return -1;
    let best = -1;
    for (const w of words) { if (w.inRange && !w.cut && !w.hidden && w.start <= s + 0.02) best = w.i; else if (w.start > s) break; }
    return best;
  }, [time, spans, words]);

  useEffect(() => {
    if (activeIdx < 0 || Date.now() - userScrolledAt.current < 3000) return;
    const el = listRef.current?.querySelector(`[data-i="${activeIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx]);

  // Paragraphs: break on a sentence end + gap, or a long gap.
  const paragraphs = useMemo(() => {
    const out: WordRow[][] = [];
    let cur: WordRow[] = [];
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      const prev = cur[cur.length - 1];
      if (prev) {
        const gap = w.start - prev.end;
        const sentence = /[.!?…]["')\]]?$/.test(prev.text);
        if ((sentence && gap > 0.7) || gap > 1.5 || cur.length >= 60) { out.push(cur); cur = []; }
      }
      cur.push(w);
    }
    if (cur.length) out.push(cur);
    return out;
  }, [words]);

  const q = query.trim().toLowerCase();
  const matches = (w: WordRow) => q && w.text.toLowerCase().includes(q);

  const clickWord = (w: WordRow, e: React.MouseEvent) => {
    if (Date.now() < suppressClickUntil.current) return;   // the drag that just ended already selected
    if (e.shiftKey && selected.size) {
      const lo = Math.min(...selected, w.i), hi = Math.max(...selected, w.i);
      setSelection({ kind: 'words', is: keptBetween(lo, hi) });
      return;
    }
    if (w.cut) {
      // Restore the cut that swallowed this word.
      setDoc((d) => ({ ...d, cuts: d.cuts.filter((k) => !(w.start >= k.start && w.start < k.end)) }));
      return;
    }
    setSelection({ kind: 'words', is: [w.i] });
    playback.seekSource(w.start);
  };
  const wordUnder = (e: React.PointerEvent): number | null => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-i]') as HTMLElement | null;
    return el ? +el.dataset.i! : null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    userScrolledAt.current = Date.now();
    if (e.button !== 0 || e.shiftKey) return;
    const i = wordUnder(e);
    if (i == null) return;
    drag.current = { anchor: i, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const i = wordUnder(e);
    if (i == null || (!d.moved && i === d.anchor)) return;
    d.moved = true;
    setSelection({ kind: 'words', is: keptBetween(d.anchor, i) });
  };
  const onPointerUp = () => {
    if (drag.current?.moved) suppressClickUntil.current = Date.now() + 300;   // pointerup precedes click
    drag.current = null;
  };

  const commitEdit = (w: WordRow, value: string) => {
    setEditing(null);
    const text = value.trim();
    setDoc((d) => {
      const next = { ...d.words };
      if (!text) next[w.i] = { ...(next[w.i] || {}), hidden: true };
      else if (text === w.word) { const o = { ...(next[w.i] || {}) }; delete o.text; delete o.hidden; if (Object.keys(o).length) next[w.i] = o; else delete next[w.i]; }
      else next[w.i] = { ...(next[w.i] || {}), text, hidden: false };
      return { ...d, words: next };
    });
  };

  const selCount = selected.size;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Search className="h-3.5 w-3.5 text-fg-3" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find in transcript"
          className="w-full bg-transparent text-[13px] outline-none placeholder:text-fg-3" />
        {selCount > 0 && (
          <button onClick={props.cutSelection}
            className="shrink-0 rounded bg-accent px-2 py-0.5 text-xs font-medium text-white hover:bg-accent-hover">
            Cut {selCount} word{selCount === 1 ? '' : 's'} (⌫)
          </button>
        )}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 select-none overflow-y-auto px-3 py-2 text-[14px] leading-7"
        onScroll={() => { userScrolledAt.current = Date.now(); }}
        // A click seeks, which moves the active word; auto-scrolling right then shifts the
        // list under the pointer, so the second click of a double-click lands on another
        // word. Hold the view still for a moment after any pointer interaction. (`select-none`:
        // a drag here selects WORDS for cutting, never browser text.)
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {paragraphs.map((p, pi) => (
          <div key={pi} className="mb-3 flex gap-3">
            <button onClick={() => playback.seekSource(p[0].start)}
              className="mt-0.5 shrink-0 select-none font-mono text-[11px] text-fg-3 hover:text-fg-1">{fmtTime(p[0].start)}</button>
            <p className="min-w-0">
              {p.map((w) => {
                const isSel = selected.has(w.i);
                const active = w.i === activeIdx;
                const cls = [
                  'rounded px-0.5 -mx-0.5 cursor-pointer transition-colors duration-150',
                  !w.inRange ? 'text-fg-3/60' : w.cut || w.hidden ? 'text-fg-3 line-through decoration-error/70' : 'text-fg-1',
                  w.edited ? 'underline decoration-dotted decoration-accent underline-offset-4' : '',
                  active ? 'bg-accent text-white' : isSel ? 'bg-accent-soft text-fg-1' : matches(w) ? 'bg-warning/30' : 'hover:bg-bg-3',
                ].join(' ');
                if (editing === w.i) {
                  return (
                    <input key={w.i} autoFocus defaultValue={w.text}
                      // Select the word on open so the first keystroke REPLACES it — without
                      // this an edit came out as "bounceBOUNCE!".
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={(e) => commitEdit(w, e.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(w, e.currentTarget.value); if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }}
                      className="mx-0.5 w-24 rounded bg-bg-4 px-1 text-fg-1 outline outline-1 outline-accent" />
                  );
                }
                return (
                  <span key={w.i} data-i={w.i} className={cls}
                    title={w.edited ? `was “${w.word}”` : w.cut ? 'cut — click to restore' : undefined}
                    onClick={(e) => clickWord(w, e)}
                    onDoubleClick={(e) => { e.preventDefault(); setEditing(w.i); }}>
                    {w.text}{' '}
                  </span>
                );
              })}
            </p>
          </div>
        ))}
        {!words.length && <div className="py-10 text-center text-sm text-fg-3">No words in this window.</div>}
      </div>
      <div className="border-t border-line px-3 py-1.5 text-[11px] text-fg-3">
        click = jump · drag or shift-click = select · ⌫ = cut · H = hide captions · double-click = fix a word · click a struck word = restore
      </div>
    </div>
  );
}
