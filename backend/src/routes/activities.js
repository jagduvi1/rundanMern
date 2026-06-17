// ActivityEndpoints — the MERN port of Rundan.Server/Endpoints/ActivityEndpoints.cs
// (create / list-by-id / lookup-by-code, the status lifecycle, courts, delete)
// PLUS the finished-activity scoreboard + summary reads that live on the activity
// in this port. All routes here mount under the shared base `/api/activities`
// (see app.js); only this router's sub-paths are defined here.
//
// Auth model note: rundan gated management with a shared admin code. This port
// uses host accounts (JWT) + delegated event-member tokens, so management routes
// use `activityManager` and create uses inline `canManageEvent` — see eventAuth.
const express = require('express');

const {
  Account, Activity, Event, EventMember, Participant, Question, ScoreEntry, Answer, SpotifyConnection,
} = require('../models');
const {
  ActivityType, ActivityStatus, Measurement, ScoringMode, QuestionKind, values,
} = require('../constants/enums');
const { idStr, activityDto } = require('../services/serializers');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { optionalAuth } = require('../middleware/auth');
const { canManageEvent, canManageActivity, activityManager } = require('../middleware/eventAuth');
const { uniqueJoinCode } = require('../utils/joinCode');
const { copyToLibrary } = require('../services/activityLibrary');
const { deleteActivityCascade } = require('../services/cascade');
const { buildScoreboard, pushScoreboard } = require('../services/scoreboard');
const scoring = require('../services/scoring');
const { notifyActivityFinished, notify } = require('../services/push');
const { swedishCities } = require('../services/geo');
const teams = require('../services/teams');
const emit = require('../socket/emit');

const router = express.Router();

