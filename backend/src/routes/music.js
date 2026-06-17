// MusicEndpoints — the MERN port of Rundan.Server/Endpoints/MusicEndpoints.cs.
// Music-quiz helpers: design-time auto-fill (look up a track's title/artist/year),
// bulk playlist import, and the live "start a track" pacing that drives the
// Kahoot-style speed scoring (100 points minus the seconds taken to answer).
//
// All routes mount under the shared base `/api/activities` (see app.js); only this
// router's sub-paths are defined here. Every write authorizes "host OR event admin"
// via `activityManager` (the same gate as the rest of activity management).
const express = require('express');

const { Activity, Question } = require('../models');
const { ActivityType, QuestionKind } = require('../constants/enums');
const { idStr, musicPlaylistDto } = require('../services/serializers');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { activityManager } = require('../middleware/eventAuth');
const musicLookup = require('../services/musicLookup');
const spotify = require('../services/spotify');
const { pushScoreboard } = require('../services/scoreboard');
const { SPEED_WINDOW_SECONDS } = require('../services/scoring');
const emit = require('../socket/emit');

const router = express.Router();

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const MAX_PLAYLISTS = 12; // cap saved source playlists per quiz (bounds import work)

// A fresh Spotify access token for the activity's selected connection, or null
// (no connection, or the refresh failed → caller falls back to the free path).
// Mirrors how the C# endpoint prefers exact Spotify metadata when a connection
// is attached, then degrades to oEmbed + MusicBrainz.
async function tokenForActivity(activity) {
  const connId = activity.spotifyConnectionId;
  if (!connId) return null;
  try {
    const dto = await spotify.getPlaybackToken(connId);
    return dto ? dto.accessToken : null;
  } catch {
    return null; // refresh failed — let the free lookup carry on
  }
}

// A fresh Spotify access token for reading playlists (auth-only API): the quiz's
// selected connection, or any of the CALLER'S OWN saved connections. Throws a
// RuleViolation (not null) — the playlist endpoints can't degrade to a free path.
async function tokenForPlaylists(activity, req) {
  let connId = activity.spotifyConnectionId;
  if (!connId && req.user) {
    const { SpotifyConnection } = require('../models');
    const any = await SpotifyConnection.findOne({ ownerId: req.user.id }).select('_id').lean();
    connId = any ? any._id : null;
  }
  if (!connId) {
    throw new RuleViolation('Connect a Spotify account first (in host settings).');
  }
  const tokenDto = await spotify.getPlaybackToken(connId);
  if (!tokenDto) {
    throw new RuleViolation('That Spotify connection no longer exists.');
  }
  return tokenDto.accessToken;
}

// ── Auto-fill: look up a track's metadata (design-time host helper) ────────────

// POST /api/activities/:id/music/lookup — MusicLookupRequest { spotifyUrl } →
// MusicLookupResultDto. Uses the activity's saved Spotify connection (exact
// metadata via a short-lived access token) when one is selected; otherwise — or
// on miss — the free oEmbed + MusicBrainz path inside musicLookup.lookup.
router.post('/:id/music/lookup', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const url = (req.body || {}).spotifyUrl || '';

  const accessToken = await tokenForActivity(activity);
  res.json(await musicLookup.lookup(url, accessToken));
}));

// ── Source playlists: remembered on the quiz so the host can import more later ─

// POST /api/activities/:id/music/playlists — { playlistUrl } → { playlists }.
// Fetch the playlist's metadata and remember it on the activity (dedup by id).
// Adding a playlist does NOT import tracks — that's a separate step so several
// playlists can be staged before a round-robin import.
router.post('/:id/music/playlists', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  if (activity.type !== ActivityType.MusicQuiz) {
    throw new RuleViolation('Only a music quiz can use playlists.');
  }
  const playlistUrl = ((req.body || {}).playlistUrl || '').trim();
  const playlistId = musicLookup.tryGetPlaylistId(playlistUrl);
  if (!playlistId) {
    throw new RuleViolation("That doesn't look like a Spotify playlist link.");
  }

  // Already saved → no-op, just return the current list.
  if ((activity.musicPlaylists || []).some((p) => p.playlistId === playlistId)) {
    return res.json({ playlists: (activity.musicPlaylists || []).map(musicPlaylistDto) });
  }
  if ((activity.musicPlaylists || []).length >= MAX_PLAYLISTS) {
    throw new RuleViolation(`You can save up to ${MAX_PLAYLISTS} playlists per quiz.`);
  }

  const accessToken = await tokenForPlaylists(activity, req);
  const meta = await musicLookup.getPlaylistMeta(playlistUrl, accessToken);
  if (!meta) {
    throw new RuleViolation("Couldn't read that playlist — check the link, and that it's yours or public.");
  }

  activity.musicPlaylists.push({
    playlistId: meta.playlistId,
    url: playlistUrl.slice(0, 500),
    title: meta.title,
    ownerName: meta.ownerName,
    imageUrl: meta.imageUrl,
    trackCount: meta.trackCount,
    description: meta.description,
  });
  await activity.save();

  res.json({ playlists: activity.musicPlaylists.map(musicPlaylistDto) });
}));

// DELETE /api/activities/:id/music/playlists/:playlistId — drop a source playlist
// from the list (matched by its Spotify id or subdoc id). Already-imported tracks
// are kept. Returns the updated { playlists }.
router.delete('/:id/music/playlists/:playlistId', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const key = req.params.playlistId;
  const before = (activity.musicPlaylists || []).length;
  activity.musicPlaylists = (activity.musicPlaylists || [])
    .filter((p) => p.playlistId !== key && idStr(p) !== key);
  if (activity.musicPlaylists.length !== before) await activity.save();
  res.json({ playlists: activity.musicPlaylists.map(musicPlaylistDto) });
}));

