// BracketEndpoints — the MERN port of Rundan.Server/Endpoints/BracketEndpoints.cs:
// the knockout-tournament (Boule) surface — view the tree, read/set manual seeds,
// draw, record a result, reset. All routes mount under the shared base
// `/api/activities` (see app.js); only this router's sub-paths are defined here.
//
// The tournament engine (seeding, round-robin, advancement, scoring) lives in
// services/bracket — this router is the thin HTTP layer that authorizes, calls the
// service, pushes the scoreboard, and auto-finishes a crowned tournament.
const express = require('express');

const { Participant } = require('../models');
const { idStr } = require('../services/serializers');
const { asyncHandler } = require('../middleware/error');
const { activityManager } = require('../middleware/eventAuth');
const { pushScoreboard } = require('../services/scoreboard');
const { notifyActivityFinished } = require('../services/push');
const bracket = require('../services/bracket');
const emit = require('../socket/emit');

const router = express.Router();

// ── Read (player-visible; access-gated by middleware) ─────────────────────────

// GET /api/activities/:id/bracket — BracketDto (404 if the activity is missing).
router.get('/:id/bracket', asyncHandler(async (req, res) => {
  const dto = await bracket.getBracketDto(req.params.id);
  if (!dto) return res.status(404).json({ error: 'Activity not found.' });
  res.json(dto);
}));

// GET /api/activities/:id/seeds — teams in seed order (seeded first, unseeded last).
// TeamSeedDto[] = { teamId, name, seed }. (`seed` is the stored seed, 0 if none.)
router.get('/:id/seeds', asyncHandler(async (req, res) => {
  const teams = await Participant.find({ activityId: req.params.id, isTeam: true })
    .select('displayName seed').lean();
  teams.sort((a, b) => {
    const sa = a.seed == null ? Number.POSITIVE_INFINITY : a.seed;
    const sb = b.seed == null ? Number.POSITIVE_INFINITY : b.seed;
    return sa - sb || (idStr(a) < idStr(b) ? -1 : idStr(a) > idStr(b) ? 1 : 0);
  });
  res.json(teams.map((t) => ({ teamId: idStr(t), name: t.displayName, seed: t.seed != null ? t.seed : 0 })));
}));

// ── Write (host / event admin) ────────────────────────────────────────────────

// PUT /api/activities/:id/seeds — SetSeedsRequest { teamIdsInOrder } (first = seed 1).
router.put('/:id/seeds', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  await bracket.setSeeds(activity, (req.body || {}).teamIdsInOrder || []);
  res.json({ ok: true });
}));

// POST /api/activities/:id/bracket/draw — draw the tournament, return the BracketDto.
router.post('/:id/bracket/draw', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  await bracket.drawBracket(activity);
  await pushScoreboard(activity._id);
  res.json(await bracket.getBracketDto(activity._id));
}));

// POST /api/activities/:id/bracket/result — RecordBracketResultRequest { matchId, sets[] }.
// sets[] = { a, b } (one entry for free scoring, N for best-of-N).
router.post('/:id/bracket/result', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const r = req.body || {};
  const sets = Array.isArray(r.sets) ? r.sets.map((s) => ({ a: s.a, b: s.b })) : [];

  await bracket.recordResult(activity, { matchId: r.matchId, sets });
  await pushScoreboard(activity._id);

  // Auto-finalize once the bracket has a champion (so the slap ceremony self-fires).
  if (await bracket.tryAutoFinish(activity)) {
    emit.activityStatusChanged(activity._id, { activityId: idStr(activity), status: activity.status });
    notifyActivityFinished(activity._id).catch(() => {});
  }

  res.json(await bracket.getBracketDto(activity._id));
}));

// POST /api/activities/:id/bracket/reset — clear the bracket + its score lines.
router.post('/:id/bracket/reset', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  await bracket.resetBracket(activity);
  await pushScoreboard(activity._id);
  res.json(await bracket.getBracketDto(activity._id));
}));

module.exports = router;