// TextHelpers.Clean — trim; empty becomes null (optional text/image fields).
const clean = (s) => {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t.length === 0 ? null : t;
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ── DTO loaders (port of LoadDtoAsync) ────────────────────────────────────────

// Counts + ordered courts; for an event activity, set isTeamBased and (when the
// event has a roster) override player/team counts from the roster size.
async function loadActivityDto(activity, { canManage = false } = {}) {
  const id = activity._id;
  const [participantCount, questionCount] = await Promise.all([
    Participant.countDocuments({ activityId: id }),
    Question.countDocuments({ activityId: id }),
  ]);
  const extra = {
    canManage, participantCount, questionCount, isTeamBased: false, playerCount: 0, teamCount: 0,
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

  // The serializer reads a.courts (sorted) → courtDto; the embedded subdocs carry
  // _id/order/name, so the raw doc projects correctly. Pass an ordered copy.
  const plain = activity.toObject ? activity.toObject() : activity;
  plain.courts = (activity.courts || []).slice().sort((a, b) => a.order - b.order);
  return activityDto(plain, extra);
}

// Allowed status transitions (from == to always allowed). Mirrors IsAllowedTransition.
function isAllowedTransition(from, to) {
  if (from === to) return true;
  const S = ActivityStatus;
  const allowed = [
    [S.Draft, S.Open],
    [S.Open, S.Draft],
    [S.Open, S.Live],
    [S.Live, S.Open],
    [S.Live, S.Finished],
    [S.Finished, S.Live],
    [S.Finished, S.Open],
    [S.Live, S.Draft],
    [S.Finished, S.Draft],
  ];
  return allowed.some(([f, t]) => f === from && t === to);
}

// A question is playable once it has text + a valid answer key (IsPlayable).
function isPlayable(q) {
  if (!q.text || !q.text.trim()) return false;
  if (q.kind === QuestionKind.FreeText) {
    return !!(q.acceptedFreeTextAnswer && q.acceptedFreeTextAnswer.trim());
  }
  const opts = q.options || [];
  return opts.length >= 2
    && opts.filter((o) => o.isCorrect).length === 1
    && opts.every((o) => o.text && o.text.trim());
}

const statusName = (s) => Object.keys(ActivityStatus).find((k) => ActivityStatus[k] === s) || String(s);

// ── Create ────────────────────────────────────────────────────────────────────

// POST /api/activities — host, or an event admin of the target event.
router.post('/', optionalAuth, asyncHandler(async (req, res) => {
  const req0 = req.body || {};
  const eventId = req0.eventId || null;

  // Authorize against the target event (standalone → "no event context" branch).
  let event = null;
  if (eventId) {
    event = await Event.findById(eventId);
    if (!event) throw new RuleViolation('Event not found.', 404);
  }
  if (!(await canManageEvent(req, event))) {
    return res.status(403).json({ error: 'Only the host or an event admin can do this.' });
  }

  const title = (req0.title || '').trim();
  if (!title) throw new RuleViolation('Give the activity a title.');

  let order = 0;
  if (eventId) {
    const maxA = await Activity.findOne({ eventId }).sort({ order: -1 }).select('order').lean();
    order = (maxA ? maxA.order : 0) + 1;
  }

  const type = req0.type != null ? req0.type : ActivityType.Quiz;
  let scoringMode = req0.scoringMode != null ? req0.scoringMode : ScoringMode.HigherWins;
  let measurement = req0.measurement != null ? req0.measurement : Measurement.Points;
  let mapCityCount;

  // Type defaults: MapPin → LowerWins + 5 cities; Memory → LowerWins + time.
  if (type === ActivityType.MapPin) {
    scoringMode = ScoringMode.LowerWins;
    mapCityCount = 5;
  }
  if (type === ActivityType.Memory) {
    scoringMode = ScoringMode.LowerWins;
    measurement = Measurement.TimeSeconds;
  }

  const activity = await Activity.create({
    eventId,
    owner: req.user?.id || null,
    order,
    type,
    title,
    description: clean(req0.description),
    imageUrl: clean(req0.imageUrl),
    scoringMode,
    measurement,
    targetValue: req0.targetValue != null ? req0.targetValue : null,
    mapCityCount: mapCityCount != null ? mapCityCount : null,
    status: ActivityStatus.Draft,
    joinCode: await uniqueJoinCode([Activity, Event]),
  });

  res.status(201)
    .location(`/api/activities/${idStr(activity)}`)
    .json(await loadActivityDto(activity, { canManage: true }));
}));

// ── Status lifecycle ────────────────────────────────────────────────────────

// PUT /api/activities/:id/status
router.put('/:id/status', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;
  const status = (req.body || {}).status;

  if (!values(ActivityStatus).includes(status)) {
    throw new RuleViolation('Unknown activity status.');
  }
  if (!isAllowedTransition(activity.status, status)) {
    throw new RuleViolation(
      `Cannot change status from ${statusName(activity.status)} to ${statusName(status)}.`,
      409,
    );
  }

  const leavingDraft = activity.status === ActivityStatus.Draft
    && (status === ActivityStatus.Open || status === ActivityStatus.Live);

  // Leaving Draft for a quiz/tipspromenad: every station must be playable.
  if (leavingDraft && (activity.type === ActivityType.Quiz || activity.type === ActivityType.Tipspromenad)) {
    const questions = await Question.find({ activityId: id }).lean();
    const blanks = questions.filter((q) => !isPlayable(q)).length;
    if (blanks > 0) {
      throw new RuleViolation(
        `${blanks} station${blanks === 1 ? '' : 's'} still need a question — fill them in before starting.`,
        409,
      );
    }
  }

  // Leaving Draft for a music quiz: every track needs link + song + artist.
  if (leavingDraft && activity.type === ActivityType.MusicQuiz) {
    const tracks = await Question.find({ activityId: id }).lean();
    const incomplete = tracks.filter((q) => !q.spotifyUrl || !String(q.spotifyUrl).trim()
      || !q.acceptedFreeTextAnswer || !String(q.acceptedFreeTextAnswer).trim()
      || !q.acceptedArtist || !String(q.acceptedArtist).trim()).length;
    if (tracks.length === 0 || incomplete > 0) {
      throw new RuleViolation(
        tracks.length === 0
          ? 'Add at least one track before starting.'
          : `${incomplete} track${incomplete === 1 ? '' : 's'} still need a Spotify link, song and artist.`,
        409,
      );
    }
  }

  if (status === ActivityStatus.Live && activity.startedUtc == null) {
    activity.startedUtc = new Date();
  }
  // Entering Finished stamps the finish time; leaving it clears it.
  activity.finishedUtc = status === ActivityStatus.Finished ? new Date() : null;
  activity.status = status;
  await activity.save();

  // Opening/starting an event activity generates its teams (the partner mixer).
  if (activity.eventId && (status === ActivityStatus.Open || status === ActivityStatus.Live)) {
    const ev = await Event.findById(activity.eventId).lean();
    await teams.ensureTeams(ev, activity);
  }

  // MapPin: draw the cities once when it first opens (embedded on the activity).
  if (activity.type === ActivityType.MapPin
    && (status === ActivityStatus.Open || status === ActivityStatus.Live)
    && (activity.mapCities || []).length === 0) {
    const pool = swedishCities();
    const n = clamp(activity.mapCityCount != null ? activity.mapCityCount : 5, 1, pool.length);
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    activity.mapCities = pool.slice(0, n).map((c, i) => ({
      order: i, name: c.name, latitude: c.lat, longitude: c.lng,
    }));
    await activity.save();
  }

  // Realtime: status + scoreboard.
  emit.activityStatusChanged(id, { activityId: idStr(activity), status: activity.status });
  await pushScoreboard(id);

  // Web Push for an event activity going live / finishing.
  if (activity.eventId) {
    const evId = idStr(activity.eventId);
    if (status === ActivityStatus.Live) {
      notify(evId, '▶ Activity started', `“${activity.title}” is live — go play!`, `e/${evId}`, `live-${idStr(activity)}`);
    } else if (status === ActivityStatus.Finished) {
      notifyActivityFinished(id).catch(() => {});
    }
  }

  res.json(await loadActivityDto(activity, { canManage: true }));
}));

