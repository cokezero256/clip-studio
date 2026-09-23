/** Client-side mirror of the engine's composition document (`packages/engine/src/edit/doc.js`). */
export type Cut = { start: number; end: number; source: string };
export type Doc = {
  v: number;
  range: { start: number; end: number };
  cuts: Cut[];
  /** Editing-only boundaries (source seconds) — let a piece be trimmed or deleted alone. */
  splits: number[];
  format: { variant: string };
  title: {
    text: string; font: string; size: number; color: string; box: boolean; boxColor: string;
    outline: boolean; outlineColor: string; hold: number | null; x: number | null; y: number | null;
  };
  captions: {
    enabled: boolean; mode: 'word' | 'highlight'; font: string; size: number; color: string;
    highlightColor: string; case: 'as-spoken' | 'upper'; x: number | null; y: number | null;
  };
  words: Record<string, { text?: string; start?: number; end?: number; hidden?: boolean }>;
};

export type WordRow = {
  i: number; word: string; text: string; edited: boolean; start: number; end: number;
  hidden: boolean; inRange: boolean; cut: boolean;
};

export type Span = { a: number; b: number; outStart: number };
export type Pause = { start: number; end: number; seconds: number };
export type CaptionEvent = { start: number; end: number; lines: Array<Array<{ text: string; active: boolean }>> };

export type Preview = {
  duration: number;
  spans: Span[];
  empty: boolean;
  events: CaptionEvent[];
  captions: { enabled: boolean; font: string; size: number; color: string; highlightColor: string; x: number; y: number };
  title: null | { url: string; width: number; height: number; x: number; y: number; size: number; hold: number | null };
  geometry: {
    kind: 'band' | 'panes';
    videoY: number; videoH: number; titleY: number | null; captionY: number;
    /** Re-composed layouts: draw `visible` (normalised source rect) into `dst` (canvas px). */
    panes: Array<{ id: 'screen' | 'cam'; visible: { x: number; y: number; w: number; h: number }; dst: { x: number; y: number; w: number; h: number } }> | null;
    /** Job id while the webcam/chart regions are still being detected. */
    panesPending: string | null;
  };
  fps: number;
};

export type FormatInfo = {
  id: string; group: string; label: string;
  boxes: Array<{ kind: 'screen' | 'cam' | 'video'; x: number; y: number; w: number; h: number }>;
  titleY: number | null; captionY: number;
};

export type Composition = { mode: string; cam: { x: number; y: number; w: number; h: number } | null; screen: { x: number; y: number; w: number; h: number } };

/** What is selected — several clips or several words at once, or one of the two layers. */
export type Selection =
  | { kind: 'blocks'; keys: string[] }
  | { kind: 'words'; is: number[] }
  | { kind: 'title' }
  | { kind: 'captions' }
  | null;

export type Geometry = {
  canvas: { width: number; height: number };
  variants: Record<string, { videoY: number; videoH: number; titleY: number | null; captionY: number }>;
  titleFontSize: number;
  captionFontSize: number;
};

export type FontEntry = { name: string; label: string; file: string; roles: string[] };

export type RenderRow = {
  id: string; path: string; layout: string; caption_style: string; passed: number;
  duration_s: number | null; created_at: string; verify_json?: string | null;
};

export type EditorData = {
  clip: {
    id: string; source_id: string; start_s: number; end_s: number; title_text: string | null;
    verdict: string | null; corpus_score: number | null; hook: string | null; updatedAt: string | null;
  };
  source: { id: string; title: string | null; duration_s: number | null; fps: number; width: number; height: number };
  doc: Doc;
  words: WordRow[];
  /** Measured pauses (≥150 ms) in the window, source seconds — dead air the tools see. */
  pauses: Pause[];
  window: { start: number; end: number };
  proxy: {
    ready: true; origin: number; duration: number; fps: number; width: number; height: number;
    filmstrip: { columns: number; rows: number; tileW: number; tileH: number; secondsPerTile: number; count: number } | null;
  } | { ready: false; jobId: string };
  geometry: Geometry;
  formats: FormatInfo[];
  composition: Composition | null;
  fonts: FontEntry[];
  renders: RenderRow[];
  activeRender: { id: string; status: string } | null;
  worker: { alive: boolean; pid: number | null; startedAt: string | null; stale: boolean };
  siblings: Array<{ id: string; start_s: number; hook: string | null; verdict: string | null }>;
};

export const CANVAS_W = 1080;
export const CANVAS_H = 1920;

export const fmtTime = (t: number) => {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};
export const fmtTimeMs = (t: number) => {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};

/** Output time for a source time, or null when the source time is inside a cut. */
export function srcToOut(s: number, spans: Span[]): number | null {
  for (const sp of spans) if (s >= sp.a && s < sp.b) return sp.outStart + (s - sp.a);
  return null;
}
/** Source time for an output time (clamped to the clip). */
export function outToSrc(t: number, spans: Span[]): number {
  if (!spans.length) return 0;
  for (const sp of spans) {
    const len = sp.b - sp.a;
    if (t >= sp.outStart && t < sp.outStart + len) return sp.a + (t - sp.outStart);
  }
  const last = spans[spans.length - 1];
  return t < spans[0].outStart ? spans[0].a : last.b - 1e-3;
}
/** The first kept span starting at or after a source time. */
export function nextSpanAfter(s: number, spans: Span[]): Span | null {
  for (const sp of spans) if (sp.a > s) return sp;
  return null;
}
