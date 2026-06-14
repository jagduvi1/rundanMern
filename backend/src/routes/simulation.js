// SimulationEndpoints — the MERN port of
// Rundan.Server/Endpoints/SimulationEndpoints.cs (the activity-scoped half).
//
// Dry-run helpers: fill an activity with plausible random results so a host can
// preview scoreboards / brackets / standings before the real day, then clear it
// again. Both write directly to the store (bypassing player endpoints) and finish
// with a status + scoreboard push, returning the refreshed ActivityDto.
//
// All routes mount under the shared base `/api/activities` (see app.js); only this
// router's sub-paths are defined here. Writes authorize "host OR event admin" via
// `activityManager`.
//
// Scope note: the event-wide variants (POST /api/events/:id/simulate and
// /reset-results, EventManagerFilter) live with the event router, not here.
const express = require('express');

const {
  Activity, Event, EventMember, Participant, Question,
} = require('../models');
const { ActivityStatus } = require('../constants/enums');
const { activityDto } = require('../services/serializers');
const { asyncHandler } = require('../middleware/error');
const { activityManager } = require('../middleware/eventAuth');
const simulation = require('../services/simulation');
const { pushScoreboard } = require('../services/scoreboard');
const emit = require('../socket/emit');
const { idStr } = require('../services/serializers');

const router = express.Router();

// Port of ActivityEndpoints.LoadDtoAsync — counts + ordered courts, and for an
// event activity the team/player overrides from the roster. Kept local because
// activities.js does not export its copy. Always built with canManage:true (the
// caller passed the activityManager gate).
async function loadActivityDto(activity) {
  const id = activity._id;
  const [participantCount, questionCount] = await Promise.all([
    Participant.countDocuments({ activityId: id }),
    Question.countDocuments({ activityId: id }),
  ]);
  const extra = {
    canManage: true,
    participantCount,
    questionCount,
    isTeamBased: false,
    playerCount: 0,
    teamCount: 0,
  };

  if (activity.eventId) {
    const ev = await Event.findById(activity.eventId).select('teamSize').lean();
    const teamSize = ev ? ev.teamSize : 1;
    extra.isTeamBased = teamSize > 1;
    const memberCount = await EventMember.countDocuments({ eventId: activity.eventId });
    if (memberCount > 0) {
      extra.playerCount = memberCount;
      extra.teamCount = teamSize > 1 ? Math.ceil(memberCount / teamSize) : 0;
    }
  }

  const plain = activity.toObject ? activity.toObject() : activity;
  plain.courts = (activity.courts || []).slice().sort((a, b) => a.order - b.order);
  return activityDto(plain, extra);
}

// ── Simulate: fill with fake results, finish the activity ─────────────────────

// POST /api/activities/:id/simulate → ActivityDto. Simulates (answers / bracket /
// scores by type), pushes status Finished + the scoreboard, returns the DTO.
router.post('/:id/simulate', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;

  await simulation.simulate(activity);
  emit.activityStatusChanged(id, { activityId: idStr(activity), status: ActivityStatus.Finished });
  await pushScoreboard(id);

  res.json(await loadActivityDto(activity));
}));

// ── Reset: clear all generated results, return the activity to Draft ──────────

// POST /api/activities/:id/reset-results → ActivityDto. Clears the derived state
// (answers / scores / bracket / slaps / drawn cities / music timers), returns the
// activity to Draft with its run stamps cleared, then pushes status Draft + the
// scoreboard.
router.post('/:id/reset-results', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;

  await simulation.clearResults(activity);
  activity.status = ActivityStatus.Draft;
  activity.startedUtc = null;
  activity.finishedUtc = null;
  await activity.save();

  emit.activityStatusChanged(id, { activityId: idStr(activity), status: ActivityStatus.Draft });
  await pushScoreboard(id);

  res.json(await loadActivityDto(activity));
}));

module.exports = router;