// ── Update ──────────────────────────────────────────────────────────────────

// PUT /api/activities/:id — full editable field set; type change only while Draft.
router.put('/:id', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;
  const r = req.body || {};

  const title = (r.title || '').trim();
  if (!title) throw new RuleViolation('Give the activity a title.');

  const type = r.type != null ? r.type : ActivityType.Quiz;

  // Type change: only while Draft; abandons the old type's authored content.
  if (type !== activity.type) {
    if (activity.status !== ActivityStatus.Draft) {
      throw new RuleViolation("Change the activity's type only while it's a draft.", 409);
    }
    const { BracketMatch } = require('../models');
    await Promise.all([
      Question.deleteMany({ activityId: id }),
      ScoreEntry.deleteMany({ activityId: id }),
      BracketMatch.deleteMany({ activityId: id }),
    ]);
    // Courts + drawn cities are embedded — clearing them mirrors the C# removes.
    activity.courts = [];
    activity.mapCities = [];
    activity.type = type;
  }

  activity.title = title;
  activity.description = clean(r.description);
  activity.imageUrl = clean(r.imageUrl);
  activity.scoringMode = r.scoringMode != null ? r.scoringMode : ScoringMode.HigherWins;
  activity.measurement = r.measurement != null ? r.measurement : Measurement.Points;
  activity.targetValue = (activity.measurement === Measurement.TimeSeconds
    || activity.scoringMode === ScoringMode.ClosestToTarget)
    ? (r.targetValue != null ? r.targetValue : null)
    : null;
  activity.randomizeQuestions = !!r.randomizeQuestions;
  activity.musicChoices = !!r.musicChoices && activity.type === ActivityType.MusicQuiz;
  activity.speedScoring = !!r.speedScoring && activity.type === ActivityType.MusicQuiz;
  activity.hitsterMode = !!r.hitsterMode && activity.type === ActivityType.MusicQuiz;
  activity.hitsterCardsToWin = activity.hitsterMode
    ? Math.max(3, Math.min(30, Number(r.hitsterCardsToWin) || 10)) : 10;
  // Bind a Spotify connection only if it's the caller's OWN (connections are
  // per-user). Without this an attacker could attach another host's connection to
  // their activity and exercise that host's OAuth grant server-side (private
  // playlist exfiltration) via the music lookup/import paths. Keep an unchanged
  // value as-is so a co-host editing other fields doesn't unbind it.
  if (activity.type !== ActivityType.MusicQuiz || !r.spotifyConnectionId) {
    activity.spotifyConnectionId = null;
  } else if (String(r.spotifyConnectionId) === String(activity.spotifyConnectionId || '')) {
    // unchanged — keep
  } else {
    let owned = false;
    try {
      owned = !!(req.user
        && await SpotifyConnection.exists({ _id: r.spotifyConnectionId, ownerId: req.user.id }));
    } catch { owned = false; } // bad ObjectId etc. → treat as not owned
    activity.spotifyConnectionId = owned ? r.spotifyConnectionId : null;
  }
  activity.hideQuestionsFromHost = !!r.hideQuestionsFromHost;
  activity.isPublic = !!r.isPublic;
  activity.scoreEntryMode = r.scoreEntryMode != null ? r.scoreEntryMode : activity.scoreEntryMode;
  activity.roundCount = clamp(r.roundCount != null ? r.roundCount : 1, 1, 50);
  activity.playersPerRound = r.playersPerRound != null ? clamp(r.playersPerRound, 1, 50) : null;
  activity.latitude = r.latitude != null ? r.latitude : null;
  activity.longitude = r.longitude != null ? r.longitude : null;
  activity.radiusMeters = r.radiusMeters != null ? r.radiusMeters : null;

  if (activity.type === ActivityType.MapPin) {
    const cityPool = swedishCities();
    activity.mapCityCount = r.mapCityCount != null ? clamp(r.mapCityCount, 1, cityPool.length) : 5;
    activity.scoringMode = ScoringMode.LowerWins;
  }
  if (activity.type === ActivityType.Memory) {
    activity.scoringMode = ScoringMode.LowerWins;
  }

  activity.matchFormat = r.matchFormat != null ? r.matchFormat : activity.matchFormat;
  activity.bestOfSets = [1, 3, 5].includes(r.bestOfSets) ? r.bestOfSets : 3;
  activity.gamesToWinSet = clamp(r.gamesToWinSet != null ? r.gamesToWinSet : 13, 1, 100);

  // Tournament advanced options.
  activity.useGroupStage = !!r.useGroupStage;
  activity.groupCount = clamp(r.groupCount != null ? r.groupCount : 0, 0, 32);
  activity.groupMatchFormat = r.groupMatchFormat != null ? r.groupMatchFormat : activity.groupMatchFormat;
  activity.groupBestOfSets = [1, 3, 5].includes(r.groupBestOfSets) ? r.groupBestOfSets : 1;
  activity.groupGamesToWinSet = clamp(r.groupGamesToWinSet != null ? r.groupGamesToWinSet : 13, 1, 100);
  activity.advanceToPlayoffA = clamp(r.advanceToPlayoffA != null ? r.advanceToPlayoffA : 2, 1, 16);
  activity.advanceToPlayoffB = clamp(r.advanceToPlayoffB != null ? r.advanceToPlayoffB : 0, 0, 16);
  activity.playoffAConsolation = r.playoffAConsolation != null ? !!r.playoffAConsolation : true;
  activity.playoffBConsolation = !!r.playoffBConsolation;
  activity.useManualSeeding = !!r.useManualSeeding;
  activity.tournamentScoring = r.tournamentScoring != null ? r.tournamentScoring : activity.tournamentScoring;

  await activity.save();
  res.json(await loadActivityDto(activity, { canManage: true }));
}));

