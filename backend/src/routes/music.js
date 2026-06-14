// MusicEndpoints — the MERN port of Rundan.Server/Endpoints/MusicEndpoints.cs.
// Music-quiz helpers: design-time auto-fill (look up a track's title/artist/year),
// bulk playlist import, and the live "start a track" pacing that drives the
// fastest-to-answer speed bonus.
//
// All routes mount under the shared base `/api/activities` (see app.js); only this
// router's sub-paths are defined here. Every write authorizes "host OR event admin"
// via `activityManager` (the same gate as the rest of activity management).
const express = require('express');

const { Activity, Question } = require('../models');
const { ActivityType, QuestionKind } = require('../constants/enums');
const { idStr } = require('../services/serializers');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { activityManager } = require('../middleware/eventAuth');
const musicLookup = require('../services/musicLookup');
const spotify = require('../services/spotify');
const { pushScoreboard } = require('../services/scoreboard');
const { SPEED_WINDOW_SECONDS } = require('../services/scoring');
const emit = require('../socket/emit');

const router = express.Router();

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

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

// ── Bulk import: pull random tracks from a playlist into a music quiz ──────────

// POST /api/activities/:id/music/import — MusicImportRequest { playlistUrl, count }
// → MusicImportResultDto { imported }. Appends one FreeText Question per picked
// track after the current max order.
router.post('/:id/music/import', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;
  const r = req.body || {};

  if (activity.type !== ActivityType.MusicQuiz) {
    throw new RuleViolation('Only a music quiz can import tracks.');
  }

  // Validate the playlist link up front (before touching Spotify).
  const playlistId = musicLookup.tryGetPlaylistId(r.playlistUrl);
  if (!playlistId) {
    throw new RuleViolation("That doesn't look like a Spotify playlist link.");
  }

  // The quiz's selected connection, or any saved one (the import needs an
  // authenticated account — the playlist API is auth-only).
  let connId = activity.spotifyConnectionId;
  if (!connId) {
    const { SpotifyConnection } = require('../models');
    const any = await SpotifyConnection.findOne().select('_id').lean();
    connId = any ? any._id : null;
  }
  if (!connId) {
    throw new RuleViolation('Connect a Spotify account first (in host settings).');
  }

  // A fresh access token for that connection (null → connection gone).
  let accessToken;
  const tokenDto = await spotify.getPlaybackToken(connId);
  if (!tokenDto) {
    throw new RuleViolation('That Spotify connection no longer exists.');
  }
  accessToken = tokenDto.accessToken;

  const count = clamp(r.count != null ? r.count : 10, 1, 50);
  // Read a generous pool (count*6, 60..300) so the random pick has variety.
  const pool = await musicLookup.importPlaylist(
    r.playlistUrl,
    clamp(count * 6, 60, 300),
    accessToken,
  );
  if (pool.length === 0) {
    throw new RuleViolation('No playable tracks found in that playlist.');
  }

  // Random pick of `count`, appended after the current highest order.
  const picked = pool
    .map((t) => ({ t, k: Math.random() }))
    .sort((a, b) => a.k - b.k)
    .slice(0, count)
    .map((p) => p.t);

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
  await Question.insertMany(docs);

  res.json({ imported: picked.length });
}));

// ── Live pacing: host starts a track for fastest-to-answer play ───────────────

// POST /api/activities/:id/music/start/:questionId — stamp playStartedUtc (drives
// the speed bonus), broadcast MusicTrackStarted to the activity room so every
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
