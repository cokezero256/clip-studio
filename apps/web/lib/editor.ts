/**
 * Server-side plumbing shared by the editor's API routes.
 *
 * Everything here is read-or-enqueue: the web app reads rows and files the worker produced
 * and writes job rows. The one exception is the title plate (a ~30 ms CoreText child
 * process), which the preview route renders so the browser shows the exact PNG the export
 * will overlay.
 */
import 'server-only';
import fs from 'fs';
import path from 'path';
import db from './db';

/* eslint-disable @typescript-eslint/no-require-imports */
// Literal paths only: a template-string require is opaque to the bundler even for an
// external package, and the route died with an empty 500 before this was made static.
const docLib = require('@clip-studio/engine/src/edit/doc');
const proxyLib = require('@clip-studio/engine/src/edit/proxy');
const transcribe = require('@clip-studio/engine/src/transcribe');
const bandClip = require('@clip-studio/engine/src/compose/band-clip');
const band = require('@clip-studio/engine/src/compose/band');
const ffmpeg = require('@clip-studio/engine/src/ffmpeg');
const paneGeo = require('@clip-studio/engine/src/compose/pane-geometry');
const pausesLib = require('@clip-studio/engine/src/select/pauses');
const tightenLib = require('@clip-studio/engine/src/edit/tighten');
/* eslint-enable @typescript-eslint/no-require-imports */

export const DATA_ROOT = path.resolve(process.cwd(), '..', '..', 'data');
export const CANVAS = { width: 1080, height: 1920 };

export type ClipRow = {
  id: string; source_id: string; start_s: number; end_s: number; title_text: string | null;
  cuts_json: string | null; edit_json: string | null; edit_updated_at: string | null;
  verdict: string | null; corpus_score: number | null; hook: string | null; rank: number;
  composition_json?: string | null;
};
export type SourceRow = {
  id: string; title: string | null; work_dir: string | null; video_path: string | null;
  audio_path: string | null; width: number | null; height: number | null; duration_s: number | null;
  composition_json?: string | null;
};

export type Composition = { mode: string; cam: { x: number; y: number; w: number; h: number } | null; screen: { x: number; y: number; w: number; h: number } };

/** The detected webcam/chart regions for a source, or null until the locate-panes job ran. */
/**
 * The webcam/chart regions for THIS clip. Never the source's: a stream's layout moves
 * during the session (one stream had the webcam bottom-right at 2:00 and bottom-left at
 * 29:00), so a per-source detection framed the wrong corner for later clips.
 */
export function compositionFor(clip: ClipRow): Composition | null {
  if (!clip.composition_json) return null;
  try { return JSON.parse(clip.composition_json); } catch { return null; }
}

/** Queue pane detection once per clip, at the clip's own moment; a second caller attaches. */
export function ensurePanesJob(source: SourceRow, clip: ClipRow): string {
  const running = db.getDb().prepare(
    `SELECT id FROM job WHERE type='locate-panes' AND status IN ('queued','running') AND payload_json LIKE ? ORDER BY created_at DESC LIMIT 1`,
  ).get(`%"clipId":"${clip.id}"%`) as { id: string } | undefined;
  if (running) return running.id;
  return db.enqueue({
    type: 'locate-panes', sourceId: source.id,
    payload: { sourceId: source.id, clipId: clip.id, atSeconds: Math.max(0, clip.start_s + 5) },
  });
}

const FORMAT_LABELS: Record<string, string> = {
  'band-title-top': 'Title above', 'band-title-tight': 'Title high', 'band-title-low': 'Title mid, video low', 'band-no-title': 'Video only',
  'screen-top': 'Chart over trader', 'camera-top': 'Trader over chart', 'screen-big': 'Big chart, small trader', 'camera-big': 'Big trader, small chart',
  'screen-full-pip-br': 'Full chart, trader inset right', 'screen-full-pip-bl': 'Full chart, trader inset left',
  'screen-only': 'Chart only', 'camera-only': 'Trader only',
};
export type FormatInfo = {
  id: string; group: string; label: string;
  /** Boxes on the 1080×1920 canvas for a schematic thumbnail; `kind` tells which pane. */
  boxes: Array<{ kind: 'screen' | 'cam' | 'video'; x: number; y: number; w: number; h: number }>;
  titleY: number | null; captionY: number;
};
export function listFormats(): FormatInfo[] {
  // A nominal composition (webcam bottom-left) just to draw the thumbnails.
  const nominal = { mode: 'pip', cam: { x: 0, y: 0.62, w: 0.3, h: 0.38 }, screen: { x: 0, y: 0, w: 1, h: 1 } };
  return paneGeo.listVariants().map((v: { id: string; group: string }) => {
    const G = paneGeo.layoutGeometry(v.id, { composition: nominal, srcW: 1920, srcH: 1080 });
    const boxes = G.kind === 'band'
      ? [{ kind: 'video' as const, ...G.band }]
      : G.panes.map((p: { id: 'screen' | 'cam'; dst: { x: number; y: number; w: number; h: number } }) => ({ kind: p.id, ...p.dst }));
    return { id: v.id, group: v.group, label: FORMAT_LABELS[v.id] || v.id, boxes, titleY: G.titleY, captionY: G.captionY };
  });
}
export { paneGeo, pausesLib, tightenLib };