// ── Courts ────────────────────────────────────────────────────────────────────

// PUT /api/activities/:id/courts
router.put('/:id/courts', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;
  const r = req.body || {};

  const label = (r.label && String(r.label).trim()) ? String(r.label).trim() : 'Court';
  activity.courtLabel = label;

  const names = Array.isArray(r.names) ? r.names : [];
  const count = clamp(names.length, 0, 50);
  const existing = (activity.courts || []).slice().sort((a, b) => a.order - b.order);

  // Drop surplus courts (clear bracket refs first), then update/add the rest.
  const dropped = existing.slice(count);
  if (dropped.length > 0) {
    const { BracketMatch } = require('../models');
    const droppedIds = dropped.map((c) => c._id);
    await BracketMatch.updateMany(
      { courtId: { $in: droppedIds } },
      { $set: { courtId: null } },
    );
  }

  const next = [];
  for (let i = 0; i < count; i += 1) {
    const nm = (names[i] && String(names[i]).trim()) ? String(names[i]).trim() : `${label} ${i + 1}`;
    if (i < existing.length) {
      const c = existing[i];
      c.order = i + 1;
      c.name = nm;
      next.push(c);
    } else {
      next.push({ order: i + 1, name: nm });
    }
  }
  activity.courts = next;

  await activity.save();
  res.json(await loadActivityDto(activity, { canManage: true }));
}));

