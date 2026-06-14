// ParticipantEndpoints — the MERN port of Rundan.Server/Endpoints/ParticipantEndpoints.cs.
// Join an activity directly by its join code (reconnect-aware), list participants,
// and host-kick a participant. All routes mount under the shared base
// `/api/activities` (see app.js); only this router's sub-paths are defined here.
//
// Auth model note: rundan flagged a joining device as `isAdmin` when it also held
// the shared admin code. This port has no shared code, so a join is admin when the
// device can already manage the activity (host account / event-admin member token).
const express = require('express');
const crypto = require('crypto');

const { Activity, Participant, Question } = require('../models');
const { ActivityStatus } = require('../constants/enums');
const { activityDto, participantDto } = require('../services/serializers');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { optionalAuth } = require('../middleware/auth');
const { canManageActivity, activityManager } = require('../middleware/eventAuth');
const { deleteParticipantCascade } = require('../services/cascade');
const { pushScoreboard } = require('../services/scoreboard');
const emit = require('../socket/emit');

const router = express.Router();

// Build the JoinResultDto (token + activity + participant). Mirrors
// BuildJoinResultAsync: activity DTO carries counts only (no canManage/roster).
async function buildJoinResult(activity, participant) {
  const [participantCount, questionCount] = await Promise.all([
    Participant.countDocuments({ activityId: activity._id }),
    Question.countDocuments({ activityId: activity._id }),
  ]);
  const plain = activity.toObject ? activity.toObject() : activity;
  plain.courts = (activity.courts || []).slice().sort((a, b) => a.order - b.order);
  return {
    token: participant.token,
    activity: activityDto(plain, { participantCount, questionCount }),
    participant: participantDto(participant),
  };
}

// POST /api/activities/by-code/:code/join — JoinActivityRequest{displayName,existingToken?}.
router.post('/by-code/:code/join', optionalAuth, asyncHandler(async (req, res) => {
  const normalized = String(req.params.code || '').trim().toUpperCase();
  const activity = await Activity.findOne({ joinCode: normalized });
  if (!activity) throw new RuleViolation('No activity with that code.', 404);

  // Status gate: only Open/Live can be joined.
  if (activity.status === ActivityStatus.Draft) {
    throw new RuleViolation("This activity hasn't opened yet.", 409);
  }
  if (activity.status === ActivityStatus.Finished) {
    throw new RuleViolation('This activity has already finished.', 409);
  }

  const r = req.body || {};
  let name = (r.displayName || '').trim();
  if (name.length === 0) throw new RuleViolation('Enter a name to join with.');
  if (name.length > 60) name = name.slice(0, 60);

  // Reconnect with a previously issued token (same device returning).
  if (r.existingToken) {
    const mine = await Participant.findOne({ token: r.existingToken, activityId: activity._id });
    if (mine) {
      if (mine.displayName !== name) {
        const clash = await Participant.exists({
          activityId: activity._id, _id: { $ne: mine._id }, displayName: name,
        });
        if (!clash) {
          mine.displayName = name;
          await mine.save();
        }
      }
      return res.json(await buildJoinResult(activity, mine));
    }
  }

  const taken = await Participant.exists({ activityId: activity._id, displayName: name });
  if (taken) {
    throw new RuleViolation('That name is already taken here — pick another.', 409);
  }

  // Admin when the joining device can already manage this activity.
  const isAdmin = await canManageActivity(req, activity);

  let participant;
  try {
    participant = await Participant.create({
      activityId: activity._id,
      displayName: name,
      token: crypto.randomUUID(),
      isAdmin,
      joinedUtc: new Date(),
    });
  } catch (e) {
    if (e && e.code === 11000) {
      throw new RuleViolation('That name was just taken — pick another.', 409);
    }
    throw e;
  }

  emit.participantJoined(activity._id, participantDto(participant));
  await pushScoreboard(activity._id);

  res.json(await buildJoinResult(activity, participant));
}));

// GET /api/activities/:id/participants — ordered by join order (id ≈ creation).
router.get('/:id/participants', asyncHandler(async (req, res) => {
  const list = await Participant.find({ activityId: req.params.id }).sort({ _id: 1 }).lean();
  res.json(list.map(participantDto));
}));

// DELETE /api/activities/:id/participants/:pid — kick (cascade) + push scoreboard.
router.delete('/:id/participants/:pid', activityManager, asyncHandler(async (req, res) => {
  const participant = await Participant.findOne({ _id: req.params.pid, activityId: req.params.id });
  if (!participant) return res.status(404).json({ error: 'Participant not found.' });

  await deleteParticipantCascade(participant._id);
  await pushScoreboard(req.params.id);
  res.status(204).end();
}));

module.exports = router;