export function insideRoot(p: string) {
  const r = path.resolve(p);
  return r.startsWith(DATA_ROOT + path.sep) || r.startsWith('/tmp/');
}

export function getClipAndSource(clipId: string): { clip: ClipRow; source: SourceRow } | null {
  const clip = db.getClip(clipId) as ClipRow | undefined;
  if (!clip) return null;
  const source = db.getSource(clip.source_id) as SourceRow | undefined;
  if (!source) return null;
  return { clip, source };
}

export function loadTranscript(source: SourceRow) {
  if (!source.audio_path || !fs.existsSync(`${source.audio_path}.transcript.json`)) return null;
  return transcribe.loadTranscript(source.audio_path);
}

export type Pause = { start: number; end: number; seconds: number };
type TranscriptLike = { words: Array<{ start: number; end: number }> };

/** Measured pauses (≥150 ms) in [from, to] of the source audio; transcript words are never folded away. */
export function pausesFor(source: SourceRow, transcript: TranscriptLike, from: number, to: number): Pause[] {
  if (!source.audio_path) return [];
  const { db } = pausesLib.envelopeFor(source.audio_path);
  return pausesLib.pausesFromEnvelope(db, { from, to, minPause: 0.15, protect: transcript.words.map((w) => w.start) });
}

/**
 * The document a clip opens with. A saved one as is; a fresh one is the machine's plan with
 * its dead air already taken out (the plan's own silence pass used to leave 1–2 s pauses
 * and word-less slivers behind — see engine/edit/tighten.js).
 */
export function openingDoc(clip: ClipRow, source: SourceRow, transcript: TranscriptLike | null) {
  const doc = currentDoc(clip);
  if (clip.edit_json || !transcript) return doc;
  const pauses = pausesFor(source, transcript, doc.range.start - 1, doc.range.end + 1);
  return tightenLib.tightenCuts(doc, pauses, transcript.words, {}).doc;
}

export function currentDoc(clip: ClipRow) {
  if (clip.edit_json) {
    try { return docLib.normalizeDoc(JSON.parse(clip.edit_json), clip); } catch { /* fall through */ }
  }
  return docLib.defaultDoc(clip);
}

export const layoutDoc = () => JSON.parse(fs.readFileSync(bandClip.LAYOUT_PATH, 'utf-8'));

/** Source frame size + fps: from the proxy manifest when it exists, else probed once and saved. */
export async function sourceMeta(source: SourceRow, manifest: { fps: number; width: number; height: number } | null) {
  if (manifest) return { fps: manifest.fps, width: manifest.width, height: manifest.height };
  if (source.width && source.height) return { fps: 30, width: source.width, height: source.height };
  const info = await ffmpeg.probe(source.video_path);
  db.updateSource(source.id, { width: info.width, height: info.height });
  return { fps: info.fps_num / info.fps_den, width: info.width, height: info.height };
}

/** Band geometry for every variant, so the client can switch formats without a round trip. */
export function geometryFor(width: number, height: number) {
  const layout = layoutDoc();
  const variants: Record<string, unknown> = {};
  for (const name of Object.keys(layout.variants)) {
    const g = band.bandGeometry(layout, name, width, height);
    variants[name] = { videoY: g.y, videoH: g.h, titleY: g.titleY, captionY: g.captionY };
  }
  return { canvas: CANVAS, variants, titleFontSize: layout.title.fontSize, captionFontSize: layout.caption.fontSize };
}

