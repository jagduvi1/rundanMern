// ActivityLibraryService — deep-copy a PUBLIC library activity into an event as a
// fresh Draft. Port of Rundan.Server/Services/ActivityLibraryService.CopyToEventAsync.
//
// Copies everything that defines the activity's SETUP (config + questions/options +
// courts + memory-card labels) and resets all live/identity state (status → Draft,
// a brand-new join code, no participants/scores/teams/bracket, no drawn cities).
const { Activity, Event, Question } = require('../models');
const { RuleViolation } = require('../middleware/error');
const { uniqueJoinCode } = require('../utils/joinCode');
const { ActivityStatus } = require('../constants/enums');

// The config fields that define an activity's setup — everything EXCEPT identity
// (id/eventId/order/joinCode/owner), live state (status/stamps/mapCities), the
// re-publish flag (isPublic) and the per-user spotifyConnectionId.
const CONFIG_FIELDS = [
  'type', 'title', 'description', 'imageUrl',
  'scoringMode', 'measurement', 'targetValue',
  'matchFormat', 'bestOfSets', 'gamesToWinSet', 'useGroupStage', 'groupCount',
  'groupMatchFormat', 'groupBestOfSets', 'groupGamesToWinSet',
  'advanceToPlayoffA', 'advanceToPlayoffB', 'playoffAConsolation', 'playoffBConsolation',
  'useManualSeeding', 'tournamentScoring',
  'randomizeQuestions', 'musicChoices', 'speedScoring', 'hitsterMode', 'hitsterCardsToWin',
  'hideQuestionsFromHost',
  'courtLabel', 'scoreEntryMode', 'roundCount', 'playersPerRound',
  'latitude', 'longitude', 'radiusMeters', 'mapCityCount',
];

/**
 * Deep-copy a public library activity into an event as a fresh Draft.
 * @param {string} sourceId  a PUBLIC activity's id
 * @param {string|ObjectId} eventId  the target event
 * @returns {Promise<{activity: object, questionCount: number}>} the created doc
 */
async function copyToEvent(sourceId, eventId) {
  const source = await Activity.findOne({ _id: sourceId, isPublic: true }).lean();
  if (!source) throw new RuleViolation('Library activity not found.', 404);

  const maxA = await Activity.findOne({ eventId }).sort({ order: -1 }).select('order').lean();
  const order = (maxA ? maxA.order : 0) + 1;

  const copyFields = {};
  for (const f of CONFIG_FIELDS) copyFields[f] = source[f];

  const copy = await Activity.create({
    ...copyFields,
    eventId,
    order,
    status: ActivityStatus.Draft,
    isPublic: false,
    copiedFromId: source._id,
    owner: null,
    spotifyConnectionId: null, // per-user — never carry another host's connection
    joinCode: await uniqueJoinCode([Activity, Event]), // unique across both collections
    // Authored config carries over; drawn/live lists reset.
    courts: (source.courts || []).slice().sort((a, b) => a.order - b.order)
      .map((c) => ({ order: c.order, name: c.name })),
    memoryCards: (source.memoryCards || []).slice().sort((a, b) => a.order - b.order)
      .map((c) => ({ order: c.order, text: c.text })),
    mapCities: [],
  });

  // Deep-copy the questions (+ options) into the new activity. Standalone Mongo
  // has no transactions, so on a (rare) insertMany failure, roll back the just-
  // created activity by hand rather than leaving a question-less orphan Draft.
  const questions = await Question.find({ activityId: sourceId }).sort({ order: 1 }).lean();
  if (questions.length) {
    try {
      await Question.insertMany(questions.map((q) => ({
        activityId: copy._id,
        order: q.order,
        text: q.text,
        kind: q.kind,
        points: q.points,
        imageUrl: q.imageUrl,
        latitude: q.latitude,
        longitude: q.longitude,
        radiusMeters: q.radiusMeters,
        acceptedFreeTextAnswer: q.acceptedFreeTextAnswer,
        spotifyUrl: q.spotifyUrl,
        acceptedArtist: q.acceptedArtist,
        releaseYear: q.releaseYear,
        options: (q.options || []).slice().sort((a, b) => a.order - b.order)
          .map((o) => ({ order: o.order, text: o.text, isCorrect: o.isCorrect })),
      })));
    } catch (e) {
      await Activity.deleteOne({ _id: copy._id }).catch(() => {});
      await Question.deleteMany({ activityId: copy._id }).catch(() => {});
      throw e;
    }
  }

  return { activity: copy, questionCount: questions.length };
}

module.exports = { copyToEvent };
