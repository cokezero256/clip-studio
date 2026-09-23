/**
 * Server-only bridge to the CommonJS data layer.
 *
 * The web app NEVER runs the pipeline — it only reads rows and writes job rows. All
 * ffmpeg/whisper/yt-dlp work happens in the worker process.
 */
import 'server-only';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const db = require('@clip-studio/db');

export type Source = {
  id: string; input: string; title: string | null; uploader: string | null;
  duration_s: number | null; status: string; created_at: string;
  client_name: string | null; clip_count: number; ready_count: number;
  work_dir: string | null; video_path: string | null;
};

export type Clip = {
  id: string; source_id: string; start_s: number; end_s: number; duration_s: number | null;
  hook: string | null; title_text: string | null; prescore: number | null;
  cuts_count: number; silence_removed_ms: number; gate_json: string; ready: number; rank: number;
};

export type Job = {
  id: string; type: string; status: string; stage: string | null; message: string | null;
  progress: number | null; source_id: string | null; error: string | null;
  created_at: string; source_title: string | null;
};

export default db;
