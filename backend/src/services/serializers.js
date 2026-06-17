// DTO serializer layer. rundan deliberately omits secrets from several DTOs
// (option correctness while live, Spotify tokens, real MapPin coords until
// pinned, host-only music answer keys), so routes must NEVER return raw Mongoose
// docs — they project through these builders. Computed/derived fields
// (hasLocation, usesQuestions, isComplete, …) are produced here, not stored.
const {
  ActivityType, Measurement, QuestionKind,
} = require('../constants/enums');

const idStr = (d) => {
  if (d === null || d === undefined) return null;
  if (typeof d === 'object' && d._id !== undefined) return String(d._id);
  return String(d);
};

// ── Roster user ───────────────────────────────────────────────────────────────
const userDto = (u) => (u ? { id: idStr(u), name: u.name } : null);

// ── Account summary (event owner / co-admins) — never leaks secrets ────────────
const accountSummaryDto = (a) =>
  (a ? { id: idStr(a), username: a.username, displayName: a.displayName || a.username, email: a.email } : null);

// ── Activity-type derived booleans (mirror ActivityDto computed helpers) ───────
function activityDerived(a) {
  const t = a.type;
  return {
    usesQuestions: t === ActivityType.Quiz || t === ActivityType.Tipspromenad,
    usesMap: t === ActivityType.Tipspromenad,
    usesRounds: t === ActivityType.Boule || t === ActivityType.ScoreGame,
    usesCourts: t === ActivityType.Boule || t === ActivityType.ScoreGame,
    usesGroups: t === ActivityType.Boule && !!a.useGroupStage,
    measuresTime: a.measurement === Measurement.TimeSeconds,
    measuresLength: a.measurement === Measurement.Millimetres,
    hasLocation: a.latitude != null && a.longitude != null,
  };
}

const courtDto = (c) => ({ id: idStr(c), order: c.order, name: c.name });

// extra = { canManage, isTeamBased, participantCount, playerCount, teamCount, questionCount }
function activityDto(a, extra = {}) {
  const d = activityDerived(a);
  return {
    id: idStr(a),
    eventId: a.eventId ? idStr(a.eventId) : null,
    isTeamBased: !!extra.isTeamBased,
    order: a.order,
    type: a.type,
    title: a.title,
    description: a.description ?? null,
    imageUrl: a.imageUrl ?? null,
    status: a.status,
    scoreEntryMode: a.scoreEntryMode,
    roundCount: a.roundCount,
    playersPerRound: a.playersPerRound ?? null,
    latitude: a.latitude ?? null,
    longitude: a.longitude ?? null,
    radiusMeters: a.radiusMeters ?? null,
    mapCityCount: a.mapCityCount ?? null,
    hasLocation: d.hasLocation,
    joinCode: a.joinCode,
    canManage: !!extra.canManage,
    scoringMode: a.scoringMode,
    measurement: a.measurement,
    targetValue: a.targetValue ?? null,
    matchFormat: a.matchFormat,
    bestOfSets: a.bestOfSets,
    gamesToWinSet: a.gamesToWinSet,
    useGroupStage: a.useGroupStage,
    groupCount: a.groupCount,
    groupMatchFormat: a.groupMatchFormat,
    groupBestOfSets: a.groupBestOfSets,
    groupGamesToWinSet: a.groupGamesToWinSet,
    advanceToPlayoffA: a.advanceToPlayoffA,
    advanceToPlayoffB: a.advanceToPlayoffB,
    playoffAConsolation: a.playoffAConsolation,
    playoffBConsolation: a.playoffBConsolation,
    useManualSeeding: a.useManualSeeding,
    tournamentScoring: a.tournamentScoring,
    randomizeQuestions: a.randomizeQuestions,
    musicChoices: a.musicChoices,
    speedScoring: a.speedScoring,
    hitsterMode: !!a.hitsterMode,
    hitsterCardsToWin: a.hitsterCardsToWin ?? 10,
    spotifyConnectionId: a.spotifyConnectionId ? idStr(a.spotifyConnectionId) : null,
    hideQuestionsFromHost: a.hideQuestionsFromHost,
    inLibrary: !!a.inLibrary,
    isPublic: a.isPublic,
    copiedFromId: a.copiedFromId ? idStr(a.copiedFromId) : null,
    courtLabel: a.courtLabel,
    courts: (a.courts || []).map(courtDto),
    participantCount: extra.participantCount ?? 0,
    playerCount: extra.playerCount ?? 0,
    teamCount: extra.teamCount ?? 0,
    questionCount: extra.questionCount ?? 0,
    createdUtc: a.createdUtc,
    startedUtc: a.startedUtc ?? null,
    finishedUtc: a.finishedUtc ?? null,
    ...d,
  };
}

// ── Participant ───────────────────────────────────────────────────────────────
const participantDto = (p) => ({
  id: idStr(p),
  displayName: p.displayName,
  isAdmin: p.isAdmin,
  joinedUtc: p.joinedUtc,
});

