/**
 * Data layer. SQLite via better-sqlite3 — synchronous, no codegen, no migration tooling.
 *
 * Chosen over Prisma deliberately: this is a single-machine app where a worker process and
 * a web process share one file. The only hard requirement is an atomic job claim, which is
 * one transaction here. Prisma would add a build step and a client generation cycle for no
 * benefit at this scale.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

/**
 * Resolve the database path WITHOUT trusting __dirname.
 *
 * Next's bundler rewrites __dirname to a placeholder ("/ROOT") for externalised CommonJS
 * packages, so a __dirname-relative path resolved to `/ROOT/data` and every API route
 * failed with ENOENT. Prefer an explicit env var, then walk up from cwd looking for the
 * workspace marker, and only then fall back to __dirname.
 */
function resolveDefaultDb() {
  if (process.env.CLIPSTUDIO_DB) return process.env.CLIPSTUDIO_DB;

  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const marker = path.join(dir, 'package.json');
    try {
      if (fs.existsSync(marker)) {
        const pkg = JSON.parse(fs.readFileSync(marker, 'utf-8'));
        if (pkg.name === 'clip-studio') return path.join(dir, 'data', 'clipstudio.db');
      }
    } catch {}
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  const fromHere = path.resolve(__dirname, '..', '..', '..', 'data', 'clipstudio.db');
  if (!fromHere.startsWith('/ROOT')) return fromHere;
  throw new Error(
    'Could not locate the Clip Studio data directory. Set CLIPSTUDIO_DB to an absolute path.'
  );
}

const DEFAULT_DB = null;

let db = null;

let openedDbPath = null;
function getDbPath() { if (!openedDbPath) getDb(); return openedDbPath; }

function getDb(dbPath) {
  dbPath = dbPath || resolveDefaultDb();
  openedDbPath = openedDbPath || dbPath;
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  // schema.sql sits beside this file, but __dirname may be a bundler placeholder — fall
  // back to locating it from the resolved db path's workspace root.
  let schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    schemaPath = path.resolve(path.dirname(dbPath), '..', 'packages', 'db', 'src', 'schema.sql');
  }
  db.exec(fs.readFileSync(schemaPath, 'utf-8'));
  migrate(db);
  return db;
}

/**
 * Column migrations for EXISTING databases.
 *
 * `CREATE TABLE IF NOT EXISTS` creates new tables on the next start but never adds a column
 * to a table that already exists. Before this runner there was no mechanism at all: the live
 * database gained `clip.verdict/corpus_score/corpus_why` through an ALTER run outside the
 * repo, schema.sql never had them, and a database built fresh from schema.sql made every
 * clip insert fail. Each step is guarded by the actual column list, so it is safe to run on
 * any database in any state, and `user_version` records how far it got.
 */
const MIGRATIONS = [
  // 1 — the corpus ranker's columns (were only ever added by hand).
  (d) => {
    addColumn(d, 'clip', 'verdict', 'TEXT');
    addColumn(d, 'clip', 'corpus_score', 'REAL');
    addColumn(d, 'clip', 'corpus_why', 'TEXT');
  },
  // 2 — the editor's composition document.
  (d) => {
    addColumn(d, 'clip', 'edit_json', 'TEXT');
    addColumn(d, 'clip', 'edit_updated_at', 'TEXT');
  },
  // 3 — where the webcam and the chart sit in the source frame, detected once and kept.
  //     Before this, every re-composed render paid a 7–11 s vision call to rediscover it.
  (d) => {
    addColumn(d, 'source', 'composition_json', 'TEXT');
  },
  // 4 — where the webcam and the chart are FOR THIS CLIP. A stream's layout moves (the
  // webcam sat bottom-right at 2:00 and bottom-left at 29:00 in one stream), so a per-source
  // detection at a fixed time framed the wrong corner.
  (d) => { addColumn(d, 'clip', 'composition_json', 'TEXT'); },
];

function addColumn(d, table, column, type) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function migrate(d) {
  const current = d.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    d.transaction(() => {
      MIGRATIONS[v](d);
      d.pragma(`user_version = ${v + 1}`);
    })();
  }
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const now = () => new Date().toISOString();

/* ---------------------------------------------------------------- clients */

