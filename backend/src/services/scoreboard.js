// Live scoreboard builder — the MERN port of rundan's `ScoreboardService.cs`
// (and the `PushScoreboardAsync` half of `ScoreboardNotifier`). Builds the
// ranked board for one activity and (optionally) pushes it over socket.io.
//
// Data volumes are tiny (a handful of friends), so everything is aggregated in
// memory exactly as the C# does. Ranking goes through `scoring.rankRows` so the
// board and the event standings rank identically.
const {
  Activity, Participant, Question, Answer, ScoreEntry, BracketMatch,
} = require('../models');
const { ActivityType } = require('../constants/enums');
const scoring = require('./scoring');
const emit = require('../socket/emit');
const { idStr } = require('./serializers');

// Single injectable clock so the `updatedUtc` stamp is fakeable in tests.
const now = () => new Date();

// Question games sum Answer.awardedPoints; everything else sums ScoreEntry.points.
function isQuestionGameType(type) {
  return type === ActivityType.Quiz
    || type === ActivityType.Tipspromenad
    || type === ActivityType.MusicQuiz;
}

/**
 * Build the live scoreboard for one activity.
 *
 * @param {*} activityId  Mongo _id (string or ObjectId).
 * @returns {Promise<object|null>} ScoreboardDto, or `null` if the activity does
 *   not exist (caller emits nothing / 404):
 *   {
 *     activityId, type, status, scoringMode, totalQuestions,
 *     entries: [{ participantId, displayName, rank, totalPoints, entries }],
 *     updatedUtc
 *   }
 */
async function buildScoreboard(activityId) {
  const activity = await Activity.findById(activityId).lean();
  if (!activity) return null;

  // Every participant appears, even with no data (seeded to 0).
  const participants = await Participant.find({ activityId: activity._id })
    .select('_id displayName')
    .lean();

  // totals[participantIdStr] = { points, entries }
  const totals = new Map();
  for (const p of participants) {
    totals.set(idStr(p), { points: 0, entries: 0 });
  }

  const isQuestionGame = isQuestionGameType(activity.type);
  let totalQuestions = 0;

  // Boule WITH a drawn bracket is special: the bracket service owns this
  // activity's results, so the scoreboard rows come from it rather than from a
  // raw ScoreEntry sum. (Boule WITHOUT a bracket falls through to the generic
  // score-game branch below, like any other measured/round game.)
  let bracketEntries = null;
  if (activity.type === ActivityType.Boule) {
    const hasBracket = await BracketMatch.exists({ activityId: activity._id });
    if (hasBracket) {
      // Lazy require: services/bracket.js is authored by the game-services agent
      // and only needs to exist at runtime, not at module-load time.
      // eslint-disable-next-line global-require
      const { bracketScoreboardEntries } = require('./bracket');
      bracketEntries = await bracketScoreboardEntries(activity);
    }
  }

  let entries;
  if (bracketEntries) {
    // Trust the bracket's own per-participant rows. We still re-rank here so the
    // wire shape + tie semantics match every other board; if the bracket already
    // set ranks, rankRows recomputes them identically from totalPoints.
    entries = bracketEntries.map((e) => ({
      participantId: idStr(e.participantId ?? e.participant ?? e),
      displayName: e.displayName ?? '',
      totalPoints: e.totalPoints ?? e.points ?? 0,
      entries: e.entries ?? 0,
      rank: 0,
    }));
  } else if (isQuestionGame) {
    totalQuestions = await Question.countDocuments({ activityId: activity._id });

    // Group answers of this activity's participants by participant.
    const rows = await Answer.aggregate([
      { $match: { participantId: { $in: participants.map((p) => p._id) } } },
      {
        $group: {
          _id: '$participantId',
          points: { $sum: '$awardedPoints' },
          count: { $sum: 1 },
        },
      },
    ]);
    for (const row of rows) {
      const key = idStr(row._id);
      // Only participants already in totals are updated — orphan answer rows
      // (deleted participant) are ignored, mirroring the C#.
      if (totals.has(key)) {
        totals.set(key, { points: row.points, entries: row.count });
      }
    }
    entries = buildEntryRows(participants, totals);
  } else {
    // Score game: Boule (no bracket) / ScoreGame / WordGame / MapPin / Memory.
    const rows = await ScoreEntry.aggregate([
      { $match: { activityId: activity._id } },
      {
        $group: {
          _id: '$participantId',
          points: { $sum: '$points' },
          count: { $sum: 1 },
        },
      },
    ]);
    for (const row of rows) {
      const key = idStr(row._id);
      if (totals.has(key)) {
        totals.set(key, { points: row.points, entries: row.count });
      }
    }
    entries = buildEntryRows(participants, totals);
  }

  // Sort + assign competition ranks via the shared ranking helper (honours
  // scoringMode + TargetValue, including LowerWins / ClosestToTarget unscored-last).
  scoring.rankRows(entries, {
    scoringMode: activity.scoringMode,
    targetValue: activity.targetValue,
  });

  return {
    activityId: idStr(activity),
    type: activity.type,
    status: activity.status,
    scoringMode: activity.scoringMode,
    totalQuestions,
    entries,
    updatedUtc: now(),
  };
}

// Project participants + their aggregated totals into scoreboard entry rows.
function buildEntryRows(participants, totals) {
  return participants.map((p) => {
    const t = totals.get(idStr(p)) || { points: 0, entries: 0 };
    return {
      participantId: idStr(p),
      displayName: p.displayName,
      totalPoints: t.points,
      entries: t.entries,
      rank: 0,
    };
  });
}

/**
 * Build the scoreboard then push it to the activity room (ScoreboardUpdated).
 * Mirrors ScoreboardNotifier.PushScoreboardAsync: rebuilds first; if the
 * activity is gone, emits nothing.
 *
 * @param {*} activityId
 * @returns {Promise<object|null>} the built ScoreboardDto (or null if missing).
 */
async function pushScoreboard(activityId) {
  const dto = await buildScoreboard(activityId);
  if (!dto) return null;
  emit.scoreboardUpdated(activityId, dto);
  return dto;
}

module.exports = {
  buildScoreboard,
  pushScoreboard,
};
