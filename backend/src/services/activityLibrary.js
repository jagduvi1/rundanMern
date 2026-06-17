// ActivityLibraryService — deep-copy a reusable library activity, either INTO an
// event as a fresh Draft (copyToEvent) or into a user's own library as a standalone
// template (copyToLibrary). Port of Rundan.Server/Services/ActivityLibraryService.
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
  'impostorCount', 'revealCategoryToImpostor', 'impostureScoring',
  'courtLabel', 'scoreEntryMode', 'roundCount', 'playersPerRound',
  'latitude', 'longitude', 'radiusMeters', 'mapCityCount',
];

// Create a new activity from `source`'s config plus the `base` overrides (identity /
// live-state fields), then deep-copy its questions (+ options). Standalone Mongo has
// no transactions, so on a (rare) insertMany failure roll back the just-created
// activity by hand rather than leaving a question-less orphan Draft.
async function cloneActivity(source, base) {
  const copyFields = {};
  for (const f of CONFIG_FIELDS) copyFields[f] = source[f];

  const copy = await Activity.create({
    ...copyFields,
    spotifyConnectionId: null, // per-user — never carry another host's connection
    joinCode: await uniqueJoinCode([Activity, Event]), // unique across both collections
    // Authored config carries over; drawn/live lists reset.
    courts: (source.courts || []).slice().sort((a, b) => a.order - b.order)
      .map((c) => ({ order: c.order, name: c.name })),
    memoryCards: (source.memoryCards || []).slice().sort((a, b) => a.order - b.order)
      .map((c) => ({ order: c.order, text: c.text })),
    // Source playlists are authored config — carry them so a copied music quiz can
    // still import more tracks (importing uses the NEW owner's Spotify connection).
    musicPlaylists: (source.musicPlaylists || []).map((p) => ({
      playlistId: p.playlistId,
      url: p.url,
      title: p.title,
      ownerName: p.ownerName,
      imageUrl: p.imageUrl,
      trackCount: p.trackCount,
      description: p.description,
    })),
    // Imposture secret words are authored config — carry them; the live round resets.
    impostureWords: (source.impostureWords || []).map((w) => ({ word: w.word, category: w.category })),
    impostureRound: null,
    mapCities: [],
    ...base, // eventId/order/status/inLibrary/isPublic/owner — caller decides
  });

  const questions = await Question.find({ activityId: source._id }).sort({ order: 1 }).lean();
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

/**
 * Deep-copy a library activity into an event as a fresh Draft. The source must be a
 * publicly shared template OR one the requester owns (their own library item).
 * @param {string} sourceId  the library activity's id
 * @param {string|ObjectId} eventId  the target event
 * @param {string|ObjectId|null} requesterId  the acting account (to allow own items)
 * @returns {Promise<{activity: object, questionCount: number}>} the created doc
 */
async function copyToEvent(sourceId, eventId, requesterId = null) {
  const source = await Activity.findById(sourceId).lean();
  const reqId = requesterId ? String(requesterId) : null;
  const allowed = source && (source.isPublic
    || (reqId && source.owner && String(source.owner) === reqId));
  if (!allowed) throw new RuleViolation('Library activity not found.', 404);

  const maxA = await Activity.findOne({ eventId }).sort({ order: -1 }).select('order').lean();
  const order = (maxA ? maxA.order : 0) + 1;

  return cloneActivity(source, {
    eventId,
    order,
    status: ActivityStatus.Draft,
    inLibrary: false,
    isPublic: false, // a copy living inside an event isn't itself a library item
    owner: null, // governed by the event's owner/admins, not a standalone owner
    copiedFromId: source._id, // remember the template, for its "used-in" list
  });
}

/**
 * Deep-copy any activity into a NEW standalone library template owned by `ownerId`.
 * Private (isPublic:false) until the owner publishes it from the library page.
 * @param {string|ObjectId} sourceId  the activity to snapshot
 * @param {string|ObjectId} ownerId  the account that will own the template
 * @returns {Promise<{activity: object, questionCount: number}>} the created doc
 */
async function copyToLibrary(sourceId, ownerId) {
  const source = await Activity.findById(sourceId).lean();
  if (!source) throw new RuleViolation('Activity not found.', 404);

  return cloneActivity(source, {
    eventId: null,
    order: 0,
    status: ActivityStatus.Draft,
    inLibrary: true,
    isPublic: false,
    owner: ownerId,
  });
}

module.exports = { copyToEvent, copyToLibrary };
