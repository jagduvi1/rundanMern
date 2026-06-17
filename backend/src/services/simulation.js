// SimulationService — dry-run filler (port of
// Rundan.Server/Services/SimulationService.cs).
//
// Fills an activity with plausible random results so the host can check the whole
// setup (scoreboards, bracket, event standings) before the real day, then clear
// it again. Writes DIRECTLY to the store (not through player endpoints), then
// finishes the activity so the event placement total updates.

const {
  Activity, Participant, Question, Answer, ScoreEntry, BracketMatch, Slap, ImpostureVote,
} = require('../models');
const bracket = require('./bracket');
const { idStr } = require('./serializers');
const {
  ActivityType, ActivityStatus, ScoringMode, Measurement,
} = require('../constants/enums');
const { RuleViolation } = require('../middleware/error');

// ── Sibling: TeamService (resolved lazily) ────────────────────────────────────
// Event activities generate partner-mixer teams before simulating. TeamService is
// built separately; resolve lazily and tolerate its absence (standalone
// activities don't need it anyway).
async function ensureTeams(activity) {
  let mod;
  try {
    // eslint-disable-next-line global-require
    mod = require('./teams');
  } catch (e) {
    return; // team service not present yet — caller's participants stand as-is
  }
  const fn = mod.ensureTeams || mod.ensureTeamsAsync || mod.EnsureTeamsAsync;
  // teams.ensureTeams(event, activity): event is optional (loaded from
  // activity.eventId when null), activity is required and read as the 2nd arg.
  if (typeof fn === 'function') await fn(null, activity);
}

// ── RNG helpers (the draw/sim need not be reproducible) ───────────────────────
// randInt(lo, hiInclusive): integer in [lo, hiInclusive].
const randInt = (lo, hiInclusive) => lo + Math.floor(Math.random() * (hiInclusive - lo + 1));

// ── Clear derived state ───────────────────────────────────────────────────────
// Wipes all of an activity's derived state so a re-open/redraw starts fresh.
async function clearResults(activity) {
  const activityId = activity._id;
  const participantIds = await Participant.find({ activityId }).distinct('_id');
  if (participantIds.length) await Answer.deleteMany({ participantId: { $in: participantIds } });

  await Promise.all([
    ScoreEntry.deleteMany({ activityId }),
    BracketMatch.deleteMany({ activityId }),
    // Slaps reference the activity by a loose ref (no FK) — clear them too, else
    // the penalties linger in the standings after a reset.
    Slap.deleteMany({ activityId }),
    // Imposture votes are per-round; drop them so a replay starts clean.
    ImpostureVote.deleteMany({ activityId }),
  ]);

  // Drawn MapPin cities are embedded on the activity — clear them so re-opening
  // draws a fresh set instead of replaying them.
  if ((activity.mapCities || []).length > 0) {
    activity.mapCities = [];
  }

  // Clear the live Imposture round + recap history so a replay starts from round 1.
  if (activity.impostureRound) {
    activity.impostureRound = null;
  }
  if ((activity.impostureHistory || []).length > 0) {
    activity.impostureHistory = [];
  }

  // Clear any music-quiz "track started" timers so a replay begins fresh.
  await Question.updateMany(
    { activityId, playStartedUtc: { $ne: null } },
    { $set: { playStartedUtc: null } }
  );
}

// ── Per-type simulators ───────────────────────────────────────────────────────

// Quiz / Tipspromenad: each participant answers each question, ~70% correct.
async function simulateAnswers(activity, participantIds) {
  const questions = await Question.find({ activityId: activity._id });
  const now = new Date();
  const docs = [];

  for (const pid of participantIds) {
    for (const q of questions) {
      const makeCorrect = Math.random() < 0.7;
      let chosen = null;
      let isCorrect;
      const opts = q.options || [];
      if (opts.length > 0) {
        chosen = (makeCorrect
          ? opts.find((o) => o.isCorrect)
          : opts.find((o) => !o.isCorrect))
          || opts[randInt(0, opts.length - 1)];
        isCorrect = chosen.isCorrect;
      } else {
        isCorrect = makeCorrect;
      }

      docs.push({
        questionId: q._id,
        participantId: pid,
        selectedOptionId: chosen ? chosen._id : null,
        freeText: opts.length === 0 ? (isCorrect ? q.acceptedFreeTextAnswer : '—') : null,
        isCorrect,
        awardedPoints: isCorrect ? q.points : 0,
        submittedUtc: now,
      });
    }
  }

  if (docs.length) await Answer.insertMany(docs);
}

