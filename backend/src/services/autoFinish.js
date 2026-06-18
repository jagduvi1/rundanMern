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
    // Run-based fairness for uneven teams: every team gets the SAME number of runs
    // (= the biggest team's player count); a short-handed team's players take extra
    // runs to match a full team. Complete once each scoreable team has recorded its
    // targetRuns runs — counted the SAME way as the per-run cap in
    // routes/gameplay.js recordScore() (total ScoreEntries per team, capped at
    // targetRuns), so "host sees done" and "auto-finish fires" stay in lockstep.
    const targetRuns = teams.reduce((m, t) => Math.max(m, (t.members || []).length), 1);
    const playable = teams.filter((t) => (t.members || []).length > 0);
    expected = playable.length * targetRuns;
    const rows = await ScoreEntry.find({
      activityId: activity._id, participantId: { $in: teamIds },
    }).select('participantId').lean();
    const runsByTeam = new Map();
    for (const r of rows) {
      const k = idStr(r.participantId);
      runsByTeam.set(k, (runsByTeam.get(k) || 0) + 1);
    }
    recorded = playable.reduce(
      (sum, t) => sum + Math.min(runsByTeam.get(idStr(t._id)) || 0, targetRuns), 0,
    );
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
