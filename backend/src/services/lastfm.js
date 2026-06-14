// Last.fm "similar artists" lookup — the MERN port of rundan's `LastFmService.cs`.
//
// Optional: used to make the WRONG options in a multiple-choice music quiz feel
// like real near-misses. Entirely opt-in — with no LASTFM_API_KEY configured the
// integration is disabled and the quiz falls back to its own artists + the
// built-in pool (see musicLookup.buildChoices). Results are cached in memory
// (the C# service is a process-singleton) so a busy quiz hits the network at most
// once per artist, and every call is best-effort: any failure yields [].

const env = require('../config/env');

// Shared HTTP timeout (the C# "music" named HttpClient used 6 s).
const HTTP_TIMEOUT_MS = 6000;

// Process-lifetime cache, keyed by the LOWER-CASED artist name (mirrors the C#
// ConcurrentDictionary with a case-insensitive comparer — unbounded, no TTL,
// which matches the tiny workload). Caching the empty result on failure is
// INTENTIONAL: it stops a hot quiz loop from retrying a failing artist.
const cache = new Map();

// Enabled only when an API key is configured (RundanOptions.HasLastFm).
function enabled() {
  return env.hasLastFm;
}

/**
 * Parse artist names out of a Last.fm `artist.getsimilar` response.
 * JSON path: similarartists.artist[].name (string, non-empty), trimmed.
 * Malformed input → whatever parsed so far (usually []).
 *
 * @param {string} json
 * @returns {string[]}
 */
function parseSimilar(json) {
  const names = [];
  try {
    const root = JSON.parse(json);
    const arr = root && root.similarartists && root.similarartists.artist;
    if (Array.isArray(arr)) {
      for (const a of arr) {
        if (a && typeof a.name === 'string' && a.name.length > 0) {
          names.push(a.name.trim());
        }
      }
    }
  } catch {
    // malformed response — return whatever we managed to read (usually nothing)
  }
  return names;
}

/**
 * Similar artists for `artist`, as an array of names (for quiz distractors).
 * - Disabled or blank artist → [].
 * - Cached (case-insensitive) → the cached array.
 * - Else GET Last.fm artist.getsimilar; on ANY failure cache [] and return it.
 *
 * @param {string} artist
 * @returns {Promise<string[]>}
 */
async function similarArtists(artist) {
  if (!enabled() || !artist || !artist.trim()) {
    return [];
  }

  const key = artist.toLowerCase();
  if (cache.has(key)) {
    return cache.get(key);
  }

  let result;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const url = 'https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar'
      + `&artist=${encodeURIComponent(artist)}`
      + `&api_key=${encodeURIComponent(env.lastFmApiKey)}`
      + '&autocorrect=1&format=json&limit=12';
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': userAgent() },
    });
    // Non-2xx is treated as a failure (empty), same as the C# GetStringAsync throw path.
    result = resp.ok ? parseSimilar(await resp.text()) : [];
  } catch {
    // network/parse/timeout failure — cache the empty so we don't retry in a loop
    result = [];
  } finally {
    clearTimeout(timer);
  }

  cache.set(key, result);
  return result;
}

// Descriptive User-Agent (polite; harmless for Last.fm, required by MusicBrainz —
// kept consistent across the music integrations).
function userAgent() {
  const app = env.appName || 'Rundan';
  const url = env.frontendUrl || 'https://rundan.azurewebsites.net';
  return `${app}/1.0 (${url})`;
}

module.exports = {
  enabled,
  similarArtists,
  parseSimilar,
  // Exposed for tests — clears the process cache between cases.
  _clearCache: () => cache.clear(),
};