function upsertClient({ slug, name, captionStyle = null, ctaPath = null, hotwords = null }) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM client WHERE slug = ?').get(slug);
  if (existing) {
    d.prepare(`UPDATE client SET name=?, caption_style=?, cta_path=?, hotwords=? WHERE id=?`)
      .run(name, captionStyle, ctaPath, hotwords, existing.id);
    return d.prepare('SELECT * FROM client WHERE id = ?').get(existing.id);
  }
  const cid = id('cl');
  d.prepare(`INSERT INTO client (id, slug, name, caption_style, cta_path, hotwords)
             VALUES (?,?,?,?,?,?)`).run(cid, slug, name, captionStyle, ctaPath, hotwords);
  return d.prepare('SELECT * FROM client WHERE id = ?').get(cid);
}

const listClients = () => getDb().prepare('SELECT * FROM client ORDER BY name').all();

/* ---------------------------------------------------------------- sources */

function createSource({ input, sourceKey, clientId = null, title = null }) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM source WHERE source_key = ?').get(sourceKey);
  if (existing) return existing;
  const sid = id('src');
  d.prepare(`INSERT INTO source (id, client_id, input, source_key, title)
             VALUES (?,?,?,?,?)`).run(sid, clientId, input, sourceKey, title);
  return d.prepare('SELECT * FROM source WHERE id = ?').get(sid);
}

function setClipComposition(clipId, composition) {
  getDb().prepare('UPDATE clip SET composition_json=? WHERE id=?')
    .run(composition == null ? null : JSON.stringify(composition), clipId);
}

/**
 * Delete a source and everything that hangs off it — clips, renders, tags, jobs and their
 * events — then its media folder on disk. Foreign keys are not enforced on this connection,
 * so the children go explicitly. The folder is removed only if it sits under
 * `<data>/media/sources/`, never anywhere else, however the row was edited.
 *
 * Returns what was removed so the UI can say so.
 */
function deleteSource(sourceId) {
  const d = getDb();
  const source = d.prepare('SELECT * FROM source WHERE id=?').get(sourceId);
  if (!source) return null;
  const counts = d.transaction(() => {
    const clips = d.prepare('SELECT id FROM clip WHERE source_id=?').all(sourceId).map((r) => r.id);
    let renders = 0;
    for (const id of clips) {
      renders += d.prepare('DELETE FROM render WHERE clip_id=?').run(id).changes;
      d.prepare('DELETE FROM clip_tag WHERE clip_id=?').run(id);
    }
    const jobs = d.prepare('SELECT id FROM job WHERE source_id=?').all(sourceId).map((r) => r.id);
    for (const id of jobs) d.prepare('DELETE FROM job_event WHERE job_id=?').run(id);
    d.prepare('DELETE FROM job WHERE source_id=?').run(sourceId);
    d.prepare('DELETE FROM clip WHERE source_id=?').run(sourceId);
    d.prepare('DELETE FROM source WHERE id=?').run(sourceId);
    return { clips: clips.length, renders, jobs: jobs.length };
  })();
  const files = removeSourceFiles(source.work_dir);
  return { ...counts, ...files, title: source.title || source.input };
}

/** Remove a source's media folder, but only inside the sources root. */
function removeSourceFiles(workDir) {
  if (!workDir) return { bytes: 0, removedDir: null };
  const root = path.resolve(path.dirname(getDbPath()), 'media', 'sources');
  const target = path.resolve(workDir);
  if (!target.startsWith(root + path.sep) || target === root) {
    throw new Error(`refusing to remove ${target}: not under ${root}`);
  }
  let bytes = 0;
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }
    else bytes += st.size;
  };
  walk(target);
  fs.rmSync(target, { recursive: true, force: true });
  return { bytes, removedDir: target };
}

/** Jobs that are still queued or running for a source. */
function activeJobsForSource(sourceId) {
  return getDb().prepare(
    "SELECT id, type, status FROM job WHERE source_id=? AND status IN ('queued','running')",
  ).all(sourceId);
}

