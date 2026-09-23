'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Span } from './types';
import { nextSpanAfter } from './types';

type Listener = (outputTime: number, playing: boolean) => void;

/**
 * Playback over the CUT clip using the proxy video.
 *
 * Time lives in refs, not React state: the loop runs every video frame and only the few
 * components that subscribe (playhead, caption layer, active word) re-render. The proxy is
 * source footage, so the loop maps its currentTime through the kept spans: inside a span →
 * output time; inside a cut → jump to the next span. The proxy has a keyframe every 10
 * frames, so a jump is a single decode step and the cut is inaudible.
 */
export function usePlayback(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  spans: Span[];
  duration: number;
  origin: number;
}) {
  const { videoRef, origin } = opts;
  const spansRef = useRef<Span[]>(opts.spans);
  const durationRef = useRef(opts.duration);
  spansRef.current = opts.spans;
  durationRef.current = opts.duration;

  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const listeners = useRef(new Set<Listener>());
  const [playing, setPlaying] = useState(false);

  const emit = useCallback(() => {
    for (const l of listeners.current) l(timeRef.current, playingRef.current);
  }, []);

  const seekOutput = useCallback((t: number) => {
    const v = videoRef.current;
    const spans = spansRef.current;
    if (!v || !spans.length) return;
    const clamped = Math.max(0, Math.min(durationRef.current - 1e-3, t));
    let target = spans[0].a;
    for (const sp of spans) {
      const len = sp.b - sp.a;
      if (clamped >= sp.outStart && clamped < sp.outStart + len) { target = sp.a + (clamped - sp.outStart); break; }
      if (clamped >= sp.outStart + len) target = sp.b - 1e-3;
    }
    v.currentTime = Math.max(0, target - origin);
    timeRef.current = clamped;
    emit();
  }, [videoRef, origin, emit]);

  /** Seek by SOURCE time; a time inside a cut lands on the next kept frame. */
  const seekSource = useCallback((s: number) => {
    const spans = spansRef.current;
    for (const sp of spans) if (s >= sp.a && s < sp.b) { seekOutput(sp.outStart + (s - sp.a)); return; }
    const n = nextSpanAfter(s, spans);
    if (n) seekOutput(n.outStart);
    else if (spans.length) seekOutput(durationRef.current - 1e-3);
  }, [seekOutput]);

  // The frame loop.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let handle: number | null = null;
    let usingVfc = false;
    const step = () => {
      const spans = spansRef.current;
      if (spans.length) {
        const s = v.currentTime + origin;
        let inside: Span | null = null;
        for (const sp of spans) if (s >= sp.a && s < sp.b) { inside = sp; break; }
        if (inside) {
          timeRef.current = inside.outStart + (s - inside.a);
        } else if (playingRef.current) {
          const n = nextSpanAfter(s, spans);
          if (n) v.currentTime = n.a - origin;
          else { v.pause(); playingRef.current = false; setPlaying(false); timeRef.current = durationRef.current; }
        }
      }
      emit();
      schedule();
    };
    const schedule = () => {
      const vfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (playingRef.current && typeof vfc === 'function') { usingVfc = true; handle = vfc.call(v, step); }
      else { usingVfc = false; handle = requestAnimationFrame(step); }
    };
    schedule();
    return () => {
      if (handle == null) return;
      if (usingVfc) (v as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }).cancelVideoFrameCallback?.(handle);
      else cancelAnimationFrame(handle);
    };
  }, [videoRef, origin, emit]);

  const play = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    if (timeRef.current >= durationRef.current - 0.05) seekOutput(0);
    try { await v.play(); playingRef.current = true; setPlaying(true); emit(); } catch { /* autoplay refused */ }
  }, [videoRef, seekOutput, emit]);
  const pause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.pause(); playingRef.current = false; setPlaying(false); emit();
  }, [videoRef, emit]);
  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [play, pause]);
  const stepFrames = useCallback((n: number, fps: number) => {
    pause();
    seekOutput(timeRef.current + n / fps);
  }, [pause, seekOutput]);

  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    l(timeRef.current, playingRef.current);
    return () => { listeners.current.delete(l); };
  }, []);

  // After the spans change (a cut was added, the range trimmed), keep the playhead legal.
  useEffect(() => {
    const spans = opts.spans;
    if (!spans.length || !videoRef.current) return;
    const s = videoRef.current.currentTime + origin;
    const inside = spans.some((sp) => s >= sp.a && s < sp.b);
    if (!inside) seekSource(s);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.spans]);

  return useMemo(() => ({
    play, pause, toggle, seekOutput, seekSource, stepFrames, subscribe, playing,
    getTime: () => timeRef.current,
  }), [play, pause, toggle, seekOutput, seekSource, stepFrames, subscribe, playing]);
}

export type Playback = ReturnType<typeof usePlayback>;

/** Subscribe a component to the playhead (re-renders at frame rate — use sparingly). */
export function useTick(playback: Playback) {
  const [t, setT] = useState(0);
  useEffect(() => playback.subscribe((time) => setT(time)), [playback]);
  return t;
}
