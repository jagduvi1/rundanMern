// Shared auto-finish helper for team SCORE games (ScoreGame + Memory).
//
// Extracted from gameplay.js so BOTH the generic score path (/scores) AND the
// dedicated Memory result path (/memory/result) can self-finalize once every
// expected score is in — which is what makes the activity-finished push and the
// slap ceremony fire without the host pressing "finish". Port of
// GameService.TryAutoFinishScoreGameAsync.
const { Activity, Participant, ScoreEntry } = require('../models');
const {
  ActivityType, ActivityStatus, ScoreEntryMode, Measurement,
} = require('../constants/enums');
const { idStr } = require('./serializers');

// Event team games only — that's where "complete" is well-defined. Returns true
// on the Live → Finished transition (and stamps finishedUtc), false otherwise.
async function tryAutoFinishScoreGame(activity) {
  if (![ActivityType.ScoreGame, ActivityType.Memory].includes(activity.type)
    || activity.status !== ActivityStatus.Live || !activity.eventId) {
    return false;
  }

  const teams = await Participant.find({ activityId: activity._id, isTeam: true })
    .select('_id members').lean();
  if (teams.length === 0) return false;
  const teamIds = teams.map((t) => t._id);

  let expected;
  let recorded;
  if (activity.scoreEntryMode === ScoreEntryMode.PerPlayer) {
    // One score per player on every team.
    expected = teams.reduce((sum, t) => sum + (t.members || []).length, 0);
    const rows = await ScoreEntry.find({
      activityId: activity._id, participantId: { $in: teamIds }, userId: { $ne: null },
    }).select('participantId userId').lean();
    const seen = new Set(rows.map((s) => `${idStr(s.participantId)}:${idStr(s.userId)}`));
    recorded = seen.size;
  } else {
    // Whole team per round; time/length is a single reading (no rounds).
    const rounds = [Measurement.TimeSeconds, Measurement.Millimetres].includes(activity.measurement)
      ? 1 : Math.max(1, activity.roundCount);
    expected = teamIds.length * rounds;
    const rows = await ScoreEntry.find({
      activityId: activity._id, participantId: { $in: teamIds }, round: { $gte: 1, $lte: rounds },
    }).select('participantId round').lean();
    const seen = new Set(rows.map((s) => `${idStr(s.participantId)}:${s.round}`));
    recorded = seen.size;
  }

  if (expected <= 0 || recorded < expected) return false;

  // Atomic gate: exactly ONE concurrent caller wins the Live→Finished transition
  // (two teams clearing the board in the same tick would otherwise both fire the
  // finished push + slap). Only the winner returns true.
  const updated = await Activity.findOneAndUpdate(
    { _id: activity._id, status: ActivityStatus.Live },
    { $set: { status: ActivityStatus.Finished, finishedUtc: new Date() } },
    { new: true },
  );
  if (!updated) return false;
  activity.status = updated.status;
  activity.finishedUtc = updated.finishedUtc;
  return true;
}

module.exports = { tryAutoFinishScoreGame };
