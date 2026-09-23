/**
 * The outlier corpus pipeline.
 *
 *   scrape → score → download the winners → frames → OCR the title → classify → store
 *
 * Ordering matters for one hard reason: Instagram's CDN video URLs expire within days. A
 * scraped row whose media was not fetched in the SAME run is dead — the url 403s later.
 * So download happens immediately after scoring, never as a separate pass.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { scrapePage, scorePage, pageStats } = require('./scrape');
const { extractTitle } = require('./ocr-title');
const { classifyReel, isTargetFormat } = require('./classify');

const OCR_BIN = require('../paths').binPath('frame-ocr');
const ffmpeg = () => process.env.FFMPEG_BIN || require('ffmpeg-static');

/** Download a reel. Prefer the post URL — yt-dlp re-resolves a fresh signed CDN url. */
async function downloadReel(post, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'source.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  try {
    await execFileAsync('yt-dlp', [
      '--no-warnings', '--no-playlist', '--no-part',
      '-f', 'bv*+ba/b', '--merge-output-format', 'mp4',
      '-o', out, post.postUrl,
    ], { maxBuffer: 1e8 });
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  } catch { /* fall through to the direct CDN url */ }

  if (post.videoUrl) {
    const res = await fetch(post.videoUrl);
    if (res.ok) {
      fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      if (fs.statSync(out).size > 0) return out;
    }
  }
  throw new Error('could not download reel');
}