// ── Delete ──────────────────────────────────────────────────────────────────

// DELETE /api/activities/:id → cascade; renumber the event's remaining activities.
router.delete('/:id', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;
  const eventId = activity.eventId;

  await deleteActivityCascade(id);

  if (eventId) {
    const remaining = await Activity.find({ eventId }).sort({ order: 1 });
    for (let i = 0; i < remaining.length; i += 1) {
      remaining[i].order = i + 1;
      // eslint-disable-next-line no-await-in-loop
      await remaining[i].save();
    }
  }

  res.status(204).end();
}));

// ── List: standalone / library activities ─────────────────────────────────────

// GET /api/activities — activities the caller can manage that are NOT part of an
// event (eventId: null), PLUS any public library activities (isPublic: true).
// Returns ActivityDto[] (newest first) with counts and per-item canManage; items
// the caller can't manage are filtered out unless they're public. A no-segment GET
// so it never collides with GET /:id or GET /by-code/:code.
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
  const candidates = await Activity.find({
    $or: [{ eventId: null }, { isPublic: true }],
  }).sort({ createdUtc: -1, _id: -1 });

  const dtos = [];
  for (const a of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const canManage = await canManageActivity(req, a);
    if (!canManage && !a.isPublic) continue; // drop what the caller can't see
    // eslint-disable-next-line no-await-in-loop
    dtos.push(await loadActivityDto(a, { canManage }));
  }
  res.json(dtos);
}));

// ── Library (reusable activity templates) ─────────────────────────────────────

// POST /api/activities/:id/add-to-library — snapshot this activity into the caller's
// own library as a standalone, reusable template (private until they publish it).
// Auth: the caller must be able to manage the source activity.
router.post('/:id/add-to-library', activityManager, asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to use the library.' });
  const { activity } = await copyToLibrary(req.targetActivity._id, req.user.id);
  res.status(201)
    .location(`/api/activities/${idStr(activity)}`)
    .json(await loadActivityDto(activity, { canManage: true }));
}));

// POST /api/activities/:id/library-visibility — share / unshare a library template
// with every logged-in user. Only the owner (canManageActivity) may toggle it.
router.post('/:id/library-visibility', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  if (!activity.inLibrary) throw new RuleViolation('Only library activities can be shared.', 409);
  activity.isPublic = !!(req.body || {}).isPublic;
  await activity.save();
  res.json(await loadActivityDto(activity, { canManage: true }));
}));

// GET /api/activities/library/mine — the caller's own reusable library templates.
router.get('/library/mine', optionalAuth, asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to view your library.' });
  const items = await Activity.find({ owner: req.user.id, inLibrary: true })
    .sort({ createdUtc: -1, _id: -1 });
  const dtos = [];
  for (const a of items) {
    // eslint-disable-next-line no-await-in-loop
    dtos.push(await loadActivityDto(a, { canManage: true }));
  }
  res.json(dtos);
}));

