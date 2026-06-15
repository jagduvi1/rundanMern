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
  const app = env.appName || 'Rundan';
  const url = env.frontendUrl || 'https://rundan.azurewebsites.net';
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

    // Extract the top tag (highest count) to find related artists.
    let topTag = null;
    if (Array.isArray(tags) && tags.length > 0) {
      // Sort by count descending, pick the best one.
      const sorted = tags
        .filter((t) => t && typeof t.name === 'string' && t.name.trim())
        .sort((a, b) => (b.count || 0) - (a.count || 0));
      if (sorted.length > 0) topTag = sorted[0].name.trim();
    }

    if (!topTag) { cache.set(key, []); return []; }

    // Step 2: Search for other artists with the same tag.
    const tagUrl = `${MB_BASE}/artist/?query=tag:"${encodeURIComponent(topTag)}"&fmt=json&limit=15`;
    const tagResp = await httpGet(tagUrl);
    if (!tagResp.ok) { cache.set(key, []); return []; }

    const tagData = await tagResp.json();
    const related = tagData.artists;
    if (Array.isArray(related)) {
      for (const a of related) {
        if (a && typeof a.name === 'string' && a.name.trim()) {
          const name = a.name.trim();
          // Exclude the artist themselves.
          if (name.toLowerCase() !== key) {
            result.push(name);
          }
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

module.exports = {
  enabled,
  similarArtists,
  _clearCache: () => cache.clear(),
};
