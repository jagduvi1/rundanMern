// Free music metadata lookup + multiple-choice helpers — the MERN port of
// rundan's `MusicLookupService.cs` and `MusicChoices.cs`.
//
//  - lookup(spotifyUrl)            → MusicLookupResultDto via Spotify (optional
//                                    access token) else Spotify oEmbed + MusicBrainz.
//  - importPlaylist(url, n, token) → best-effort bulk track read (needs a token).
//  - buildChoices(correct, …)      → deterministic 4-option artist picker.
//
// Every outbound call is best-effort with a short timeout: anything not found is
// left null for the host to type. MusicBrainz REQUIRES a descriptive User-Agent.

const env = require('../config/env');

const API_BASE = 'https://api.spotify.com/v1';
const HTTP_TIMEOUT_MS = 6000; // matches the C# "music" named HttpClient (6 s)

// ── Shared fetch with timeout + polite UA ─────────────────────────────────────

// Descriptive User-Agent — MusicBrainz rate-limits / rejects requests without one.
function userAgent() {
  const app = env.appName || 'Rundan';
  const url = env.frontendUrl || 'https://rundan.azurewebsites.net';
  return `${app}/1.0 (${url})`;
}

// GET with an AbortController timeout. `headers` is merged over the default UA.
// Returns the Response (caller checks `.ok`); throws on network/timeout so the
// caller's try/catch can swallow it.
async function httpGet(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': userAgent(), ...headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── ID parsers (ported verbatim from the C#) ──────────────────────────────────

// Trim a trailing query/fragment/path and validate the base-62 id shape
// (length 16–40, all alphanumeric). Returns null when it doesn't match.
function cleanId(rest) {
  const m = rest.search(/[?/#&]/);
  const id = (m >= 0 ? rest.slice(0, m) : rest).trim();
  return /^[A-Za-z0-9]+$/.test(id) && id.length >= 16 && id.length <= 40 ? id : null;
}

/**
 * Pull the track id out of a Spotify link or URI (open.spotify.com/track/…,
 * spotify:track:…, with optional /intl-xx/ locale and ?si= query). Null if it
 * isn't a recognisable Spotify track link. Port of MusicLookupService.TryGetTrackId.
 *
 * @param {string} url
 * @returns {string|null}
 */
function tryGetTrackId(url) {
  if (!url || !url.trim()) return null;
  const s = url.trim();

  let idx = s.toLowerCase().indexOf('track:');
  if (idx >= 0) return cleanId(s.slice(idx + 'track:'.length));

  idx = s.toLowerCase().indexOf('/track/');
  if (idx >= 0) return cleanId(s.slice(idx + '/track/'.length));

  return null;
}

/**
 * Pull the playlist id out of a Spotify playlist link or URI (…/playlist/ID,
 * spotify:playlist:ID). Port of SpotifyService.TryGetPlaylistId.
 *
 * @param {string} url
 * @returns {string|null}
 */
function tryGetPlaylistId(url) {
  if (!url || !url.trim()) return null;
  const s = url.trim();

  let idx = s.toLowerCase().indexOf('playlist:');
  if (idx >= 0) return cleanId(s.slice(idx + 'playlist:'.length));

  idx = s.toLowerCase().indexOf('/playlist/');
  if (idx >= 0) return cleanId(s.slice(idx + '/playlist/'.length));

  return null;
}

// ── Parsers (ported from the C#) ──────────────────────────────────────────────

const nullIfBlank = (s) => (s && s.trim() ? s.trim() : null);

// Year only if 1860 ≤ year ≤ 2100 (rejects garbage release dates). Accepts a
// "YYYY-..." date string; returns null otherwise.
function parseYear(date) {
  if (typeof date !== 'string' || date.length < 4) return null;
  const y = parseInt(date.slice(0, 4), 10);
  return Number.isInteger(y) && y >= 1860 && y <= 2100 ? y : null;
}

// The "title" field of a Spotify oEmbed response (the track name).
function parseOEmbedTitle(json) {
  try {
    const root = JSON.parse(json);
    return typeof root.title === 'string' ? nullIfBlank(root.title) : null;
  } catch {
    return null;
  }
}

// Best recording match's artist + release year from a MusicBrainz recording search.
function parseMusicBrainz(json) {
  try {
    const root = JSON.parse(json);
    const recs = root.recordings;
    if (!Array.isArray(recs) || recs.length === 0) return { artist: null, year: null };

    const best = recs[0]; // results come back sorted by score
    let artist = null;
    const ac = best['artist-credit'];
    if (Array.isArray(ac) && ac.length > 0 && typeof ac[0].name === 'string') {
      artist = nullIfBlank(ac[0].name);
    }
    const year = parseYear(best['first-release-date']);
    return { artist, year };
  } catch {
    return { artist: null, year: null };
  }
}

// Build a MusicLookupResultDto with the computed `found` flag.
function result({ title = null, artist = null, year = null, source = 'none' } = {}) {
  return {
    title,
    artist,
    year,
    source,
    found: !!(title || artist || (year != null)),
  };
}

// ── Spotify exact track (via an access token) ─────────────────────────────────

// GET /tracks/{id} with a Bearer token → MusicLookupResultDto (source "Spotify").
// ANY failure → null (caller falls back to the free path). Port of
// SpotifyService.GetTrackAsync's HTTP half (token management lives in spotify.js).
async function lookupTrackWithToken(trackId, accessToken) {
  if (!trackId || !accessToken) return null;
  try {
    const resp = await httpGet(`${API_BASE}/tracks/${trackId}`, {
      Authorization: `Bearer ${accessToken}`,
    });
    if (!resp.ok) return null;

    const root = await resp.json();
    const title = typeof root.name === 'string' ? root.name : null;
    let artist = null;
    if (Array.isArray(root.artists) && root.artists.length > 0 && root.artists[0]
        && typeof root.artists[0].name === 'string') {
      artist = root.artists[0].name;
    }
    const year = root.album ? parseYear(root.album.release_date) : null;
    return result({ title, artist, year, source: 'Spotify' });
  } catch {
    return null;
  }
}

// ── Free lookup: Spotify oEmbed (title) + MusicBrainz (artist + year) ──────────

/**
 * Auto-fill a Spotify track's title/artist/year. If `accessToken` is supplied
 * the exact Spotify path is tried first (returns immediately if it found
 * anything); otherwise — or on miss — falls back to the free oEmbed + MusicBrainz
 * path. Port of MusicLookupService.LookupAsync, with the Spotify-first preference
 * the C# MusicEndpoints applied around it.
 *
 * @param {string} spotifyUrl  track link or URI
 * @param {string} [accessToken]  optional fresh Spotify access token
 * @returns {Promise<{title:?string,artist:?string,year:?number,source:string,found:boolean}>}
 */
async function lookup(spotifyUrl, accessToken = null) {
  const trackId = tryGetTrackId(spotifyUrl);
  if (!trackId) {
    return result(); // not a recognisable Spotify track link — nothing to look up
  }

  // Exact Spotify first when we have a token — return it if it found anything.
  if (accessToken) {
    const exact = await lookupTrackWithToken(trackId, accessToken);
    if (exact && exact.found) return exact;
  }

  let title = null;
  let artist = null;
  let year = null;

  // 1) Title via Spotify oEmbed (public, no auth).
  try {
    const canonical = `https://open.spotify.com/track/${trackId}`;
    const resp = await httpGet(`https://open.spotify.com/oembed?url=${encodeURIComponent(canonical)}`);
    if (resp.ok) title = parseOEmbedTitle(await resp.text());
  } catch {
    // oEmbed unavailable — carry on, MusicBrainz may still find the title via the artist.
  }

  // 2) Artist + year via MusicBrainz (needs a title to search on).
  if (title && title.trim()) {
    try {
      const query = encodeURIComponent(`recording:"${title}"`);
      const resp = await httpGet(`https://musicbrainz.org/ws/2/recording/?query=${query}&fmt=json&limit=5`);
      if (resp.ok) {
        const mb = parseMusicBrainz(await resp.text());
        artist = mb.artist;
        year = mb.year;
      }
    } catch {
      // MusicBrainz unavailable — keep the title we found.
    }
  }

  const found = !!(title || artist || (year != null));
  return result({ title, artist, year, source: found ? 'oEmbed + MusicBrainz' : 'none' });
}

// ── Playlist import (best-effort) ─────────────────────────────────────────────

// Parse one page of a /playlists/{id}/tracks response into tracks (skipping
// local/empty entries) + the next-page URL. Port of SpotifyService.ParsePlaylistPage.
function parsePlaylistPage(json) {
  const list = [];
  let next = null;
  try {
    const root = JSON.parse(json);
    if (typeof root.next === 'string') next = root.next;

    if (Array.isArray(root.items)) {
      for (const it of root.items) {
        const t = it && it.track;
        if (!t || typeof t !== 'object') continue;
        if (t.is_local === true) continue;
        const id = typeof t.id === 'string' ? t.id : null;
        if (!id) continue;

        let artist = null;
        if (Array.isArray(t.artists) && t.artists.length > 0 && t.artists[0]
            && typeof t.artists[0].name === 'string') {
          artist = t.artists[0].name;
        }
        const year = t.album ? parseYear(t.album.release_date) : null;

        list.push({
          title: typeof t.name === 'string' ? t.name : null,
          artist,
          year,
          spotifyUrl: `https://open.spotify.com/track/${id}`,
        });
      }
    }
  } catch {
    // malformed page — return whatever parsed
  }
  return { tracks: list, next };
}

/**
 * Bulk-read a playlist's tracks (title/artist/year + the track link), following
 * pages up to `count`. Best-effort: requires a valid Spotify access token (the
 * playlist API is auth-only). Returns [] when the URL isn't a playlist or no
 * token is supplied. Port of SpotifyService.GetPlaylistTracksAsync (paging +
 * guards: stop when next is null, collected ≥ count, or after 12 pages).
 *
 * @param {string} playlistUrl
 * @param {number} count  max tracks to collect
 * @param {string} accessToken  a fresh Spotify access token
 * @returns {Promise<Array<{title:?string,artist:?string,year:?number,spotifyUrl:string}>>}
 */
async function importPlaylist(playlistUrl, count, accessToken) {
  const playlistId = tryGetPlaylistId(playlistUrl);
  const max = Number.isFinite(count) && count > 0 ? count : 10;
  if (!playlistId || !accessToken) return [];

  const all = [];
  const fields = encodeURIComponent('items(track(id,name,is_local,artists(name),album(release_date))),next');
  let url = `${API_BASE}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=50&fields=${fields}`;

  for (let guard = 0; url && all.length < max && guard < 12; guard += 1) {
    let resp;
    try {
      // eslint-disable-next-line no-await-in-loop
      resp = await httpGet(url, { Authorization: `Bearer ${accessToken}` });
    } catch {
      break; // network/timeout — return whatever we have so far (best-effort)
    }
    if (!resp.ok) break; // Spotify rejected the page — stop, keep what we collected

    // eslint-disable-next-line no-await-in-loop
    const { tracks, next } = parsePlaylistPage(await resp.text());
    all.push(...tracks);
    url = next;
  }

  return all.slice(0, max);
}

// ── MusicChoices: deterministic multiple-choice artist options ────────────────

// A spread of widely-known artists across eras/genres (exact port of
// MusicChoices.Pool, 46 entries, UTF-8 preserved), used to fill out the wrong
// options when a quiz doesn't have enough of its own artists.
const POOL = [
  'ABBA', 'Queen', 'The Beatles', 'Madonna', 'Michael Jackson', 'Elton John', 'David Bowie',
  'U2', 'Coldplay', 'Adele', 'Beyoncé', 'Rihanna', 'Taylor Swift', 'Ed Sheeran', 'Bruno Mars',
  'Drake', 'Eminem', 'Kanye West', 'Lady Gaga', 'Katy Perry', 'Justin Bieber', 'Maroon 5',
  'Bob Dylan', 'Bruce Springsteen', 'Prince', 'Whitney Houston', 'Mariah Carey', 'Stevie Wonder',
  'Nirvana', 'Red Hot Chili Peppers', 'Metallica', 'AC/DC', 'Pink Floyd', 'Led Zeppelin',
  'The Rolling Stones', 'Fleetwood Mac', 'Daft Punk', 'The Weeknd', 'Dua Lipa', 'Billie Eilish',
  'Avicii', 'Robyn', 'Roxette', 'Kent', 'Veronica Maggio', 'Håkan Hellström',
];

// Hash an arbitrary seed (Mongo ObjectId string, number, …) to a 32-bit uint.
// C# uses `new Random(question.Id)` with an int id; our ids are strings, so we
// derive a stable numeric seed from the id (FNV-1a). The requirement is only that
// the order is STABLE per id and identical for everyone — not byte-identical to C#.
function hashSeed(seed) {
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 — a tiny, fast, seedable PRNG. Same seed → same sequence on every
// server call and every client (zero deps, ~5 lines).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stable "OrderBy(rng.Next())" — sorts by a freshly drawn random key per element,
// using a seeded Schwartzian transform so it's deterministic for a given rng.
function orderByRandom(items, rng) {
  return items
    .map((value) => ({ value, key: rng() }))
    .sort((x, y) => x.key - y.key)
    .map((p) => p.value);
}

// Case-insensitive distinct, preserving first-seen order.
function distinctCi(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const k = item.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/**
 * Build the multiple-choice options for ONE music-quiz question: the correct
 * artist plus three distractors, all shuffled into `AnswerOptionDto`s. Pure +
 * deterministic per `seed` (the question id) so options and their order are
 * stable across reloads and identical for every player. The correct artist is
 * NEVER flagged — it's matched server-side by text. Port of MusicChoices.Populate
 * (per-question logic).
 *
 * Distractor tiers (each excludes the correct answer, shuffled within the tier
 * with the seeded RNG, then concatenated in priority order, ci-distinct, take 3):
 *   1. Last.fm similar artists for `correct` (if provided)
 *   2. the quiz's OTHER artists
 *   3. the built-in pool (entries not already among the quiz artists)
 *
 * @param {string} correctArtist  the accepted artist for this question
 * @param {object} [opts]
 * @param {string|number} [opts.seed]  stable per-question seed (the question id)
 * @param {string[]} [opts.similar]  Last.fm similar artists for `correctArtist`
 * @param {string[]} [opts.quizArtists]  distinct accepted artists across the quiz
 * @returns {Array<{id:number,order:number,text:string}>}  empty if no correct artist
 */
function buildChoices(correctArtist, opts = {}) {
  const correct = (correctArtist || '').trim();
  if (correct.length === 0) return []; // artist-less track stays a typed track

  const { seed = correct, similar = [], quizArtists = [] } = opts;
  const rng = mulberry32(hashSeed(seed));
  const notCorrect = (a) => a.toLowerCase() !== correct.toLowerCase();

  // Distinct quiz artists (ci), used both as a tier and to filter the pool.
  const quiz = distinctCi(quizArtists.map((a) => (a || '').trim()).filter((a) => a.length > 0));
  const quizLower = new Set(quiz.map((a) => a.toLowerCase()));

  const tier1 = orderByRandom(distinctCi((similar || []).filter(notCorrect)), rng);
  const tier2 = orderByRandom(quiz.filter(notCorrect), rng);
  const tier3 = orderByRandom(POOL.filter((p) => !quizLower.has(p.toLowerCase())), rng);

  const distractors = distinctCi([...tier1, ...tier2, ...tier3]).slice(0, 3);

  return orderByRandom([...distractors, correct], rng)
    .map((text, i) => ({ id: i, order: i, text }));
}

/**
 * Populate `dtos[].options` for a whole music quiz, in place. Convenience wrapper
 * around buildChoices mirroring MusicChoices.Populate's signature — pass the
 * player-facing question DTOs, the question docs (each with `acceptedArtist` +
 * `_id`/`id`), and an optional Last.fm similar-artist map.
 *
 * @param {Array<{id:string,options:any[]}>} dtos
 * @param {Array<{acceptedArtist?:string}>} questions  (matched to dtos by id)
 * @param {Map<string,string[]>|Object} [similar]  artist → similar names
 */
function populateChoices(dtos, questions, similar = null) {
  const get = (m, k) => {
    if (!m) return undefined;
    if (m instanceof Map) return m.get(k);
    return m[k];
  };
  const idOf = (x) => String(x && (x._id !== undefined ? x._id : x.id));

  const quizArtists = questions
    .map((q) => (q.acceptedArtist || '').trim())
    .filter((a) => a.length > 0);

  for (const q of questions) {
    const correct = (q.acceptedArtist || '').trim();
    if (correct.length === 0) continue;
    const dto = dtos.find((d) => String(d.id) === idOf(q));
    if (!dto) continue;

    dto.options = buildChoices(correct, {
      seed: idOf(q),
      similar: get(similar, correct) || [],
      quizArtists,
    });
  }
}

module.exports = {
  lookup,
  importPlaylist,
  buildChoices,
  populateChoices,
  // Parsers / id helpers exported for reuse + tests.
  tryGetTrackId,
  tryGetPlaylistId,
  parseOEmbedTitle,
  parseMusicBrainz,
  parsePlaylistPage,
  lookupTrackWithToken,
  POOL,
};