// GET /api/activities/library/public — every publicly shared library template, each
// with its author's display name. Logged-in users only (the "share with others" list).
router.get('/library/public', optionalAuth, asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to browse the shared library.' });
  const items = await Activity.find({ inLibrary: true, isPublic: true })
    .sort({ createdUtc: -1, _id: -1 });
  const ownerIds = [...new Set(items.map((a) => a.owner).filter(Boolean).map(String))];
  const owners = ownerIds.length
    ? await Account.find({ _id: { $in: ownerIds } }).select('displayName username').lean()
    : [];
  const nameById = new Map(owners.map((o) => [String(o._id), o.displayName || o.username]));
  const me = String(req.user.id);
  const dtos = [];
  for (const a of items) {
    // eslint-disable-next-line no-await-in-loop
    const dto = await loadActivityDto(a, { canManage: await canManageActivity(req, a) });
    dto.ownerName = a.owner ? (nameById.get(String(a.owner)) || 'Okänd') : 'Gamedo';
    dto.isMine = !!(a.owner && String(a.owner) === me);
    dtos.push(dto);
  }
  res.json(dtos);
}));

// ── Player lookup ─────────────────────────────────────────────────────────────

// GET /api/activities/:id — ActivityDto with per-request canManage.
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
  const activity = await Activity.findById(req.params.id);
  if (!activity) return res.status(404).json({ error: 'Activity not found.' });
  const canManage = await canManageActivity(req, activity);
  res.json(await loadActivityDto(activity, { canManage }));
}));

// GET /api/activities/by-code/:code — normalize, find by joinCode.
router.get('/by-code/:code', optionalAuth, asyncHandler(async (req, res) => {
  const normalized = String(req.params.code || '').trim().toUpperCase();
  const activity = await Activity.findOne({ joinCode: normalized });
  if (!activity) return res.status(404).json({ error: 'Activity not found.' });
  const canManage = await canManageActivity(req, activity);
  res.json(await loadActivityDto(activity, { canManage }));
}));

// GET /api/activities/:id/used-in — the events that contain copies deep-copied from
// this library template (via "add from library"). Returns [{ id, name }], newest of
// each event de-duplicated. Drives the "Används i …" line on the library page.
router.get('/:id/used-in', optionalAuth, asyncHandler(async (req, res) => {
  const copies = await Activity.find({ copiedFromId: req.params.id, eventId: { $ne: null } })
    .select('eventId').lean();
  const eventIds = [...new Set(copies.map((c) => String(c.eventId)))];
  if (eventIds.length === 0) return res.json([]);
  const events = await Event.find({ _id: { $in: eventIds } }).select('name').lean();
  res.json(events.map((e) => ({ id: String(e._id), name: e.name })));
}));

// ── Scoreboard (initial-load REST mirror of the socket push) ──────────────────

// GET /api/activities/:id/scoreboard
router.get('/:id/scoreboard', asyncHandler(async (req, res) => {
  const dto = await buildScoreboard(req.params.id);
  if (!dto) return res.status(404).json({ error: 'Activity not found.' });
  res.json(dto);
}));

// ── Summary (finished question-activity breakdown) ────────────────────────────