// ── Bulk import: round-robin tracks from the saved playlists into the quiz ──────

// POST /api/activities/:id/music/import — { count, playlistUrl? } → { imported }.
// Picks `count` tracks round-robin across the activity's saved playlists, skipping
// tracks already added, and appends one FreeText Question per pick after the
// current max order. An optional `playlistUrl` is added to the saved list first
// (back-compat with the old paste-a-link-and-import flow).
router.post('/:id/music/import', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;
  const r = req.body || {};

  if (activity.type !== ActivityType.MusicQuiz) {
    throw new RuleViolation('Only a music quiz can import tracks.');
  }

  const accessToken = await tokenForPlaylists(activity, req);

  // Optional one-off link: remember it first (dedup) so the old single-step flow
  // (paste a playlist + import) still works.
  if (r.playlistUrl && r.playlistUrl.trim()) {
    const pid = musicLookup.tryGetPlaylistId(r.playlistUrl);
    if (!pid) throw new RuleViolation("That doesn't look like a Spotify playlist link.");
    if (!(activity.musicPlaylists || []).some((p) => p.playlistId === pid)) {
      if ((activity.musicPlaylists || []).length >= MAX_PLAYLISTS) {
        throw new RuleViolation(`You can save up to ${MAX_PLAYLISTS} playlists per quiz.`);
      }
      const meta = await musicLookup.getPlaylistMeta(r.playlistUrl, accessToken);
      if (!meta) {
        throw new RuleViolation("Couldn't read that playlist — check the link, and that it's yours or public.");
      }
      activity.musicPlaylists.push({
        playlistId: pid,
        url: r.playlistUrl.trim().slice(0, 500),
        title: meta.title,
        ownerName: meta.ownerName,
        imageUrl: meta.imageUrl,
        trackCount: meta.trackCount,
        description: meta.description,
      });
      await activity.save();
    }
  }

  const playlists = activity.musicPlaylists || [];
  if (playlists.length === 0) {
    throw new RuleViolation('Add a playlist first, then import tracks.');
  }

  const reqCount = Number(r.count);
  const count = clamp(Number.isFinite(reqCount) ? reqCount : 10, 1, 50);

  // Pull a generous, shuffled pool from each playlist (best-effort; skip failures).
  const perPlaylist = clamp(count * 6, 60, 300);
  const pools = [];
  for (const p of playlists) {
    // eslint-disable-next-line no-await-in-loop
    const pool = await musicLookup.importPlaylist(
      p.url || `spotify:playlist:${p.playlistId}`,
      perPlaylist,
      accessToken,
    );
    if (pool.length > 0) {
      pools.push(pool.map((t) => ({ t, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.t));
    }
  }
  if (pools.length === 0) {
    throw new RuleViolation('No playable tracks found in those playlists.');
  }

  // Skip tracks already on the quiz, so importing more adds NEW songs. Compare by
  // Spotify track id, since stored URLs vary (?si=, /intl-xx/, spotify:track:…).
  const existing = await Question.find({ activityId: id }).select('spotifyUrl').lean();
  const seen = new Set(existing.map((q) => musicLookup.tryGetTrackId(q.spotifyUrl)).filter(Boolean));

  // Round-robin: take one fresh track from each pool per cycle until we have
  // `count` (or every pool runs out of new tracks).
  const picked = [];
  const cursors = pools.map(() => 0);
  const done = pools.map(() => false);
  let pi = 0;
  while (picked.length < count && done.some((d) => !d)) {
    if (!done[pi]) {
      const pool = pools[pi];
      let chosen = null;
      while (cursors[pi] < pool.length) {
        const cand = pool[cursors[pi]];
        cursors[pi] += 1;
        const tid = musicLookup.tryGetTrackId(cand.spotifyUrl);
        if (tid && !seen.has(tid)) { seen.add(tid); chosen = cand; break; }
      }
      if (chosen) {
        picked.push(chosen);
      } else {
        done[pi] = true; // this pool has no more fresh tracks
      }
    }
    pi = (pi + 1) % pools.length;
  }

  const maxQ = await Question.findOne({ activityId: id }).sort({ order: -1 }).select('order').lean();
  let order = (maxQ ? maxQ.order : 0);

  const docs = picked.map((tr) => {
    order += 1;
    return {
      activityId: id,
      order,
      text: `Track ${order}`,
      kind: QuestionKind.FreeText,
      points: 1,
      spotifyUrl: tr.spotifyUrl,
      acceptedFreeTextAnswer: tr.title,
      acceptedArtist: tr.artist,
      releaseYear: tr.year,
    };
  });
  if (docs.length > 0) await Question.insertMany(docs);

  res.json({ imported: docs.length });
}));

// ── Live pacing: host starts a track for fastest-to-answer play ───────────────

// POST /api/activities/:id/music/start/:questionId — stamp playStartedUtc (drives
// the speed scoring), broadcast MusicTrackStarted to the activity room so every
// player's countdown begins, push the scoreboard, and return MusicTrackStartedDto.
// 404 if the question is not part of the activity.
router.post('/:id/music/start/:questionId', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;

  const question = await Question.findOne({ _id: req.params.questionId, activityId: id });
  if (!question) return res.status(404).json({ error: 'Question not found.' });

  const startedUtc = new Date();
  question.playStartedUtc = startedUtc;
  await question.save();

  const dto = {
    activityId: idStr(activity),
    questionId: idStr(question),
    startedUtc,
    windowSeconds: SPEED_WINDOW_SECONDS,
  };
  emit.musicTrackStarted(id, dto);
  await pushScoreboard(id);

  res.json(dto);
}));

module.exports = router;
