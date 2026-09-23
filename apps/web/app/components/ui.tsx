'use client';

import type { ReactNode } from 'react';

/**
 * The glass kit. Every surface in the editor is one of these, so the whole app reads as
 * one material: translucent panels with a hairline top highlight, pill controls, and pink
 * reserved for the one thing on screen that acts or is selected.
 */

export function Glass({ children, className = '', strong = false, ...rest }: React.HTMLAttributes<HTMLDivElement> & { strong?: boolean }) {
  return <div className={`${strong ? 'glass-strong' : 'glass'} rounded-2xl ${className}`} {...rest}>{children}</div>;
}

export function IconBtn({ children, active = false, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...rest}
      className={`pill inline-flex h-8 min-w-8 items-center justify-center gap-1.5 px-2 text-[12px] text-fg-2 hover:text-fg-1 disabled:pointer-events-none disabled:opacity-30 ${active ? 'pill-accent text-white hover:text-white' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

export function PrimaryBtn({ children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`pill pill-accent inline-flex h-9 items-center gap-2 px-4 text-[13px] font-semibold disabled:opacity-40 ${className}`}>
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: {
  value: T; options: Array<[T, ReactNode]>; onChange: (v: T) => void; size?: 'sm' | 'md';
}) {
  return (
    <div className="glass-flat inline-flex w-full rounded-full p-0.5">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)}
          className={`flex-1 rounded-full ${size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-[12px]'} transition-all duration-150 ${value === v ? 'bg-white/[0.12] text-fg-1 shadow-[inset_0_1px_0_rgba(255,255,255,.12)]' : 'text-fg-3 hover:text-fg-2'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${on ? 'bg-accent shadow-[0_0_16px_rgba(236,11,122,.45)]' : 'bg-white/10'}`}>
      <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${on ? 'translate-x-5' : ''}`} />
    </button>
  );
}

export function Slider({ value, min, max, step = 1, onChange, onCommit }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit?: () => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(+e.target.value)} onPointerUp={onCommit} onKeyUp={onCommit}
      className="slider w-full"
      style={{ background: `linear-gradient(90deg, var(--accent) ${pct}%, rgba(255,255,255,.12) ${pct}%)` }} />
  );
}

const SWATCHES = ['#111111', '#FFFFFF', '#EC0B7A', '#FFE500', '#3DDBA9', '#60A5FA'];
export function Swatches({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      {SWATCHES.map((c) => (
        <button key={c} onClick={() => onChange(c)} title={c}
          className={`h-6 w-6 rounded-full border-2 transition-transform duration-150 hover:scale-110 ${value.toUpperCase() === c ? 'border-accent shadow-[0_0_10px_rgba(236,11,122,.6)]' : 'border-white/15'}`}
          style={{ background: c }} />
      ))}
      <label className="relative h-6 w-6 cursor-pointer overflow-hidden rounded-full border-2 border-white/15" title="Custom colour"
        style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }}>
        <input type="color" value={value.slice(0, 7)} onChange={(e) => onChange(e.target.value.toUpperCase())} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-3">{label}</div>
        {hint && <div className="text-[11px] text-fg-3 tabular">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-sans text-[10px] text-fg-2">{children}</kbd>;
}
