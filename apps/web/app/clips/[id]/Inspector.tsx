'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Composition, Doc, FontEntry, FormatInfo, Selection } from './types';
import { Field, Segmented, Slider, Swatches, Toggle } from '../../components/ui';

type Tab = 'format' | 'title' | 'captions';

/**
 * Few big controls. Every change writes the document; the preview follows.
 * Selecting the title or the captions on the stage switches to their tab.
 */
export default function Inspector(props: {
  clipId: string;
  doc: Doc;
  fonts: FontEntry[];
  formats: FormatInfo[];
  composition: Composition | null;
  selection: Selection;
  setDoc: (u: (d: Doc) => Doc, o?: { coalesce?: string }) => void;
  endGesture: () => void;
}) {
  const { doc, setDoc, fonts, formats, selection } = props;
  const [tab, setTab] = useState<Tab>('format');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  useEffect(() => {
    if (selection?.kind === 'title') setTab('title');
    if (selection?.kind === 'captions' || selection?.kind === 'words') setTab('captions');
  }, [selection]);

  const setTitle = (patch: Partial<Doc['title']>, coalesce?: string) =>
    setDoc((d) => ({ ...d, title: { ...d.title, ...patch } }), coalesce ? { coalesce } : undefined);
  const setCaps = (patch: Partial<Doc['captions']>, coalesce?: string) =>
    setDoc((d) => ({ ...d, captions: { ...d.captions, ...patch } }), coalesce ? { coalesce } : undefined);

  const suggest = async () => {
    setSuggesting(true);
    try {
      const r = await fetch(`/api/clips/${props.clipId}/titles`, { method: 'POST' }).then((x) => x.json());
      setSuggestions(r.accepted ? r.accepted.map((c: { title: string }) => c.title) : []);
    } finally { setSuggesting(false); }
  };

  const groups: Array<[string, string, string]> = [
    ['band', 'Keep the frame', 'The trader’s own framing on black; the title above.'],
    ['stacked', 'Stacked', 'Chart and trader as two bands, cropped to fill.'],
    ['overlay', 'Full-bleed', 'One pane fills the frame, the other rides as an inset.'],
  ];
  const needsPanes = !doc.format.variant.startsWith('band-') && !props.composition;

  return (
    <div className="flex h-full flex-col">
      <div className="p-2">
        <Segmented value={tab} options={[['format', 'Format'], ['title', 'Title'], ['captions', 'Captions']]} onChange={setTab} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 text-[13px]">

        {tab === 'format' && (
          <div className="space-y-5">
            {needsPanes && <div className="rounded-xl bg-warning/10 px-3 py-2 text-[12px] text-warning">Finding the webcam and the chart in this stream — the preview will switch once they’re located.</div>}
            {groups.map(([g, label, hint]) => (
              <div key={g}>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3">{label}</div>
                <div className="mb-2 text-[11px] text-fg-3">{hint}</div>
                <div className="grid grid-cols-4 gap-2">
                  {formats.filter((f) => f.group === g).map((f) => {
                    const on = doc.format.variant === f.id;
                    return (
                      <button key={f.id} onClick={() => setDoc((d) => ({ ...d, format: { variant: f.id } }))} title={f.label}
                        className={`rounded-xl p-1 text-left transition-all duration-150 ${on ? 'bg-accent/15 ring-2 ring-accent' : 'hover:bg-white/[0.06]'}`}>
                        <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg bg-black">
                          {f.boxes.map((b, i) => (
                            <div key={i} className={`absolute ${b.kind === 'cam' ? 'bg-accent/50' : b.kind === 'screen' ? 'bg-sky-300/40' : 'bg-white/25'}`}
                              style={{ left: `${(b.x / 1080) * 100}%`, top: `${(b.y / 1920) * 100}%`, width: `${(b.w / 1080) * 100}%`, height: `${(b.h / 1920) * 100}%` }} />
                          ))}
                          {f.titleY != null && <div className="absolute left-[14%] right-[14%] h-[6%] rounded-[2px] bg-white" style={{ top: `${(f.titleY / 1920) * 100 - 3}%` }} />}
                          <div className="absolute left-[28%] right-[28%] h-[2.5%] rounded-[2px] bg-white/80" style={{ top: `${(f.captionY / 1920) * 100 - 2.5}%` }} />
                        </div>
                        <div className={`mt-1 truncate text-center text-[10px] ${on ? 'text-fg-1' : 'text-fg-3'}`}>{f.label}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'title' && (
          <div className="space-y-5">
            <Field label="On-screen title" hint={`${doc.title.text.length}/62 · emoji work`}>
              <textarea id="title-text" value={doc.title.text} rows={2}
                onChange={(e) => setTitle({ text: e.target.value }, 'title-text')}
                placeholder="I Made $3,000 On This Bounce 🔥"
                className="glass-flat w-full resize-none rounded-xl px-3 py-2 text-[14px] outline-none focus:ring-2 focus:ring-accent/60" />
              <button onClick={suggest} disabled={suggesting} className="mt-2 flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover disabled:opacity-50">
                <Sparkles className="h-3.5 w-3.5" /> {suggesting ? 'Writing titles…' : 'Suggest titles'}
              </button>
              {suggestions && (
                <div className="mt-2 space-y-1">
                  {suggestions.length === 0 && <div className="text-xs text-fg-3">Nothing passed the grounding check.</div>}
                  {suggestions.map((s) => (
                    <button key={s} onClick={() => setTitle({ text: s })} className="pill block w-full px-3 py-1.5 text-left text-xs">{s}</button>
                  ))}
                </div>
              )}
            </Field>
            <Field label="Font"><FontSelect value={doc.title.font} fonts={fonts.filter((f) => f.roles.includes('title'))} onChange={(v) => setTitle({ font: v })} /></Field>
            <Field label="Size" hint={`${doc.title.size}px`}>
              <Slider min={32} max={130} value={doc.title.size} onChange={(v) => setTitle({ size: v }, 'title-size')} onCommit={props.endGesture} />
            </Field>
            <Field label="Text colour"><Swatches value={doc.title.color} onChange={(v) => setTitle({ color: v })} /></Field>
            <Field label="Background">
              <div className="flex items-center gap-3">
                <Toggle on={doc.title.box} onChange={(v) => setTitle({ box: v })} label="Background box" />
                {doc.title.box && <Swatches value={doc.title.boxColor} onChange={(v) => setTitle({ boxColor: v })} />}
              </div>
            </Field>
            <Field label="Outline">
              <div className="flex items-center gap-3">
                <Toggle on={doc.title.outline} onChange={(v) => setTitle({ outline: v })} label="Outline" />
                {doc.title.outline && <Swatches value={doc.title.outlineColor} onChange={(v) => setTitle({ outlineColor: v })} />}
              </div>
            </Field>
            <Field label="Stays on screen" hint="or drag its block on the timeline">
              <Segmented value={doc.title.hold == null ? 'all' : String(doc.title.hold)}
                options={[['all', 'Whole clip'], ['3', '3 s'], ['5', '5 s'], ['8', '8 s']]}
                onChange={(v) => setTitle({ hold: v === 'all' ? null : +v })} />
            </Field>
            <Field label="Position" hint={doc.title.x != null || doc.title.y != null ? `${doc.title.x ?? 540}, ${doc.title.y ?? '·'}` : 'default'}>
              <div className="flex items-center gap-2 text-xs text-fg-3">
                Drag the title on the preview.
                {(doc.title.x != null || doc.title.y != null) && <button onClick={() => setTitle({ x: null, y: null })} className="pill px-2 py-0.5 text-fg-1">Reset</button>}
              </div>
            </Field>
          </div>
        )}

        {tab === 'captions' && (
          <div className="space-y-5">
            <Field label="Captions"><Toggle on={doc.captions.enabled} onChange={(v) => setCaps({ enabled: v })} label="Captions" /></Field>
            {doc.captions.enabled && (<>
              <Field label="Style">
                <Segmented value={doc.captions.mode} options={[['word', 'Word by word'], ['highlight', 'Highlight']]} onChange={(v) => setCaps({ mode: v })} />
                <div className="mt-1.5 text-[11px] text-fg-3">{doc.captions.mode === 'word' ? 'One word at a time, replacing the last.' : 'A short phrase stays up; the word being said lights up.'}</div>
              </Field>
              <Field label="Font"><FontSelect value={doc.captions.font} fonts={fonts.filter((f) => f.roles.includes('caption'))} onChange={(v) => setCaps({ font: v })} /></Field>
              <Field label="Size" hint={`${doc.captions.size}px`}>
                <Slider min={40} max={160} value={doc.captions.size} onChange={(v) => setCaps({ size: v }, 'cap-size')} onCommit={props.endGesture} />
              </Field>
              <Field label="Colour"><Swatches value={doc.captions.color} onChange={(v) => setCaps({ color: v })} /></Field>
              {doc.captions.mode === 'highlight' && (
                <Field label="Highlight colour"><Swatches value={doc.captions.highlightColor} onChange={(v) => setCaps({ highlightColor: v })} /></Field>
              )}
              <Field label="Case">
                <Segmented value={doc.captions.case} options={[['as-spoken', 'As spoken'], ['upper', 'UPPERCASE']]} onChange={(v) => setCaps({ case: v })} />
              </Field>
              <Field label="Position" hint={doc.captions.x != null || doc.captions.y != null ? `${doc.captions.x ?? 540}, ${doc.captions.y ?? '·'}` : 'default'}>
                <div className="flex items-center gap-2 text-xs text-fg-3">
                  Drag the captions on the preview; drag a word on the timeline to fix its timing.
                  {(doc.captions.x != null || doc.captions.y != null) && <button onClick={() => setCaps({ x: null, y: null })} className="pill px-2 py-0.5 text-fg-1">Reset</button>}
                </div>
              </Field>
            </>)}
          </div>
        )}
      </div>
    </div>
  );
}

function FontSelect({ value, fonts, onChange }: { value: string; fonts: FontEntry[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="glass-flat w-full rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-accent/60"
      style={{ fontFamily: `"${value}"` }}>
      {fonts.map((f) => <option key={f.name} value={f.name} style={{ fontFamily: `"${f.name}"` }}>{f.label}</option>)}
    </select>
  );
}