const formatClock = (seconds) => {
  const s = Math.round(Math.max(0, seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// "song — artist · year" (any part optional).
function combine(song, artist, year) {
  let s = [song, artist].filter((p) => p && String(p).trim()).join(' — ');
  if (year != null) s = s.length > 0 ? `${s} · ${year}` : String(year);
  return s.length > 0 ? s : null;
}

// GET /api/activities/:id/summary → ActivitySummaryDto.
router.get('/:id/summary', asyncHandler(async (req, res) => {
  const activity = await Activity.findById(req.params.id).lean();
  if (!activity) return res.status(404).json({ error: 'Activity not found.' });
  if (activity.status !== ActivityStatus.Finished) {
    throw new RuleViolation('The summary is ready once the activity is finished.', 409);
  }
  const id = activity._id;
  const dto = { questions: [] };

  // Participant id → displayName, for score-based rows.
  const participants = await Participant.find({ activityId: id }).select('_id displayName').lean();
  const nameOf = new Map(participants.map((p) => [idStr(p), p.displayName]));

  // MapPin: one row per drawn city (embedded), each player's distance ascending.
  if (activity.type === ActivityType.MapPin) {
    const cities = (activity.mapCities || []).slice().sort((a, b) => a.order - b.order);
    const pins = await ScoreEntry.find({ activityId: id })
      .select('round participantId points').lean();
    for (const c of cities) {
      const sq = { order: c.order, text: c.name, correct: null, answers: [] };
      pins
        .filter((p) => p.round === c.order)
        .sort((a, b) => a.points - b.points)
        .forEach((p) => {
          const km = Number(p.points).toLocaleString('en-US', { maximumFractionDigits: 1, useGrouping: false });
          sq.answers.push({
            player: nameOf.get(idStr(p.participantId)) || '', given: `${km} km away`, isCorrect: null, points: 0,
          });
        });
      dto.questions.push(sq);
    }
    return res.json(dto);
  }

  // Memory: one row, each team's total time (or flips) to clear, fastest first.
  if (activity.type === ActivityType.Memory) {
    const measuresTime = activity.measurement === Measurement.TimeSeconds;
    const raw = await ScoreEntry.find({ activityId: id }).select('participantId points').lean();
    const totals = new Map();
    for (const e of raw) {
      const key = idStr(e.participantId);
      totals.set(key, (totals.get(key) || 0) + e.points);
    }
    const sq = {
      order: 1,
      text: measuresTime ? 'Time to clear the board' : 'Flips to clear the board',
      correct: null,
      answers: [],
    };
    [...totals.entries()]
      .sort((a, b) => a[1] - b[1])
      .forEach(([key, total]) => {
        sq.answers.push({
          player: nameOf.get(key) || '',
          given: measuresTime
            ? formatClock(total)
            : `${Number(total).toLocaleString('en-US', { maximumFractionDigits: 1, useGrouping: false })} flips`,
          isCorrect: null,
          points: 0,
        });
      });
    if (sq.answers.length > 0) dto.questions.push(sq);
    return res.json(dto);
  }

  if (![ActivityType.Quiz, ActivityType.Tipspromenad, ActivityType.MusicQuiz].includes(activity.type)) {
    return res.json(dto); // no per-question breakdown for this kind
  }

  // Quiz / Tipspromenad / MusicQuiz: one row per question.
  const isMusic = activity.type === ActivityType.MusicQuiz;
  const questions = await Question.find({ activityId: id }).sort({ order: 1 }).lean();
  const participantIds = participants.map((p) => p._id);
  const answers = await Answer.find({ participantId: { $in: participantIds } })
    .select('questionId participantId freeText artistText guessedYear selectedOptionId isCorrect awardedPoints')
    .lean();

  for (const q of questions) {
    const opts = q.options || [];
    const correctOption = (opts.find((o) => o.isCorrect) || {}).text;
    const sq = {
      order: q.order,
      text: (q.text && q.text.trim()) ? q.text : `Track ${q.order}`,
      correct: isMusic
        ? combine(q.acceptedFreeTextAnswer, q.acceptedArtist, q.releaseYear)
        : (q.kind === QuestionKind.FreeText ? (q.acceptedFreeTextAnswer ?? null) : (correctOption ?? null)),
      answers: [],
    };

    answers
      .filter((a) => idStr(a.questionId) === idStr(q._id))
      .sort((a, b) => (b.awardedPoints - a.awardedPoints)
        || scoring.compareNameCaseInsensitive(nameOf.get(idStr(a.participantId)), nameOf.get(idStr(b.participantId))))
      .forEach((a) => {
        let given;
        if (isMusic) {
          given = combine(a.freeText, a.artistText, a.guessedYear) ?? '—';
        } else if (q.kind === QuestionKind.FreeText) {
          given = (a.freeText && a.freeText.trim()) ? a.freeText : '—';
        } else {
          const chosen = opts.find((o) => idStr(o._id) === idStr(a.selectedOptionId));
          given = chosen ? chosen.text : '—';
        }
        sq.answers.push({
          player: nameOf.get(idStr(a.participantId)) || '',
          given,
          isCorrect: a.isCorrect,
          points: a.awardedPoints,
        });
      });

    dto.questions.push(sq);
  }

  res.json(dto);
}));

module.exports = router;