export function activeJobFor(clipId: string, type: string) {
  return db.getDb().prepare(
    `SELECT id, type, status, stage, message, progress FROM job
     WHERE type = ? AND status IN ('queued','running') AND payload_json LIKE ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(type, `%"clipId":"${clipId}"%`) as { id: string; status: string } | undefined;
}

/**
 * The proxy for this clip's current range. When none covers it, ONE proxy job is queued
 * (a second request while it runs attaches to the same job instead of queueing another).
 */
export function proxyState(clip: ClipRow, source: SourceRow, range: { start: number; end: number }) {
  const manifest = source.work_dir ? proxyLib.readProxy(source.work_dir, clip.id, range) : null;
  if (manifest) {
    const f = manifest.filmstrip;
    return {
      ready: true as const,
      origin: manifest.origin, duration: manifest.duration, fps: manifest.fps,
      width: manifest.width, height: manifest.height, manifest,
      filmstrip: f ? { columns: f.columns, rows: f.rows, tileW: f.tileW, tileH: f.tileH, secondsPerTile: f.secondsPerTile, count: f.count } : null,
    };
  }
  const running = activeJobFor(clip.id, 'proxy');
  if (running) return { ready: false as const, jobId: running.id, manifest: null };
  const jobId = db.enqueue({
    type: 'proxy', sourceId: clip.source_id,
    payload: { clipId: clip.id, start: range.start, end: range.end },
  });
  return { ready: false as const, jobId, manifest: null };
}

/** Is a worker alive, and is it older than the newest engine/worker source file? */
export function workerStatus() {
  const statusPath = path.join(DATA_ROOT, 'worker.status.json');
  const lockPath = path.join(DATA_ROOT, 'worker.lock');
  let pid: number | null = null;
  let startedAt: string | null = null;
  let capabilities: Record<string, { ok: boolean; hint?: string; what?: string; bin?: string; path?: string }> | null = null;
  let setup: { tool: string; message: string; percent: number | null; failed?: boolean } | null = null;
  try {
    const st = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    pid = st.pid; startedAt = st.startedAt; capabilities = st.capabilities ?? null; setup = st.setup ?? null;
  } catch {
    try { pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10); } catch { /* none */ }
  }
  let alive = false;
  if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
  let stale = false;
  if (alive && startedAt) {
    const started = new Date(startedAt).getTime();
    const roots = [
      path.resolve(DATA_ROOT, '..', 'packages', 'engine', 'src'),
      path.resolve(DATA_ROOT, '..', 'apps', 'worker', 'src'),
    ];
    stale = roots.some((r) => newestMtime(r) > started + 2000);
  }
  // Tools the worker found missing on ITS machine (yt-dlp, whisper, the model, the title helper).
  const missing = capabilities
    ? Object.entries(capabilities).filter(([k, v]) => k !== 'platform' && v && typeof v === 'object' && v.ok === false)
      .map(([k, v]) => ({ tool: k, hint: v.hint ?? null, what: v.what ?? null }))
    : [];
  return { alive, pid, startedAt, stale, missing, setup: alive ? setup : null };
}

function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('__')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(js|swift|json)$/.test(e.name)) {
        try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* skip */ }
      }
    }
  };
  walk(dir, 0);
  return newest;
}

/**
 * Save a document. `baseUpdatedAt` is the stamp the client loaded; if the row moved on since
 * (another tab), the save is refused and the server's version is returned instead.
 */
export function saveDoc(clip: ClipRow, input: unknown, baseUpdatedAt: string | null | undefined) {
  if (baseUpdatedAt !== undefined && baseUpdatedAt !== null && clip.edit_updated_at && baseUpdatedAt !== clip.edit_updated_at) {
    return { conflict: true as const, doc: currentDoc(clip), updatedAt: clip.edit_updated_at };
  }
  const doc = docLib.normalizeDoc(input, clip);
  const updatedAt = new Date().toISOString();
  db.getDb().prepare('UPDATE clip SET edit_json=?, edit_updated_at=?, title_text=? WHERE id=?')
    .run(JSON.stringify(doc), updatedAt, doc.title.text || null, clip.id);
  return { conflict: false as const, doc, updatedAt };
}

/** Range-aware file streaming, for the proxy video. */
export function streamFile(req: Request, filePath: string, contentType: string): Response {
  if (!insideRoot(filePath) || !fs.existsSync(filePath)) return new Response('not found', { status: 404 });
  const size = fs.statSync(filePath).size;
  const range = req.headers.get('range');
  const headers: Record<string, string> = {
    'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
  };
  if (!range) {
    headers['Content-Length'] = String(size);
    return new Response(fs.createReadStream(filePath) as unknown as ReadableStream, { headers });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m && m[1] ? parseInt(m[1], 10) : 0;
  const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : Math.min(start + 8 * 1024 * 1024, size - 1);
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = String(end - start + 1);
  return new Response(fs.createReadStream(filePath, { start, end }) as unknown as ReadableStream, { status: 206, headers });
}

export function fontCatalog(): { fonts: Array<{ name: string; label: string; file: string; roles: string[] }> } {
  const p = path.resolve(DATA_ROOT, '..', 'packages', 'engine', 'config', 'captions', 'fonts', 'catalog.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

export const FONTS_DIR = path.resolve(DATA_ROOT, '..', 'packages', 'engine', 'config', 'captions', 'fonts');
export { docLib, bandClip, band };