// Boule: draw the bracket, then resolve every playable match with a random
// winner until complete (sweeps group matches first, then the playoff rounds).
async function simulateBracket(activity) {
  await bracket.drawBracket(activity);

  // Guard covers a full group stage plus two playoff brackets.
  for (let guard = 0; guard < 1000; guard += 1) {
    // Reload the activity each pass so bracket.recordResult sees current courts/
    // status (it reads embedded courts during court assignment).
    // eslint-disable-next-line no-await-in-loop
    const playable = await BracketMatch.find({
      activityId: activity._id,
      winnerParticipantId: null,
      isBye: false,
      participantAId: { $ne: null },
      participantBId: { $ne: null },
    }).sort({ side: 1, round: 1, slot: 1 }).limit(1);

    if (playable.length === 0) break;
    const match = playable[0];

    const winner = Math.random() < 0.5 ? match.participantAId : match.participantBId;
    // sets:null → simulated matches have setScores=null; group standings count
    // each as a 1-0 (SplitGames). explicitWinnerId drives the result.
    // eslint-disable-next-line no-await-in-loop
    await bracket.recordResult(activity, { matchId: match._id, explicitWinnerId: winner });
  }
}

// Everything else (ScoreGame, WordGame, MapPin, MusicQuiz, Memory): random score
// lines, one per participant.
async function simulateScores(activity, participantIds) {
  const now = new Date();
  const docs = participantIds.map((pid) => {
    let value;
    if (activity.scoringMode === ScoringMode.ClosestToTarget) {
      const target = activity.targetValue ?? 100;
      value = Math.max(0, target + randInt(-30, 30));
    } else if (activity.measurement === Measurement.TimeSeconds) {
      value = randInt(30, 180);
    } else if (activity.measurement === Measurement.Millimetres) {
      value = randInt(500, 2000);
    } else if (activity.type === ActivityType.WordGame) {
      value = randInt(3, 10);
    } else {
      value = randInt(3, 15);
    }

    return {
      activityId: activity._id,
      participantId: pid,
      round: 1,
      points: value,
      note: 'dry run',
      recordedUtc: now,
    };
  });

  if (docs.length) await ScoreEntry.insertMany(docs);
}

/**
 * Fills an activity with fake results for testing, then finishes it.
 *  - Quiz/Tipspromenad → simulated answers (~70% correct).
 *  - Boule → draws and plays out the whole bracket with random winners.
 *  - everything else (ScoreGame/WordGame/MapPin/MusicQuiz/Memory) → random scores.
 * For event activities, ensures partner-mixer teams exist first.
 *
 * @param {object} activity A loaded Activity Mongoose doc.
 * @returns {Promise<{activityId:string, type:number, kind:string,
 *   participants:number, finished:boolean}>} A summary of what was simulated.
 */
async function simulate(activity) {
  if (!activity) throw new RuleViolation('Activity not found.', 404);

  if (activity.eventId != null) await ensureTeams(activity);

  await clearResults(activity);

  const participantIds = await Participant.find({ activityId: activity._id }).distinct('_id');

  let kind;
  switch (activity.type) {
    case ActivityType.Quiz:
    case ActivityType.Tipspromenad:
      kind = 'answers';
      await simulateAnswers(activity, participantIds);
      break;
    case ActivityType.Boule:
      kind = 'bracket';
      await simulateBracket(activity);
      break;
    default:
      kind = 'scores';
      await simulateScores(activity, participantIds);
      break;
  }

  activity.status = ActivityStatus.Finished;
  if (activity.startedUtc == null) activity.startedUtc = new Date();
  activity.finishedUtc = new Date();
  await activity.save();

  return {
    activityId: idStr(activity._id),
    type: activity.type,
    kind,
    participants: participantIds.length,
    finished: true,
  };
}

module.exports = {
  simulate,
  // Exposed for tests / reuse (e.g. a reset endpoint clearing derived state).
  clearResults,
};
