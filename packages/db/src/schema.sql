-- Clip Studio 2.0 schema.
--
-- The v1 app used loose JSON files on disk as its database, which cost it: render history
-- was reconstructed by regex-parsing filenames, re-rendering silently overwrote, and there
-- was no way to represent two concurrent jobs. All of that becomes rows here.

PRAGMA journal_mode = WAL;        -- web process reads while the worker writes
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS client (
  id           TEXT PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  caption_style TEXT,
  cta_path     TEXT,
  hotwords     TEXT,               -- whisper prompt bias: tickers, platform jargon
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS source (
  id            TEXT PRIMARY KEY,
  client_id     TEXT REFERENCES client(id),
  input         TEXT NOT NULL,     -- URL or local path as submitted
  source_key    TEXT UNIQUE NOT NULL,
  title         TEXT,
  uploader      TEXT,
  duration_s    REAL,
  width         INTEGER,
  height        INTEGER,
  work_dir      TEXT,
  video_path    TEXT,
  audio_path    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  composition_json TEXT             -- detected webcam/chart regions, normalised 0–1
);

CREATE TABLE IF NOT EXISTS clip (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  start_s        REAL NOT NULL,
  end_s          REAL NOT NULL,
  duration_s     REAL,
  hook           TEXT,
  title_text     TEXT,
  prescore       REAL,
  cuts_json      TEXT,             -- the silence cuts applied
  cuts_count     INTEGER DEFAULT 0,
  silence_removed_ms INTEGER DEFAULT 0,
  gate_json      TEXT,             -- per-gate pass/fail + reasons, shown in the UI
  ready          INTEGER DEFAULT 0,
  rank           INTEGER DEFAULT 0,
  -- The corpus ranker's judgement (see engine/src/select/ground.js).
  verdict        TEXT,             -- ship | maybe | cut
  corpus_score   REAL,
  corpus_why     TEXT,
  -- The editor's composition document. When present it OVERRIDES the machine plan above
  -- at render time, and a clip carrying one is never deleted by re-processing.
  edit_json      TEXT,
  edit_updated_at TEXT,
  composition_json TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clip_source ON clip(source_id, rank);

-- Renders are ROWS, never overwritten files. v1 lost every previous version.
CREATE TABLE IF NOT EXISTS render (
  id           TEXT PRIMARY KEY,
  clip_id      TEXT NOT NULL REFERENCES clip(id) ON DELETE CASCADE,
  path         TEXT,
  format       TEXT,
  layout       TEXT,
  caption_style TEXT,
  bytes        INTEGER,
  duration_s   REAL,
  verify_json  TEXT,               -- the post-render silence gate verdict
  passed       INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_render_clip ON render(clip_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,     -- ingest | process | render
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
  stage         TEXT,
  message       TEXT,
  progress      REAL DEFAULT 0,
  source_id     TEXT REFERENCES source(id) ON DELETE CASCADE,
  attempts      INTEGER DEFAULT 0,
  max_attempts  INTEGER DEFAULT 2,
  lease_owner   TEXT,
  lease_until   TEXT,
  pid           INTEGER,
  cancel_requested INTEGER DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_queue ON job(status, created_at);

-- Append-only event log. The UI tails this over SSE, so closing the tab and reopening
-- replays everything rather than losing progress — v1 polled a single progress.json file
-- every 3 seconds and a render's progress was simply invisible.
CREATE TABLE IF NOT EXISTS job_event (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  stage     TEXT,
  message   TEXT,
  progress  REAL,
  level     TEXT DEFAULT 'info'
);
CREATE INDEX IF NOT EXISTS idx_event_job ON job_event(job_id, id);

-- ============================================================ OUTLIER CORPUS

CREATE TABLE IF NOT EXISTS page (
  id          TEXT PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  vertical    TEXT DEFAULT 'trading',
  label       TEXT,
  is_client   INTEGER DEFAULT 0,
  followers   INTEGER,
  active      INTEGER DEFAULT 1,
  last_scraped TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS post (
  shortcode     TEXT PRIMARY KEY,
  page_id       TEXT NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  post_url      TEXT,
  video_url     TEXT,          -- CDN url; EXPIRES within days, download in the same run
  thumb_url     TEXT,
  posted_at     TEXT,
  duration_s    REAL,
  caption       TEXT,
  hashtags      TEXT,
  product_type  TEXT,
  music_original INTEGER,
  music_song    TEXT,
  music_artist  TEXT,
  views         INTEGER,
  likes         INTEGER,
  comments      INTEGER,
  -- scoring
  z             REAL,
  display_mult  REAL,
  is_outlier    INTEGER DEFAULT 0,
  mature        INTEGER DEFAULT 1,
  -- media + derived
  media_dir     TEXT,
  media_state   TEXT DEFAULT 'pending',  -- pending|downloaded|expired|failed|skipped
  ocr_title     TEXT,
  ocr_json      TEXT,
  transcript    TEXT,
  format        TEXT,          -- screenshare_teach | talking_head | lifestyle | ...
  format_conf   REAL,
  format_label  TEXT,          -- human correction, beats the model
  -- Visual attributes. These are what actually decide "is this a clip or a selfie" —
  -- the single format label is unreliable because the model calls a split-screen a
  -- talking head whenever the face is prominent.
  has_chart       INTEGER,
  chart_share     REAL,
  face_present    INTEGER,
  layout          TEXT,
  has_burned_title INTEGER,
  topic         TEXT,
  hook_type     TEXT,
  evidence      TEXT,
  classified_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_post_page ON post(page_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_score ON post(is_outlier, z DESC);

-- Views change over time; keep a series rather than overwriting, so "what won" and
-- "what's popping now" stay answerable separately.
CREATE TABLE IF NOT EXISTS post_metric (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shortcode  TEXT NOT NULL REFERENCES post(shortcode) ON DELETE CASCADE,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  views      INTEGER, likes INTEGER, comments INTEGER
);
CREATE INDEX IF NOT EXISTS idx_metric_post ON post_metric(shortcode, observed_at);


-- Tags an editor creates and reuses across outlier posts and clips.
CREATE TABLE IF NOT EXISTS tag (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color       TEXT NOT NULL DEFAULT '#EC0B7A',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS post_tag (
  shortcode   TEXT NOT NULL REFERENCES post(shortcode) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (shortcode, tag_id)
);
CREATE INDEX IF NOT EXISTS post_tag_by_tag ON post_tag(tag_id);
CREATE TABLE IF NOT EXISTS clip_tag (
  clip_id     TEXT NOT NULL REFERENCES clip(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (clip_id, tag_id)
);
CREATE INDEX IF NOT EXISTS clip_tag_by_tag ON clip_tag(tag_id);
