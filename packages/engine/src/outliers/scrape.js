/**
 * Instagram outlier scraping + scoring.
 *
 * Ported from the proven sfc-system Apify client, with the scoring replaced.
 *
 * WHY THE SCORING CHANGED: the existing system divides by the creator's MEAN views. Views
 * are log-normal, so the mean sits well above the median — measured on rp.profits, mean
 * 54,079 vs median 44,284 — which makes a typical post score below 1.0 and compresses the
 * whole scale. Worse, the spread differs enormously between pages, so no single ratio
 * threshold is comparable across them. This uses a robust z-score in log space against the
 * page's own median, and shows editors a multiplier because a multiplier is legible.
 */

const MEDIA_ACTOR = 'apify~instagram-scraper';

function token() {
  const t = process.env.APIFY_API_TOKEN;
  if (!t) throw new Error('APIFY_API_TOKEN not set');
  return t;
}

/**
 * Scrape one page's recent posts.
 * NOTE: Apify does NOT return results in input order — always match by shortCode.
 */
async function scrapePage(username, { days = 60, limit = 120 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const res = await fetch(
    `https://api.apify.com/v2/acts/${MEDIA_ACTOR}/run-sync-get-dataset-items?token=${token()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directUrls: [`https://www.instagram.com/${username}/`],
        resultsType: 'posts',
        resultsLimit: limit,
        onlyPostsNewerThan: since,
        addParentData: false,
      }),
    }
  );
  if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const items = await res.json();
  return (Array.isArray(items) ? items : []).map(normalise).filter(Boolean);
}

function normalise(r) {
  if (!r || !r.shortCode) return null;
  const mi = r.musicInfo || {};
  return {
    shortcode: r.shortCode,
    postUrl: r.url || `https://www.instagram.com/p/${r.shortCode}/`,
    videoUrl: r.videoUrl || null,
    thumbUrl: r.displayUrl || null,
    postedAt: r.timestamp || null,
    durationS: r.videoDuration ?? null,
    caption: r.caption || '',
    hashtags: JSON.stringify(r.hashtags || []),
    productType: r.productType || r.type || null,
    musicOriginal: mi.uses_original_audio ? 1 : 0,
    musicSong: mi.song_name || null,
    musicArtist: mi.artist_name || null,
    views: r.videoPlayCount ?? r.videoViewCount ?? 0,
    likes: r.likesCount ?? 0,
    comments: r.commentsCount ?? 0,
    ownerUsername: r.ownerUsername || null,
  };
}

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Robust z-score in log space, against the page's own recent distribution.
 *
 *   mu    = median(ln views)
 *   sigma = 1.4826 * MAD(ln views)      (robust standard deviation)
 *   z     = (ln(views) - mu) / max(sigma, 0.25)
 *
 * `displayMult` = views / exp(mu), i.e. "3.4x this page's typical reel" — what the gallery
 * shows, because a z-score means nothing to an editor.
 *
 * Posts younger than `matureDays` are scored but flagged immature: a two-day-old reel has
 * not finished accumulating views and would otherwise always look like a flop.
 */
function scorePage(posts, { threshold = 1.5, matureDays = 5 } = {}) {
  const withViews = posts.filter((p) => (p.views || 0) > 0);
  if (withViews.length < 3) {
    return posts.map((p) => ({ ...p, z: 0, displayMult: 1, isOutlier: 0, mature: 1 }));
  }
  const logs = withViews.map((p) => Math.log(p.views));
  const mu = median(logs);
  const mad = median(logs.map((l) => Math.abs(l - mu)));
  const sigma = Math.max(1.4826 * mad, 0.25);
  const typical = Math.exp(mu);
  const now = Date.now();

  return posts.map((p) => {
    const v = p.views || 0;
    if (v <= 0) return { ...p, z: 0, displayMult: 0, isOutlier: 0, mature: 1 };
    const z = (Math.log(v) - mu) / sigma;
    const ageDays = p.postedAt ? (now - new Date(p.postedAt).getTime()) / 86400000 : 99;
    const mature = ageDays >= matureDays ? 1 : 0;
    return {
      ...p,
      z: +z.toFixed(3),
      displayMult: +(v / typical).toFixed(2),
      // Immature posts are scored but never promoted — they'd dominate on velocity alone.
      isOutlier: z >= threshold && v >= typical && mature ? 1 : 0,
      mature,
    };
  });
}

/** Stats for a page, for the UI to explain what a multiplier is relative to. */
function pageStats(posts) {
  const v = posts.filter((p) => p.views > 0).map((p) => p.views);
  if (!v.length) return null;
  const logs = v.map(Math.log);
  const mu = median(logs);
  return {
    n: v.length,
    typicalViews: Math.round(Math.exp(mu)),
    medianViews: Math.round(median(v)),
    maxViews: Math.max(...v),
  };
}

module.exports = { scrapePage, scorePage, pageStats, median };
