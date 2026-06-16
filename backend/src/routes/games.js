// Game-play endpoints for MapPin, Memory and WordGame — the MERN port of the
// player-facing halves of Rundan.Server/Endpoints/MapPinEndpoints.cs,
// MemoryEndpoints.cs and WordGameEndpoints.cs. All routes mount under the shared
// base `/api/activities` (see app.js); only this router's sub-paths are defined
// here. Every player action starts with resolveParticipantForActivity.
//
// Data model note: in this port a MapPin activity's drawn cities and a Memory
// activity's card labels are EMBEDDED on the Activity (activity.mapCities /
// activity.memoryCards), not separate collections. A team's MapPin pin is a
// ScoreEntry keyed by `round == city.order`; a WordGame/Memory result is a
// ScoreEntry too. Real city coordinates stay server-side until a team has pinned.
const express = require('express');

const { Activity, Participant, ScoreEntry } = require('../models');
const {
  ActivityType, ActivityStatus, Measurement,
} = require('../constants/enums');
const { idStr, mapCityDto } = require('../services/serializers');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { resolveParticipantForActivity } = require('../middleware/participant');
const { activityManager } = require('../middleware/eventAuth');
const { pushScoreboard } = require('../services/scoreboard');
const { notifyActivityFinished } = require('../services/push');
const { tryAutoFinishScoreGame } = require('../services/autoFinish');
const { haversineKm } = require('../services/geo');
const wordgame = require('../services/wordgame');
const emit = require('../socket/emit');

const router = express.Router();

// In-place Fisher-Yates shuffle (live RNG — the Memory board layout is drawn fresh
// per request, exactly like the .NET client deal).
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── MapPin ────────────────────────────────────────────────────────────────────

// GET /api/activities/:id/cities — the drawn cities (names only — NEVER coords)
// plus the calling team's distance for any it has pinned. MapCityDto[].
router.get('/:id/cities', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const participant = await resolveParticipantForActivity(req, id);

  const activity = await Activity.findById(id).select('mapCities').lean();
  if (!activity) throw new RuleViolation('Activity not found.', 404);

  // The team's distances live as ScoreEntries keyed by round == city.order.
  const mine = await ScoreEntry.find({ activityId: id, participantId: participant._id })
    .select('round points').lean();
  const byRound = new Map(mine.map((s) => [s.round, s.points]));

  const cities = (activity.mapCities || []).slice().sort((a, b) => a.order - b.order);
  res.json(cities.map((c) => mapCityDto(c, {
    pinned: byRound.has(c.order),
    distanceKm: byRound.has(c.order) ? byRound.get(c.order) : null,
  })));
}));

// MapPin auto-finish (port of TryAutoFinishMapPinAsync): finish once every roster
// team has pinned every city. Returns true on transition.
async function tryAutoFinishMapPin(activity) {
  if (activity.type !== ActivityType.MapPin || activity.status !== ActivityStatus.Live) {
    return false;
  }
  const teamCount = await Participant.countDocuments({ activityId: activity._id, isTeam: true });
  const cityCount = (activity.mapCities || []).length;
  const expected = teamCount * cityCount;
  if (expected <= 0) return false;

  const recorded = await ScoreEntry.countDocuments({ activityId: activity._id });
  if (recorded < expected) return false;

  activity.status = ActivityStatus.Finished;
  activity.finishedUtc = new Date();
  await activity.save();
  return true;
}

// POST /api/activities/:id/pin — MapPinRequest { cityId, lat, lng }.
// Distance is computed server-side and stored as the team's score for that city
// (one entry per city, replaced on a re-pin). Returns MapPinResultDto with the
// now-revealed real coordinates.
router.post('/:id/pin', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const participant = await resolveParticipantForActivity(req, id);
  const r = req.body || {};

  const activity = await Activity.findById(id);
  if (!activity) throw new RuleViolation('Activity not found.', 404);
  if (activity.status !== ActivityStatus.Live) {
    throw new RuleViolation("This game isn't live.", 409);
  }

  const city = (activity.mapCities || []).find((c) => idStr(c) === String(r.cityId));
  if (!city) throw new RuleViolation('City not found.', 404);

  const distanceKm = Math.round(haversineKm(r.lat, r.lng, city.latitude, city.longitude) * 10) / 10;

  // One pin per team per city (round == city.order). Load every row for this slot
  // so a prior concurrent double-submit can't leave two rows silently summing —
  // keep one, drop the rest.
  const existing = await ScoreEntry.find({
    activityId: id, participantId: participant._id, round: city.order,
  });
  let entry = existing[0];
  if (!entry) {
    entry = new ScoreEntry({
      activityId: id,
      participantId: participant._id,
      round: city.order,
      recordedUtc: new Date(),
    });
  } else if (existing.length > 1) {
    await ScoreEntry.deleteMany({ _id: { $in: existing.slice(1).map((e) => e._id) } });
  }
  entry.points = distanceKm;
  await entry.save();

  await pushScoreboard(id);

  // Auto-finalize once every participant has dropped a pin for every city.
  if (await tryAutoFinishMapPin(activity)) {
    emit.activityStatusChanged(id, { activityId: idStr(activity), status: activity.status });
    notifyActivityFinished(activity._id).catch(() => {});
  }

  res.json({
    cityId: idStr(city),
    distanceKm,
    realLat: city.latitude,
    realLng: city.longitude,
  });
}));

// ── Memory ────────────────────────────────────────────────────────────────────