// ── Questions ─────────────────────────────────────────────────────────────────
const answerOptionDto = (o) => ({ id: idStr(o), order: o.order, text: o.text }); // player (no correctness)
const answerOptionAdminDto = (o) => ({ id: idStr(o), order: o.order, text: o.text, isCorrect: o.isCorrect });

// Player-facing question — correctness omitted; music answer keys never sent.
function questionDto(q) {
  return {
    id: idStr(q),
    order: q.order,
    text: q.text,
    kind: q.kind,
    points: q.points,
    imageUrl: q.imageUrl ?? null,
    latitude: q.latitude ?? null,
    longitude: q.longitude ?? null,
    radiusMeters: q.radiusMeters ?? null,
    options: (q.options || []).map(answerOptionDto),
    asksYear: q.releaseYear != null,
    startedUtc: q.playStartedUtc ?? null,
    hasLocation: q.latitude != null && q.longitude != null,
  };
}

// Is a host question fully authored (drives the editor's "ready" badge)?
function questionIsComplete(q) {
  if (q.kind === QuestionKind.FreeText) {
    return !!(q.acceptedFreeTextAnswer && q.acceptedFreeTextAnswer.trim());
  }
  const opts = q.options || [];
  const correct = opts.filter((o) => o.isCorrect).length;
  const allTexted = opts.every((o) => o.text && o.text.trim());
  return opts.length >= 2 && correct === 1 && allTexted;
}

// Host/admin question — includes the answer key, unless the activity hides
// questions from the host (then text/answers are blanked, Hidden=true).
function questionAdminDto(q, { hidden = false } = {}) {
  const hasLocation = q.latitude != null && q.longitude != null;
  if (hidden) {
    return {
      id: idStr(q), order: q.order, text: '', kind: q.kind, points: q.points,
      imageUrl: null, latitude: null, longitude: null, radiusMeters: null,
      acceptedFreeTextAnswer: null, spotifyUrl: null, acceptedArtist: null, releaseYear: null,
      options: [], hidden: true, hasLocation, isComplete: true,
    };
  }
  return {
    id: idStr(q),
    order: q.order,
    text: q.text,
    kind: q.kind,
    points: q.points,
    imageUrl: q.imageUrl ?? null,
    latitude: q.latitude ?? null,
    longitude: q.longitude ?? null,
    radiusMeters: q.radiusMeters ?? null,
    acceptedFreeTextAnswer: q.acceptedFreeTextAnswer ?? null,
    spotifyUrl: q.spotifyUrl ?? null,
    acceptedArtist: q.acceptedArtist ?? null,
    releaseYear: q.releaseYear ?? null,
    options: (q.options || []).map(answerOptionAdminDto),
    hidden: false,
    hasLocation,
    isComplete: questionIsComplete(q),
  };
}

// Reveal a question + its correct answer (after finish).
function questionResultDto(q) {
  const correct = (q.options || []).find((o) => o.isCorrect);
  return {
    questionId: idStr(q),
    order: q.order,
    text: q.text,
    kind: q.kind,
    points: q.points,
    correctOptionId: correct ? idStr(correct) : null,
    correctAnswerText: q.acceptedFreeTextAnswer ?? (correct ? correct.text : null),
    options: (q.options || []).map(answerOptionDto),
  };
}

// ── Score / map / memory / photo / chat / spotify / viewer ────────────────────
const scoreEntryDto = (e, names = {}) => ({
  id: idStr(e),
  participantId: idStr(e.participantId),
  participantName: names.participantName ?? null,
  userId: e.userId ? idStr(e.userId) : null,
  userName: names.userName ?? null,
  round: e.round,
  points: e.points,
  note: e.note ?? null,
  recordedUtc: e.recordedUtc,
});

// MapPin city — real coords NEVER sent; only revealed distance once pinned.
const mapCityDto = (c, { pinned = false, distanceKm = null } = {}) => ({
  id: idStr(c),
  order: c.order,
  name: c.name,
  pinned,
  distanceKm: pinned ? distanceKm : null,
});

const memoryCardDto = (c) => ({ id: idStr(c), order: c.order, text: c.text });

const activityPhotoDto = (p) => ({
  id: idStr(p), author: p.author, url: p.url, createdUtc: p.createdUtc,
});

const chatMessageDto = (m) => ({
  id: idStr(m), author: m.author, text: m.text, createdUtc: m.createdUtc,
});

// Spotify connection — tokens stay server-side.
const spotifyConnectionDto = (c) => ({
  id: idStr(c), name: c.name, createdUtc: c.createdUtc, status: c.lastStatus ?? null,
});

const viewerDto = (v) => ({ token: v.token, name: v.name });

module.exports = {
  idStr,
  userDto,
  accountSummaryDto,
  activityDerived,
  courtDto,
  activityDto,
  participantDto,
  answerOptionDto,
  answerOptionAdminDto,
  questionDto,
  questionIsComplete,
  questionAdminDto,
  questionResultDto,
  scoreEntryDto,
  mapCityDto,
  memoryCardDto,
  activityPhotoDto,
  chatMessageDto,
  spotifyConnectionDto,
  viewerDto,
};