/** Sample frames for OCR (1fps over the first 12s) and for the classifier (4 spread). */
function extractFrames(videoPath, dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(ffmpeg(), [
    '-y', '-v', 'error', '-i', videoPath,
    '-vf', 'fps=1,scale=1080:-2', '-frames:v', '12', '-q:v', '3',
    path.join(dir, 'f%02d.jpg'),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
    .map((f) => path.join(dir, f));
}

function ocrFrames(files) {
  if (!files.length) return [];
  const out = execFileSync(OCR_BIN, files, { encoding: 'utf8', maxBuffer: 1e8 });
  return JSON.parse(out);
}

/**
 * Process one page end to end.
 * `onProgress` gets a message per meaningful step so the UI can show what is happening.
 */
async function processPage(username, {
  mediaRoot, days = 60, threshold = 1.5, maxDownloads = 40,
  negativeSample = 6, onProgress = () => {}, classify = true,
}) {
  onProgress({ stage: 'scrape', message: `${username}: fetching last ${days} days` });
  const raw = await scrapePage(username, { days });
  if (!raw.length) return { username, posts: [], stats: null, downloaded: 0 };

  const scored = scorePage(raw, { threshold });
  const stats = pageStats(raw);
  // pageStats returns null when NO post carries a view count — a page of photos and
  // carousels. Dereferencing it here crashed the whole page and lost it silently:
  // dovy.fxtrading and tradermayne both vanished from the corpus this way.
  onProgress({
    stage: 'score',
    message: stats
      ? `${username}: ${scored.length} posts, ${scored.filter((p) => p.isOutlier).length} outliers (typical ${stats.typicalViews.toLocaleString()} views)`
      : `${username}: ${scored.length} posts, no video view counts (photos/carousels only)`,
  });

  /**
   * What to fetch.
   *
   * Downloading only the flagged outliers made the gallery nearly empty — a 60-day window
   * yields very few posts at z >= 1.5, and an editor browsing "what's working" needs to see
   * the field, not three survivors. So: everything above the page's typical performance,
   * capped, PLUS a deliberate sample of flops.
   *
   * The flops are not filler. Without examples of what failed on the SAME page, later
   * selection can only learn "a trading clip" rather than the difference between a winner
   * and a dud — which is the actual question.
   */
  const ranked = scored.filter((p) => p.views > 0).sort((a, b) => b.z - a.z);
  const winners = ranked.filter((p) => p.z >= 0).slice(0, maxDownloads);
  const flops = ranked.filter((p) => p.z < -0.4).slice(-negativeSample);
  const toFetch = [...winners, ...flops];

  let downloaded = 0;
  for (const post of toFetch) {
    const dir = path.join(mediaRoot, post.shortcode);
    try {
      onProgress({ stage: 'download', message: `${post.shortcode} (${post.displayMult}x)` });
      const video = await downloadReel(post, dir);
      post.mediaDir = dir;
      post.mediaState = 'downloaded';
      downloaded++;

      const frames = extractFrames(video, path.join(dir, 'frames'));
      const ocr = ocrFrames(frames);
      const t = extractTitle(ocr);
      post.ocrTitle = t.title;
      post.ocrJson = JSON.stringify({ confidence: t.confidence, lines: t.lines });
      if (t.title) onProgress({ stage: 'ocr', message: `"${t.title.slice(0, 60)}"` });

      if (classify && frames.length) {
        /*
         * Classification is its OWN failure domain. It used to share this try block with
         * the download, so when the model call failed (measured: 123 posts in one run, the
         * API account out of credit) the post was marked `failed` — overwriting the
         * `downloaded` state of a file that was sitting intact on disk. The gallery,
         * transcription and title-reading all filter on `downloaded`, so one billing
         * problem emptied the whole corpus view while 330 videos sat on disk.
         */
        try {
          const pick = [1, 4, 7, 10].map((i) => frames[Math.min(i, frames.length - 1)]).filter(Boolean);
          const uniq = [...new Set(pick)];
          const b64 = uniq.map((f) => fs.readFileSync(f).toString('base64'));
          const c = await classifyReel({ frames: b64, title: t.title, caption: post.caption });
          Object.assign(post, {
            format: c.format, formatConf: c.format_confidence,
            hasChart: c.has_chart ? 1 : 0, chartShare: c.chart_share ?? null,
            facePresent: c.face_present ? 1 : 0, layout: c.layout,
            hasBurnedTitle: c.has_burned_title ? 1 : 0,
            topic: c.topic, hookType: c.hook_type, evidence: c.evidence,
            isTarget: isTargetFormat(c) ? 1 : 0,
          });
          onProgress({ stage: 'classify', message: `${post.shortcode}: ${c.format} / ${c.topic}` });
        } catch (err) {
          post.classifyError = String(err.message).slice(0, 200);
          onProgress({ stage: 'classify', message: `${post.shortcode}: not classified (${post.classifyError.slice(0, 80)}) — downloaded, will retry later`, level: 'error' });
        }
      }
    } catch (err) {
      // Only the DOWNLOAD failing gets here now.
      post.mediaState = 'failed';
      post.error = String(err.message).slice(0, 200);
      onProgress({ stage: 'error', message: `${post.shortcode}: ${post.error}`, level: 'error' });
    }
  }

  return { username, posts: scored, stats, downloaded };
}

/**
 * Download + OCR + classify a set of ALREADY-SCRAPED posts.
 *
 * The first pass caps downloads per page, so most scraped posts stay metadata-only and are
 * invisible to the clips filter — they have no format and no chart data. This processes
 * them without re-scraping.
 *
 * Instagram CDN urls expire, so downloadReel resolves from the POST url via yt-dlp first,
 * which mints a fresh one; the stored videoUrl is only a fallback.
 */
async function processPending(posts, { mediaRoot, onProgress = () => {}, classify = true }) {
  const out = [];
  for (const post of posts) {
    const dir = path.join(mediaRoot, post.shortcode);
    try {
      onProgress({ stage: 'download', message: `${post.shortcode} (${post.displayMult ?? '?'}x)` });
      const video = await downloadReel({ postUrl: post.postUrl, videoUrl: post.videoUrl }, dir);
      const frames = extractFrames(video, path.join(dir, 'frames'));
      const t = extractTitle(ocrFrames(frames));

      const rec = {
        shortcode: post.shortcode, mediaDir: dir, mediaState: 'downloaded',
        ocrTitle: t.title, ocrJson: JSON.stringify({ confidence: t.confidence, lines: t.lines }),
      };
      if (t.title) onProgress({ stage: 'ocr', message: `"${t.title.slice(0, 60)}"` });

      if (classify && frames.length) {
        const pick = [1, 4, 7, 10].map((i) => frames[Math.min(i, frames.length - 1)]);
        const b64 = [...new Set(pick)].map((f) => fs.readFileSync(f).toString('base64'));
        const c = await classifyReel({ frames: b64, title: t.title, caption: post.caption });
        Object.assign(rec, { classification: c });
        onProgress({ stage: 'classify', message: `${post.shortcode}: ${c.format} (chart ${c.has_chart ? Math.round((c.chart_share ?? 0) * 100) + '%' : 'no'})` });
      }
      out.push(rec);
    } catch (err) {
      out.push({ shortcode: post.shortcode, mediaState: 'failed' });
      onProgress({ stage: 'error', message: `${post.shortcode}: ${String(err.message).slice(0, 140)}`, level: 'error' });
    }
  }
  return out;
}

/**
 * Transcribe downloaded outlier reels.
 *
 * Without this the corpus knows what these clips LOOK like and what their titles say, but
 * nothing about what the trader actually says — which is precisely what clip selection
 * needs to answer "does this moment resemble what works on these pages". Local whisper.cpp,
 * so it costs nothing but time.
 */
async function transcribeOutlier(mediaDir) {
  const { transcribe } = require('../transcribe');
  const { toWav16k } = require('../ingest');
  const video = path.join(mediaDir, 'source.mp4');
  if (!fs.existsSync(video)) throw new Error('no source.mp4');
  const wav = path.join(mediaDir, 'audio.16k.wav');
  if (!fs.existsSync(wav)) await toWav16k(video, wav);
  const t = await transcribe(wav);
  return { text: (t.text || '').trim(), words: t.words.length };
}

module.exports = { processPage, processPending, transcribeOutlier, downloadReel, extractFrames, ocrFrames };
