// MusicBrainz "similar artists" lookup — replaces the Last.fm similar-artist
// service for music quiz distractors. No API key required; only a descriptive
// User-Agent (MusicBrainz requirement). The strategy:
//   1. Search for the artist on MusicBrainz.
//   2. Read the top tag(s) from the result.
//   3. Browse artists sharing the same tag to find plausible distractors.
//
// Results are cached in-memory per artist (process lifetime, same pattern as the
// old Last.fm service). Every call is best-effort: failures yield [].

const env = require('../config/env');

const MB_BASE = 'https://musicbrainz.org/ws/2';
const HTTP_TIMEOUT_MS = 6000;

// Process-lifetime cache keyed by lower-cased artist name.
const cache = new Map();

// Always enabled — no API key needed (unlike Last.fm).
function enabled() {
  return true;
}

function userAgent() {
  const app = env.appName || 'GameDo';
  const url = env.frontendUrl || 'https://gamedo.app';
  return `${app}/1.0 (${url})`;
}

async function httpGet(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find artists similar to `artist` via MusicBrainz tags.
 * Returns an array of artist name strings (for quiz distractors).
 *
 * @param {string} artist
 * @returns {Promise<string[]>}
 */
async function similarArtists(artist) {
  if (!artist || !artist.trim()) return [];

  const key = artist.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  let result = [];
  try {
    // Step 1: Search for the artist to get their MusicBrainz ID and tags.
    const searchUrl = `${MB_BASE}/artist/?query=artist:"${encodeURIComponent(artist)}"&fmt=json&limit=1`;
    const searchResp = await httpGet(searchUrl);
    if (!searchResp.ok) { cache.set(key, []); return []; }

    const searchData = await searchResp.json();
    const artists = searchData.artists;
    if (!Array.isArray(artists) || artists.length === 0) { cache.set(key, []); return []; }

    const match = artists[0];
    const tags = match.tags;

    // Take the top few tags (by count), not just one — querying several genre/style
    // tags yields a far larger, more varied candidate pool, so distractors stop
    // repeating across questions (which is what forced the fallback to reusing other
    // quiz artists).
    const topTags = (Array.isArray(tags) ? tags : [])
      .filter((t) => t && typeof t.name === 'string' && t.name.trim())
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 3)
      .map((t) => t.name.trim());

    if (topTags.length === 0) { cache.set(key, []); return []; }

    // Step 2: gather artists sharing each top tag (dedup, exclude the artist
    // themselves). Sequential to stay polite to MusicBrainz's ~1 req/s; each tag is
    // best-effort, so a single failed tag just contributes nothing.
    const seen = new Set([key]);
    for (const tag of topTags) {
      const tagUrl = `${MB_BASE}/artist/?query=tag:"${encodeURIComponent(tag)}"&fmt=json&limit=25`;
      // eslint-disable-next-line no-await-in-loop
      const tagResp = await httpGet(tagUrl);
      if (!tagResp.ok) continue;
      // eslint-disable-next-line no-await-in-loop
      const tagData = await tagResp.json();
      for (const a of (tagData.artists || [])) {
        if (a && typeof a.name === 'string' && a.name.trim()) {
          const lc = a.name.trim().toLowerCase();
          if (!seen.has(lc)) { seen.add(lc); result.push(a.name.trim()); }
        }
      }
    }
  } catch {
    // Network/parse/timeout failure — cache empty to avoid retry loop.
    result = [];
  }

  cache.set(key, result);
  return result;
}

/**
 * Other song TITLES by `artist` — used as plausible distractors for title-mode
 * music quizzes ("is it this song or that one by the same artist?"). Best-effort
 * MusicBrainz recording search, distinct by title (recordings repeat across
 * releases), cached per artist. Returns [] on any failure.
 *
 * @param {string} artist
 * @returns {Promise<string[]>}
 */
async function artistTitles(artist) {
  if (!artist || !artist.trim()) return [];

  const key = `rec:${artist.toLowerCase()}`; // prefixed so it can't collide with similarArtists
  if (cache.has(key)) return cache.get(key);

  let result = [];
  try {
    const url = `${MB_BASE}/recording/?query=artist:"${encodeURIComponent(artist)}"&fmt=json&limit=50`;
    const resp = await httpGet(url);
    if (resp.ok) {
      const data = await resp.json();
      const seen = new Set();
      for (const r of (data.recordings || [])) {
        if (r && typeof r.title === 'string' && r.title.trim()) {
          const t = r.title.trim();
          const lc = t.toLowerCase();
          if (!seen.has(lc)) { seen.add(lc); result.push(t); }
        }
      }
    }
  } catch {
    result = [];
  }

  cache.set(key, result);
  return result;
}

module.exports = {
  enabled,
  similarArtists,
  artistTitles,
  _clearCache: () => cache.clear(),
};