function updateSource(sourceId, fields) {
  const allowed = ['title', 'uploader', 'duration_s', 'width', 'height',
                   'work_dir', 'video_path', 'audio_path', 'status', 'client_id', 'composition_json'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  getDb().prepare(`UPDATE source SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`)
    .run(...keys.map((k) => fields[k]), sourceId);
}

const getSource = (sourceId) => getDb().prepare('SELECT * FROM source WHERE id=?').get(sourceId);

const listSources = () => getDb().prepare(`
  SELECT s.*,
         c.name AS client_name,
         (SELECT COUNT(*) FROM clip WHERE source_id = s.id) AS clip_count,
         (SELECT COUNT(*) FROM clip WHERE source_id = s.id AND ready = 1) AS ready_count
  FROM source s LEFT JOIN client c ON c.id = s.client_id
  ORDER BY s.created_at DESC`).all();

/* ------------------------------------------------------------------ clips */

/**
 * Store a fresh selection for a source WITHOUT destroying the operator's work.
 *
 * This used to DELETE every clip of the source and re-insert the new plan with new ids. The
 * cascade took every render with it, and hand-set titles vanished — measured: after a day
 * of re-processing, all 7 successful on-demand renders pointed at clips that no longer
 * existed. An editor built on top would have lost its edits the same way.
 *
 * Now a clip that carries operator state — an editor document, a title, or any render — is
 * KEPT. When a new candidate covers the same moment (IoU > 0.5, or the shorter span mostly
 * inside the other), the kept clip adopts the new MACHINE fields (score, gates, verdict,
 * rank, and the plan's range/cuts unless an editor document overrides them) and keeps its
 * id, title, renders and edits. Kept clips no candidate covers stay, ranked after the new
 * plan. Only machine-only clips nobody touched are deleted.
 */
function overlapOf(a0, a1, b0, b1) {
  const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const union = (a1 - a0) + (b1 - b0) - inter;
  const shorter = Math.min(a1 - a0, b1 - b0);
  return { iou: union > 0 ? inter / union : 0, contain: shorter > 0 ? inter / shorter : 0 };
}

function hasOperatorState(d, clip) {
  if (clip.edit_json || clip.title_text) return true;
  return !!d.prepare('SELECT 1 FROM render WHERE clip_id=? LIMIT 1').get(clip.id);
}

function mergeClips(sourceId, clips) {
  const d = getDb();
  const summary = { inserted: 0, updated: 0, kept: 0, deleted: 0 };
  const tx = d.transaction(() => {
    const existing = d.prepare('SELECT * FROM clip WHERE source_id = ?').all(sourceId);
    const protectedClips = existing.filter((c) => hasOperatorState(d, c));
    const matched = new Set();

    const ins = d.prepare(`INSERT INTO clip
      (id, source_id, start_s, end_s, duration_s, hook, title_text, prescore,
       cuts_json, cuts_count, silence_removed_ms, gate_json, ready, rank,
       verdict, corpus_score, corpus_why)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const upd = d.prepare(`UPDATE clip SET
       start_s = CASE WHEN edit_json IS NULL THEN ? ELSE start_s END,
       end_s   = CASE WHEN edit_json IS NULL THEN ? ELSE end_s END,
       cuts_json = CASE WHEN edit_json IS NULL THEN ? ELSE cuts_json END,
       duration_s=?, hook=?, prescore=?, cuts_count=?, silence_removed_ms=?,
       gate_json=?, ready=?, rank=?, verdict=?, corpus_score=?, corpus_why=?,
       title_text = COALESCE(title_text, ?)
       WHERE id=?`);

    clips.forEach((c, i) => {
      const hit = protectedClips.find((k) => {
        if (matched.has(k.id)) return false;
        const o = overlapOf(k.start_s, k.end_s, c.start_seconds, c.end_seconds);
        return o.iou > 0.5 || o.contain > 0.6;
      });
      const cuts = JSON.stringify(c.manual_cuts || []);
      if (hit) {
        matched.add(hit.id);
        upd.run(c.start_seconds, c.end_seconds, cuts,
          c.finalDurationSeconds ?? null, c.hook ?? null, c.prescore ?? null,
          c.cutsApplied ?? 0, c.silenceRemovedMs ?? 0, JSON.stringify(c.gate || {}),
          c.ready ? 1 : 0, i, c.verdict ?? null, c.corpusScore ?? null, c.why ?? null,
          c.titleText ?? null, hit.id);
        summary.updated++;
      } else {
        ins.run(id('clip'), sourceId, c.start_seconds, c.end_seconds,
          c.finalDurationSeconds ?? null, c.hook ?? null, c.titleText ?? null,
          c.prescore ?? null, cuts, c.cutsApplied ?? 0, c.silenceRemovedMs ?? 0,
          JSON.stringify(c.gate || {}), c.ready ? 1 : 0, i,
          c.verdict ?? null, c.corpusScore ?? null, c.why ?? null);
        summary.inserted++;
      }
    });

    // Operator work no new candidate covers stays, after the new plan.
    let tail = clips.length;
    for (const k of protectedClips) {
      if (matched.has(k.id)) continue;
      d.prepare('UPDATE clip SET rank=? WHERE id=?').run(tail++, k.id);
      summary.kept++;
    }
    // Only untouched machine rows go — they have no renders, so nothing cascades.
    for (const k of existing) {
      if (protectedClips.includes(k)) continue;
      d.prepare('DELETE FROM clip WHERE id=?').run(k.id);
      summary.deleted++;
    }
  });
  tx();
  return summary;
}

/** Kept under its old name for callers; it merges now — see mergeClips. */
const replaceClips = mergeClips;

const listClips = (sourceId) =>
  getDb().prepare('SELECT * FROM clip WHERE source_id=? ORDER BY rank').all(sourceId);

const getClip = (clipId) => getDb().prepare('SELECT * FROM clip WHERE id=?').get(clipId);

/* ---------------------------------------------------------------- renders */

function addRender({ clipId, path: p, format, layout, captionStyle, bytes, durationS, verify }) {
  const rid = id('rnd');
  getDb().prepare(`INSERT INTO render
    (id, clip_id, path, format, layout, caption_style, bytes, duration_s, verify_json, passed)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      rid, clipId, p, format, layout, captionStyle, bytes ?? null, durationS ?? null,
      JSON.stringify(verify || {}), verify && verify.passed ? 1 : 0);
  return rid;
}

const listRenders = (clipId) =>
  getDb().prepare('SELECT * FROM render WHERE clip_id=? ORDER BY created_at DESC').all(clipId);

/* ------------------------------------------------------------------- jobs */

function enqueue({ type, payload, sourceId = null }) {
  const jid = id('job');
  getDb().prepare(`INSERT INTO job (id, type, payload_json, source_id) VALUES (?,?,?,?)`)
    .run(jid, type, JSON.stringify(payload), sourceId);
  return jid;
}

/**
 * Atomic claim. An IMMEDIATE transaction means two workers cannot take the same row —
 * the second blocks on the write lock and then sees status='running'.
 */
function claimJob(owner, leaseSeconds = 60, types = null) {
  const d = getDb();
  const tx = d.transaction(() => {
    // `types` lets a worker lane claim only its kinds of job (see the worker's two lanes).
    const typeFilter = Array.isArray(types) && types.length
      ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
    const row = d.prepare(`SELECT * FROM job
      WHERE (status='queued' OR (status='running' AND lease_until < ?))${typeFilter}
      ORDER BY created_at LIMIT 1`).get(now(), ...(typeFilter ? types : []));
    if (!row) return null;
    const until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    d.prepare(`UPDATE job SET status='running', lease_owner=?, lease_until=?,
               attempts=attempts+1, started_at=COALESCE(started_at, ?), pid=? WHERE id=?`)
      .run(owner, until, now(), process.pid, row.id);
    return d.prepare('SELECT * FROM job WHERE id=?').get(row.id);
  });
  return d.transaction(tx).immediate();
}

const renewLease = (jobId, owner, leaseSeconds = 60) =>
  getDb().prepare('UPDATE job SET lease_until=? WHERE id=? AND lease_owner=?')
    .run(new Date(Date.now() + leaseSeconds * 1000).toISOString(), jobId, owner);

const finishJob = (jobId, status, error = null) =>
  getDb().prepare(`UPDATE job SET status=?, error=?, finished_at=?, progress=? WHERE id=?`)
    .run(status, error, now(), status === 'succeeded' ? 1 : null, jobId);

const requestCancel = (jobId) =>
  getDb().prepare('UPDATE job SET cancel_requested=1 WHERE id=?').run(jobId);

const getJob = (jobId) => getDb().prepare('SELECT * FROM job WHERE id=?').get(jobId);

const listJobs = (limit = 25) =>
  getDb().prepare(`SELECT j.*, s.title AS source_title FROM job j
                   LEFT JOIN source s ON s.id=j.source_id
                   ORDER BY j.created_at DESC LIMIT ?`).all(limit);

/**
 * Reap leases orphaned by a crash. Run at worker startup — a job whose lease expired while
 * nobody held it is requeued rather than sitting 'running' forever.
 */
function reapStaleJobs() {
  return getDb().prepare(`UPDATE job SET status='queued', lease_owner=NULL, pid=NULL
    WHERE status='running' AND lease_until < ?`).run(now()).changes;
}

/* ----------------------------------------------------------------- events */

function emit(jobId, { stage, message, progress = null, level = 'info' }) {
  const d = getDb();
  d.prepare(`INSERT INTO job_event (job_id, stage, message, progress, level)
             VALUES (?,?,?,?,?)`).run(jobId, stage ?? null, message ?? null, progress, level);
  d.prepare('UPDATE job SET stage=?, message=?, progress=COALESCE(?, progress) WHERE id=?')
    .run(stage ?? null, message ?? null, progress, jobId);
}

const eventsSince = (jobId, afterId = 0) =>
  getDb().prepare('SELECT * FROM job_event WHERE job_id=? AND id>? ORDER BY id').all(jobId, afterId);

/* --------------------------------------------------------- outlier corpus */

function upsertPage({ username, vertical = 'trading', label = null, isClient = 0 }) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM page WHERE username = ?').get(username);
  if (existing) return existing;
  const pid = id('pg');
  d.prepare(`INSERT INTO page (id, username, vertical, label, is_client) VALUES (?,?,?,?,?)`)
    .run(pid, username, vertical, label, isClient);
  return d.prepare('SELECT * FROM page WHERE id = ?').get(pid);
}

const listPages = () => getDb().prepare(`
  SELECT p.*, (SELECT COUNT(*) FROM post WHERE page_id = p.id) AS post_count,
         (SELECT COUNT(*) FROM post WHERE page_id = p.id AND is_outlier = 1) AS outlier_count
  FROM page p WHERE active = 1 ORDER BY is_client DESC, username`).all();

/**
 * Upsert scraped posts. Metrics are APPENDED to a series rather than overwritten, so
 * "what won" and "what's gaining now" stay separately answerable.
 */
function upsertPosts(pageId, posts) {
  const d = getDb();
  const up = d.prepare(`INSERT INTO post
    (shortcode, page_id, post_url, video_url, thumb_url, posted_at, duration_s, caption,
     hashtags, product_type, music_original, music_song, music_artist,
     views, likes, comments, z, display_mult, is_outlier, mature,
     media_dir, media_state, ocr_title, ocr_json, format, format_conf, topic, hook_type, evidence,
     has_chart, chart_share, face_present, layout, has_burned_title,
     classified_at)
    VALUES (@shortcode,@pageId,@postUrl,@videoUrl,@thumbUrl,@postedAt,@durationS,@caption,
            @hashtags,@productType,@musicOriginal,@musicSong,@musicArtist,
            @views,@likes,@comments,@z,@displayMult,@isOutlier,@mature,
            @mediaDir,COALESCE(@mediaState,'pending'),@ocrTitle,@ocrJson,@format,@formatConf,@topic,@hookType,@evidence,
            @hasChart,@chartShare,@facePresent,@layout,@hasBurnedTitle,
            @classifiedAt)
    ON CONFLICT(shortcode) DO UPDATE SET
      views=excluded.views, likes=excluded.likes, comments=excluded.comments,
      z=excluded.z, display_mult=excluded.display_mult, is_outlier=excluded.is_outlier,
      mature=excluded.mature,
      media_dir=COALESCE(excluded.media_dir, post.media_dir),
      media_state=COALESCE(excluded.media_state, post.media_state),
      ocr_title=COALESCE(excluded.ocr_title, post.ocr_title),
      ocr_json=COALESCE(excluded.ocr_json, post.ocr_json),
      format=COALESCE(excluded.format, post.format),
      format_conf=COALESCE(excluded.format_conf, post.format_conf),
      topic=COALESCE(excluded.topic, post.topic),
      hook_type=COALESCE(excluded.hook_type, post.hook_type),
      evidence=COALESCE(excluded.evidence, post.evidence),
      has_chart=COALESCE(excluded.has_chart, post.has_chart),
      chart_share=COALESCE(excluded.chart_share, post.chart_share),
      face_present=COALESCE(excluded.face_present, post.face_present),
      layout=COALESCE(excluded.layout, post.layout),
      has_burned_title=COALESCE(excluded.has_burned_title, post.has_burned_title),
      classified_at=COALESCE(excluded.classified_at, post.classified_at)`);
  const metric = d.prepare(`INSERT INTO post_metric (shortcode, views, likes, comments)
                            VALUES (?,?,?,?)`);
  const tx = d.transaction(() => {
    for (const p of posts) {
      up.run({
        shortcode: p.shortcode, pageId, postUrl: p.postUrl ?? null, videoUrl: p.videoUrl ?? null,
        thumbUrl: p.thumbUrl ?? null, postedAt: p.postedAt ?? null, durationS: p.durationS ?? null,
        caption: p.caption ?? null, hashtags: p.hashtags ?? null, productType: p.productType ?? null,
        musicOriginal: p.musicOriginal ?? null, musicSong: p.musicSong ?? null,
        musicArtist: p.musicArtist ?? null, views: p.views ?? 0, likes: p.likes ?? 0,
        comments: p.comments ?? 0, z: p.z ?? null, displayMult: p.displayMult ?? null,
        isOutlier: p.isOutlier ?? 0, mature: p.mature ?? 1,
        // null = "unknown, keep what the row has". Passing 'pending' here demoted every post a
        // scrape merely re-listed (its media untouched) back to pending — measured: posts
        // with a video on disk flipping to pending on each refresh.
        mediaDir: p.mediaDir ?? null, mediaState: p.mediaState ?? null,
        ocrTitle: p.ocrTitle ?? null, ocrJson: p.ocrJson ?? null,
        format: p.format ?? null, formatConf: p.formatConf ?? null, topic: p.topic ?? null,
        hookType: p.hookType ?? null, evidence: p.evidence ?? null,
        hasChart: p.hasChart ?? null, chartShare: p.chartShare ?? null,
        facePresent: p.facePresent ?? null, layout: p.layout ?? null,
        hasBurnedTitle: p.hasBurnedTitle ?? null,
        classifiedAt: p.format ? new Date().toISOString() : null,
      });
      metric.run(p.shortcode, p.views ?? 0, p.likes ?? 0, p.comments ?? 0);
    }
    d.prepare('UPDATE page SET last_scraped=? WHERE id=?').run(new Date().toISOString(), pageId);
  });
  tx();
}

/** Gallery query. Defaults to the clips Mauricio actually wants: charts, not selfies. */
function listOutliers({
  targetOnly = true, minZ = null, page = null, topic = null, layout = null,
  downloadedOnly = true, limit = 200,
} = {}) {
  const where = ['p.views > 0'];
  const args = [];
  // An undownloaded row renders as an empty card — it has no poster, no video, no title.
  // Showing those made a third of the gallery blank boxes.
  if (downloadedOnly) where.push(`p.media_state = 'downloaded'`);
  if (layout) { where.push('p.layout = ?'); args.push(layout); }
  if (minZ != null) { where.push('p.z >= ?'); args.push(minZ); }
  if (page) { where.push('g.username = ?'); args.push(page); }
  if (topic) { where.push('p.topic = ?'); args.push(topic); }
  if (targetOnly) {
    /**
     * "Only the clips, not the selfie videos."
     *
     * A CHART MUST BE ON SCREEN. That is the whole definition, and the earlier version got
     * this wrong: it excluded lifestyle/meme/promo and let everything else through, so 14
     * talking_head and 10 talking_head_broll rows — exactly the selfie videos — showed up.
     *
     * A hand-set format_label always wins. Otherwise: an explicit screenshare label, or
     * chart attributes that prove a chart is there. Rows classified before the attributes
     * were stored fall back to the label alone, which is why a backfill exists.
     */
    where.push(`(
      p.format_label IN ('screenshare_teach','screenshare_recap')
      OR (
        p.format_label IS NULL
        AND (
          p.format IN ('screenshare_teach','screenshare_recap')
          OR (
            /*
             * The rescue clause, narrowed twice from experience.
             *
             * First it allowed anything that wasn't lifestyle/meme — which let 24
             * talking-head videos through. Then it required a chart on screen — which
             * still let through SELFIE videos that cut away to charts: "woman in a
             * restaurant, then cut-aways to day trading charts", "man on a patio with
             * cutaways to news footage". Those scored 35-65% chart share and are exactly
             * what we are trying to exclude.
             *
             * talking_head_broll IS the model telling us "a person talking, with
             * cutaways". Trust it. Only rescue when the COMPOSITION itself is a clip —
             * a split frame, a chart with a webcam inset, or a bare chart.
             */
            p.format NOT IN ('lifestyle','meme_repost','promo','podcast_clip','talking_head_broll')
            AND p.has_chart = 1
            AND p.layout IN ('split','pip','fullscreen_chart')
            AND COALESCE(p.chart_share, 0) >= 0.35
          )
        )
      )
    )`);
  }
  args.push(limit);
  return getDb().prepare(`
    SELECT p.*, g.username, g.is_client
    FROM post p JOIN page g ON g.id = p.page_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.z DESC LIMIT ?`).all(...args);
}

/** Counts per camera layout, for the gallery's facet rail. */
const layoutCounts = () => getDb().prepare(`
  SELECT p.layout, COUNT(*) n FROM post p
  WHERE p.media_state='downloaded' AND p.layout IS NOT NULL
  GROUP BY p.layout ORDER BY n DESC`).all();

const setFormatLabel = (shortcode, label) =>
  getDb().prepare('UPDATE post SET format_label=? WHERE shortcode=?').run(label, shortcode);

/**
 * The corpus that grounds clip selection.
 *
 * ONLY clip-format posts, and only ones whose transcript is real speech. This matters more
 * than it sounds: the highest-scoring posts on these pages are often memes and reposts
 * whose audio is music or film dialogue — Kendrick Lamar lyrics and Batman came back in
 * the top results. Grounding selection on those would teach it song lyrics.
 */
/**
 * Exemplars for grounded ranking: real posts WITH their measured outcome.
 *
 * `talking_head_broll` is excluded on BOTH branches, matching the gallery's clips-only
 * definition. It drifted once: the second branch admitted anything with a chart, so a
 * scripted macro essay about Japanese bond yields (which legitimately shows a chart, and
 * landed exactly on the 0.35 chart_share boundary) became the single highest-z exemplar
 * in the corpus at 95x. Every raw livestream candidate was then judged against a polished
 * essay reel it could never resemble, and the ranker cut 25 of 26 candidates.
 */
const groundingCorpus = ({ limit = 120 } = {}) => getDb().prepare(`
  SELECT p.shortcode, p.ocr_title, p.transcript, p.z, p.display_mult, p.topic, p.hook_type,
         g.username
  FROM post p JOIN page g ON g.id = p.page_id
  WHERE p.transcript IS NOT NULL
    AND LENGTH(p.transcript) > 120
    AND p.transcript NOT LIKE '%*music*%'
    AND (
      COALESCE(p.format_label, p.format) IN ('screenshare_teach','screenshare_recap')
      OR (p.has_chart = 1 AND COALESCE(p.chart_share,0) >= 0.35
          AND p.format NOT IN ('lifestyle','meme_repost','promo','podcast_clip',
                               'talking_head_broll'))
    )
  ORDER BY ABS(p.z) DESC
  LIMIT ?`).all(limit);

/** Scraped but never downloaded — invisible to the clips filter until processed. */
const pendingPosts = ({ minZ = 0, limit = 200 } = {}) =>
  getDb().prepare(`SELECT shortcode, post_url AS postUrl, video_url AS videoUrl,
                          caption, display_mult AS displayMult, z
                   FROM post
                   WHERE media_state = 'pending' AND views > 0 AND z >= ?
                   ORDER BY z DESC LIMIT ?`).all(minZ, limit);

/**
 * Apply one processed row WITHOUT destroying what is already there.
 *
 * The first version wrote `media_dir = r.mediaDir ?? null` and
 * `media_state = r.mediaState ?? 'failed'` unconditionally. A failed download therefore
 * cleared the path of a reel that was already on disk, and flipped a good row to 'failed'.
 * Observed: 239 rows marked failed while all 124 media files were still present — the data
 * was intact and only the bookkeeping was wrong, which is the worse kind of bug because
 * everything downstream silently sees an empty corpus.
 */
const applyPendingResult = (r) => {
  const d = getDb();
  const ok = r.mediaState === 'downloaded' && r.mediaDir;
  if (ok) {
    d.prepare(`UPDATE post SET media_dir=?, media_state='downloaded',
               ocr_title=COALESCE(?, ocr_title), ocr_json=COALESCE(?, ocr_json)
               WHERE shortcode=?`)
      .run(r.mediaDir, r.ocrTitle ?? null, r.ocrJson ?? null, r.shortcode);
  } else {
    // Record the failure but never clear a path or a state that already succeeded.
    d.prepare(`UPDATE post SET media_state = CASE WHEN media_state='downloaded'
               THEN media_state ELSE 'failed' END WHERE shortcode=?`).run(r.shortcode);
  }
  if (r.classification) updateClassification(r.shortcode, r.classification);
};

/** Rebuild media_state from what is actually on disk. The filesystem is the truth. */
function repairMediaState() {
  const fs = require('fs');
  const path = require('path');
  const d = getDb();
  const rows = d.prepare('SELECT shortcode, media_dir FROM post WHERE media_dir IS NOT NULL').all();
  const fix = d.prepare(`UPDATE post SET media_state=? WHERE shortcode=?`);
  let downloaded = 0;
  let gone = 0;
  const tx = d.transaction(() => {
    for (const r of rows) {
      if (fs.existsSync(path.join(r.media_dir, 'source.mp4'))) { fix.run('downloaded', r.shortcode); downloaded++; }
      else { fix.run('pending', r.shortcode); gone++; }
    }
  });
  tx();
  return { downloaded, gone, checked: rows.length };
}

/** Rows classified before the chart attributes were persisted — they need a re-run. */
const postsNeedingAttributes = (limit = 500) =>
  getDb().prepare(`SELECT shortcode, media_dir, ocr_title, caption FROM post
                   WHERE format IS NOT NULL AND has_chart IS NULL
                     AND media_state='downloaded' AND media_dir IS NOT NULL
                   LIMIT ?`).all(limit);

const updateClassification = (shortcode, c) =>
  getDb().prepare(`UPDATE post SET format=?, format_conf=?, has_chart=?, chart_share=?,
                   face_present=?, layout=?, has_burned_title=?, topic=?, hook_type=?,
                   evidence=?, classified_at=? WHERE shortcode=?`)
    .run(c.format, c.format_confidence ?? null, c.has_chart ? 1 : 0, c.chart_share ?? null,
         c.face_present ? 1 : 0, c.layout ?? null, c.has_burned_title ? 1 : 0,
         c.topic ?? null, c.hook_type ?? null, c.evidence ?? null,
         new Date().toISOString(), shortcode);

/* ------------------------------------------------------------------- tags */

/**
 * Editor-created tags on outlier posts (and, via clip_tag, on clips). A tag is a name the
 * team reuses — "reaction first", "ORB lesson", "copy this hook" — so the gallery can be
 * filtered by what the team has learned, not only by what the classifier guessed.
 */
const listTags = () => getDb().prepare(`
  SELECT t.*, (SELECT COUNT(*) FROM post_tag WHERE tag_id = t.id) AS post_count,
         (SELECT COUNT(*) FROM clip_tag WHERE tag_id = t.id) AS clip_count
  FROM tag t ORDER BY name COLLATE NOCASE`).all();

function createTag({ name, color = '#EC0B7A' }) {
  const d = getDb();
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('a tag needs a name');
  const existing = d.prepare('SELECT * FROM tag WHERE name = ? COLLATE NOCASE').get(clean);
  if (existing) return existing;
  const tid = id('tag');
  d.prepare('INSERT INTO tag (id, name, color) VALUES (?,?,?)').run(tid, clean, color);
  return d.prepare('SELECT * FROM tag WHERE id = ?').get(tid);
}

function updateTag(tagId, { name, color }) {
  const d = getDb();
  const cur = d.prepare('SELECT * FROM tag WHERE id = ?').get(tagId);
  if (!cur) return null;
  const next = {
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : cur.name,
    color: typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : cur.color,
  };
  d.prepare('UPDATE tag SET name=?, color=? WHERE id=?').run(next.name, next.color, tagId);
  return d.prepare('SELECT * FROM tag WHERE id = ?').get(tagId);
}

const deleteTag = (tagId) => getDb().prepare('DELETE FROM tag WHERE id = ?').run(tagId).changes;

/** Replace a post's tags with exactly this set. */
function setPostTags(shortcode, tagIds) {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM post_tag WHERE shortcode = ?').run(shortcode);
    const ins = d.prepare('INSERT OR IGNORE INTO post_tag (shortcode, tag_id) VALUES (?,?)');
    for (const t of tagIds) ins.run(shortcode, t);
  });
  tx();
  return tagsForPosts([shortcode])[shortcode] || [];
}

/** { shortcode: [tagId, …] } for a set of posts, in one query. */
function tagsForPosts(shortcodes) {
  if (!shortcodes.length) return {};
  const d = getDb();
  const out = {};
  const marks = shortcodes.map(() => '?').join(',');
  for (const r of d.prepare(`SELECT shortcode, tag_id FROM post_tag WHERE shortcode IN (${marks})`).all(...shortcodes)) {
    (out[r.shortcode] = out[r.shortcode] || []).push(r.tag_id);
  }
  return out;
}

module.exports = {
  listTags, createTag, updateTag, deleteTag, setPostTags, tagsForPosts,
  upsertPage, listPages, upsertPosts, listOutliers, setFormatLabel,
  postsNeedingAttributes, updateClassification, pendingPosts, applyPendingResult,
  groundingCorpus, layoutCounts, repairMediaState,
  getDb, id,
  upsertClient, listClients,
  createSource, updateSource, getSource, listSources, deleteSource, removeSourceFiles, activeJobsForSource,
  replaceClips, mergeClips, listClips, getClip, setClipComposition,
  addRender, listRenders,
  enqueue, claimJob, renewLease, finishJob, requestCancel, getJob, listJobs, reapStaleJobs,
  emit, eventsSince,
};
