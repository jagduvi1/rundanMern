const { Participant } = require('../models');
const { RuleViolation } = require('./error');

// Player identity — the MERN port of rundan's ParticipantContext. Players are
// anonymous: on join they receive an opaque token, persisted client-side and
// re-sent as the `x-rundan-participant` header. These helpers are called at the
// top of gameplay writes (not mounted as global middleware).
const HEADER = 'x-rundan-participant';

async function resolveParticipant(req) {
  const token = (req.headers[HEADER] || '').toString().trim();
  if (!token) throw new RuleViolation('Join the activity first.', 401);
  const participant = await Participant.findOne({ token });
  if (!participant) {
    throw new RuleViolation('Your session is no longer valid — re-join the activity.', 401);
  }
  return participant;
}

// Standard guard: resolve the participant AND assert it belongs to `activityId`.
async function resolveParticipantForActivity(req, activityId) {
  const participant = await resolveParticipant(req);
  if (String(participant.activityId) !== String(activityId)) {
    throw new RuleViolation('Your session belongs to a different activity.', 403);
  }
  return participant;
}

// Non-throwing lookup (for routes that behave differently for known vs unknown
// players, e.g. computing canManage). Returns null when absent/invalid.
async function tryResolveParticipant(req) {
  try {
    return await resolveParticipant(req);
  } catch {
    return null;
  }
}

module.exports = { resolveParticipant, resolveParticipantForActivity, tryResolveParticipant, HEADER };