// GET /api/activities/:id/memory — the shuffled board: each label becomes two
// cards (a matching pair sharing `pairId`), positions dealt at random per request.
// The card `text` IS sent (it's the face the player flips to) — there is no secret
// to protect (matching is client-side; the recorded result is the score).
router.get('/:id/memory', asyncHandler(async (req, res) => {
  const { id } = req.params;
  await resolveParticipantForActivity(req, id);

  const activity = await Activity.findById(id).select('memoryCards').lean();
  if (!activity) throw new RuleViolation('Activity not found.', 404);

  const labels = (activity.memoryCards || []).slice().sort((a, b) => a.order - b.order);
  // Two cards per label (a pair); shuffle the deal so positions vary each game.
  const cards = [];
  for (const label of labels) {
    const pairId = idStr(label);
    cards.push({ pairId, text: label.text });
    cards.push({ pairId, text: label.text });
  }
  shuffle(cards);
  const board = cards.map((c, i) => ({ position: i, pairId: c.pairId, text: c.text }));

  res.json({ pairCount: labels.length, cards: board });
}));

// POST /api/activities/:id/memory/result — record the team's clear of the board.
// { time?(seconds), flips? } → one ScoreEntry (round 1; replaces any earlier).
// Memory is forced LowerWins, so the lower time/flips count wins. Persists by the
// activity's measurement (TimeSeconds → seconds; else the flip count).
router.post('/:id/memory/result', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const participant = await resolveParticipantForActivity(req, id);
  const r = req.body || {};

  const activity = await Activity.findById(id);
  if (!activity) throw new RuleViolation('Activity not found.', 404);
  if (activity.type !== ActivityType.Memory) {
    throw new RuleViolation('This activity is not a memory game.');
  }
  if (activity.status !== ActivityStatus.Live) {
    throw new RuleViolation('This game isn’t running right now.', 409);
  }

  const measuresTime = activity.measurement === Measurement.TimeSeconds;
  const raw = measuresTime ? r.time : r.flips;
  const points = Number(raw);
  if (!Number.isFinite(points) || points < 0 || points > 100000) {
    throw new RuleViolation('That value is out of range.');
  }

  // One result per team — replace any earlier clear.
  await ScoreEntry.deleteMany({ activityId: id, participantId: participant._id });
  await ScoreEntry.create({
    activityId: id,
    participantId: participant._id,
    round: 1,
    points,
    recordedUtc: new Date(),
  });

  await pushScoreboard(id);

  // Auto-finalize once every team has cleared the board — so an event Memory game
  // self-finishes and the activity-finished push + slap ceremony fire (matching
  // the original, where the Memory result went through /scores).
  if (await tryAutoFinishScoreGame(activity)) {
    emit.activityStatusChanged(id, { activityId: idStr(activity), status: activity.status });
    notifyActivityFinished(activity._id).catch(() => {});
  }

  res.json({ ok: true });
}));

// GET /api/activities/:id/memory-cards — return the card labels for the editor.
router.get('/:id/memory-cards', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const cards = (activity.memoryCards || [])
    .slice().sort((a, b) => a.order - b.order)
    .map((c) => ({ id: idStr(c), order: c.order, text: c.text }));
  res.json({ cards, words: cards.map((c) => c.text), count: cards.length });
}));

// PUT /api/activities/:id/memory-cards — host authors the card labels (each
// becomes a matching pair). Editable while Draft. { words: string[] } → the
// embedded activity.memoryCards array. Returns the saved labels.
router.put('/:id/memory-cards', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  if (activity.type !== ActivityType.Memory) {
    throw new RuleViolation('This activity is not a memory game.');
  }
  if (activity.status !== ActivityStatus.Draft) {
    throw new RuleViolation('Edit the memory cards while the game is still a draft.', 409);
  }
  const words = Array.isArray(req.body?.words) ? req.body.words : [];
  const cards = words
    .map((w) => (w == null ? '' : String(w).trim()))
    .filter((w) => w.length > 0)
    .slice(0, 60)
    .map((text, i) => ({ order: i, text: text.slice(0, 120) }));
  activity.memoryCards = cards;
  await activity.save();
  res.json({
    count: cards.length,
    words: cards.map((c) => c.text),
    cards: activity.memoryCards.map((c) => ({ id: idStr(c), order: c.order, text: c.text })),
  });
}));

// ── WordGame ───────────────────────────────────────────────────────────────────

// GET /api/activities/:id/wordgame — WordGameDto (the team's 20 tiles, rules, and
// their latest submitted word/score). Tiles are deterministic per participant.
router.get('/:id/wordgame', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const participant = await resolveParticipantForActivity(req, id);

  const activity = await Activity.findById(id);
  if (!activity) throw new RuleViolation('Activity not found.', 404);

  res.json(await wordgame.getWordGame(activity, participant));
}));

// POST /api/activities/:id/wordgame/submit — SubmitWordRequest { openedIndices, word }.
// The service validates the word against the opened tiles, records it as the team's
// single score line (length = score), and returns the updated WordGameDto.
router.post('/:id/wordgame/submit', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const participant = await resolveParticipantForActivity(req, id);
  const r = req.body || {};

  const activity = await Activity.findById(id);
  if (!activity) throw new RuleViolation('Activity not found.', 404);
  if (activity.status !== ActivityStatus.Live) {
    throw new RuleViolation('This game isn’t running right now.', 409);
  }

  const dto = await wordgame.submitWord(activity, participant, {
    openedIndices: r.openedIndices,
    word: r.word,
  });
  await pushScoreboard(id);
  res.json(dto);
}));

module.exports = router;
