// GameplayEndpoints — the MERN port of Rundan.Server/Endpoints/GameplayEndpoints.cs:
// answer submission + my-answers (Quiz / Tipspromenad / MusicQuiz), score lines
// (Boule / generic score game), and the activity photo wall. All routes mount
// under the shared base `/api/activities` (see app.js); only this router's
// sub-paths are defined here.
//
// rundan kept these write paths in a GameService; this port has no such module,
// so the answer-evaluation math is delegated to services/scoring.scoreAnswer (the
// pure, side-effect-free port of GameService's scoring branch) and the persistence
// + auto-finish bookkeeping lives inline here, mirroring GameService exactly.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

const {
  Activity, Participant, Question, Answer, ScoreEntry, User, BracketMatch,
} = require('../models');
const {
  ActivityType, ActivityStatus, ScoreEntryMode, Measurement,
} = require('../constants/enums');
const { idStr, scoreEntryDto, activityPhotoDto } = require('../services/serializers');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { canManageActivity, activityManager } = require('../middleware/eventAuth');
const { resolveParticipantForActivity, HEADER: PARTICIPANT_HEADER } = require('../middleware/participant');
const { pushScoreboard } = require('../services/scoreboard');
const scoring = require('../services/scoring');
const { notifyActivityFinished, notify } = require('../services/push');
const { uploadsDir } = require('../config/paths');
const emit = require('../socket/emit');

const router = express.Router();

// Resolve (and assert) the participant BEFORE multer touches the request, so an
// unauthenticated/non-participant upload never writes a file to disk.
const requireParticipant = asyncHandler(async (req, res, next) => {
  req.participant = await resolveParticipantForActivity(req, req.params.id);
  next();
});

// ── Photo upload (multer → uploads dir) ───────────────────────────────────────
// Player photos: random 32-hex name + original ext, 8 MB cap, image extensions
// only. Mirrors GameService photo handling (the rundan upload helper).
const PHOTO_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'];

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${crypto.randomUUID().replace(/-/g, '')}${ext}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!PHOTO_EXTS.includes(ext)) {
      cb(new RuleViolation('Use a JPG, PNG, GIF, WEBP or HEIC photo.'));
      return;
    }
    cb(null, true);
  },
});

// ── Answers (Quiz / Tipspromenad / MusicQuiz) ─────────────────────────────────

// Build the AnswerResultDto for a stored answer (port of BuildAnswerResultAsync).
// answeredCount = the team's total submitted answers across the activity.
async function buildAnswerResult(participantId, question, answer, totalQuestions, isMusic) {
  const answeredCount = await Answer.countDocuments({ participantId });
  const dto = {
    questionId: idStr(question),
    isCorrect: answer.isCorrect,
    awardedPoints: answer.awardedPoints,
    answeredCount,
    totalQuestions,
    songCorrect: false,
    artistCorrect: false,
    correctSong: null,
    correctArtist: null,
    correctYear: null,
    yearPoints: 0,
  };
  if (isMusic) {
    // Reveal this track's answers to the team that just answered it.
    dto.songCorrect = scoring.matches(answer.freeText, question.acceptedFreeTextAnswer);
    dto.artistCorrect = scoring.matches(answer.artistText, question.acceptedArtist);
    dto.correctSong = question.acceptedFreeTextAnswer ?? null;
    dto.correctArtist = question.acceptedArtist ?? null;
    dto.correctYear = question.releaseYear ?? null;
    dto.yearPoints = scoring.scoreYear(answer.guessedYear, question.releaseYear, question.points);
  }
  return dto;
}

// Quiz / tipspromenad / music quiz auto-finish (port of TryAutoFinishQuestionsAsync).
// Roster team games (a fixed set); a music quiz also counts individual players and
// finishes once every track's answer window has elapsed. Returns true on transition.
async function tryAutoFinishQuestions(activity) {
  if (![ActivityType.Quiz, ActivityType.Tipspromenad, ActivityType.MusicQuiz].includes(activity.type)
    || activity.status !== ActivityStatus.Live) {
    return false;
  }

  // Music quiz: finish once every track has been played and its window has run out.
  if (activity.type === ActivityType.MusicQuiz) {
    const starts = await Question.find({ activityId: activity._id }).select('playStartedUtc').lean();
    if (starts.length > 0 && starts.every((q) => q.playStartedUtc != null)) {
      const maxStart = Math.max(...starts.map((q) => new Date(q.playStartedUtc).getTime()));
      if (Date.now() >= maxStart + scoring.SPEED_WINDOW_SECONDS * 1000) {
        activity.status = ActivityStatus.Finished;
        activity.finishedUtc = new Date();
        await activity.save();
        return true;
      }
    }
  }

  // Everyone answered every question (roster teams; +individual players for music).
  const isMusic = activity.type === ActivityType.MusicQuiz;
  const players = await Participant.find({
    activityId: activity._id,
    ...(isMusic ? {} : { isTeam: true }),
  }).select('_id').lean();
  const questionCount = await Question.countDocuments({ activityId: activity._id });
  const expected = players.length * questionCount;
  if (expected <= 0) return false;

  const recorded = await Answer.countDocuments({ participantId: { $in: players.map((p) => p._id) } });
  if (recorded < expected) return false;

  activity.status = ActivityStatus.Finished;
  activity.finishedUtc = new Date();
  await activity.save();
  return true;
}

// POST /api/activities/:id/answers — participant of THIS activity.
// SubmitAnswerRequest { questionId, selectedOptionId?, freeText?, artistText?, year? }.
router.post('/:id/answers', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const participant = await resolveParticipantForActivity(req, id);
  const r = req.body || {};

  const question = await Question.findById(r.questionId);
  if (!question) throw new RuleViolation('That question no longer exists.', 404);
  if (String(question.activityId) !== String(participant.activityId)) {
    throw new RuleViolation('That question is not part of your activity.');
  }

  const activity = await Activity.findById(participant.activityId);
  if (!activity) throw new RuleViolation('This activity no longer exists.', 404);
  if (activity.status !== ActivityStatus.Live) {
    throw new RuleViolation('This activity is not accepting answers right now.', 409);
  }

  const isMusic = activity.type === ActivityType.MusicQuiz;
  const totalQuestions = await Question.countDocuments({ activityId: activity._id });

  // Already answered? Return the original result (no resubmission / score farming).
  const existing = await Answer.findOne({ questionId: question._id, participantId: participant._id });
  if (existing) {
    return res.json(await buildAnswerResult(participant._id, question, existing, totalQuestions, isMusic));
  }

  // Score the submission (pure). scoreAnswer throws RuleViolation on bad input.
  const scored = scoring.scoreAnswer(question, {
    selectedOptionId: r.selectedOptionId,
    freeText: r.freeText,
    artistText: r.artistText,
    year: r.year,
  }, { activity, now: () => new Date() });

  let answer;
  try {
    answer = await Answer.create({
      questionId: question._id,
      participantId: participant._id,
      selectedOptionId: scored.selectedOptionId,
      freeText: scored.freeText,
      artistText: scored.artistText,
      guessedYear: scored.guessedYear,
      isCorrect: scored.isCorrect,
      awardedPoints: scored.awardedPoints,
      submittedUtc: new Date(),
    });
  } catch (e) {
    // (questionId, participantId) uniqueness race → return the winning row.
    if (e && e.code === 11000) {
      const winner = await Answer.findOne({ questionId: question._id, participantId: participant._id });
      if (winner) {
        return res.json(await buildAnswerResult(participant._id, question, winner, totalQuestions, isMusic));
      }
    }
    throw e;
  }

  const result = await buildAnswerResult(participant._id, question, answer, totalQuestions, isMusic);
  await pushScoreboard(id);

  // Auto-finalize once every participant has answered every question.
  if (await tryAutoFinishQuestions(activity)) {
    emit.activityStatusChanged(id, { activityId: idStr(activity), status: activity.status });
    notifyActivityFinished(activity._id).catch(() => {});
  }

  res.json(result);
}));

// GET /api/activities/:id/my-answers — the caller's own answers (restore UI state).
router.get('/:id/my-answers', asyncHandler(async (req, res) => {
  const participant = await resolveParticipantForActivity(req, req.params.id);
  const answers = await Answer.find({ participantId: participant._id }).lean();
  res.json(answers.map((a) => ({
    questionId: idStr(a.questionId),
    selectedOptionId: a.selectedOptionId ? idStr(a.selectedOptionId) : null,
    freeText: a.freeText ?? null,
    artistText: a.artistText ?? null,
    year: a.guessedYear ?? null,
    isCorrect: a.isCorrect,
    awardedPoints: a.awardedPoints,
  })));
}));

// POST /api/activities/:id/music/maybe-finish — host nudge to finish a MusicQuiz
// once every track's answer window has elapsed (the host panel calls this when its
// countdown hits 0). Idempotent; returns { finished }.
router.post('/:id/music/maybe-finish', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  let finished = false;
  if (activity.type === ActivityType.MusicQuiz && activity.status === ActivityStatus.Live) {
    finished = await tryAutoFinishQuestions(activity);
    if (finished) {
      emit.activityStatusChanged(idStr(activity), { activityId: idStr(activity), status: activity.status });
      notifyActivityFinished(activity._id).catch(() => {});
    }
  }
  res.json({ finished });
}));

// ── Scores (Boule / generic score game) ───────────────────────────────────────

// RecordScoreRequest persistence (port of GameService.RecordScoreAsync). Records /
// corrects one ScoreEntry; honours per-player team scoring and single-reading
// (time/length) replacement. Returns the saved entry + lookup names for the dto.
async function recordScore(activity, req) {
  if (![ActivityType.Boule, ActivityType.ScoreGame, ActivityType.Memory].includes(activity.type)) {
    throw new RuleViolation('This activity does not use score rounds.');
  }
  // A Boule tournament with a drawn bracket is scored from the bracket, not manual
  // score lines — those would silently leak into the combined event standings.
  if (activity.type === ActivityType.Boule && (await BracketMatch.exists({ activityId: activity._id }))) {
    throw new RuleViolation('This tournament is scored from its bracket.', 409);
  }
  if (activity.status !== ActivityStatus.Live) {
    throw new RuleViolation('This activity is not accepting scores right now.', 409);
  }

  const target = await Participant.findOne({ _id: req.participantId, activityId: activity._id });
  if (!target) throw new RuleViolation('That team is not in this activity.');

  // Per-player mode: the points belong to one roster player on the team.
  let scoredByUserId = null;
  if (activity.scoreEntryMode === ScoreEntryMode.PerPlayer && target.isTeam) {
    const uid = req.userId;
    if (uid == null) throw new RuleViolation('Pick which player scored.');
    const onTeam = (target.members || []).some((m) => String(m.userId) === String(uid));
    if (!onTeam) throw new RuleViolation("That player isn't on this team.");
    scoredByUserId = uid;
  }

  const round = req.round != null ? req.round : 1;
  if (round < 1 || round > 1000) throw new RuleViolation('Round must be between 1 and 1000.');

  const points = Number(req.points);
  if (!Number.isFinite(points) || points < -100000 || points > 100000) {
    throw new RuleViolation('That value is out of range.');
  }

  // Time / length are single measurements — a new reading replaces the old (per
  // player in per-player mode, else the whole team's).
  if ([Measurement.TimeSeconds, Measurement.Millimetres].includes(activity.measurement)) {
    const filter = { activityId: activity._id, participantId: target._id };
    if (activity.scoreEntryMode === ScoreEntryMode.PerPlayer) filter.userId = scoredByUserId;
    await ScoreEntry.deleteMany(filter);
  }

  const note = req.note && String(req.note).trim() ? String(req.note).trim() : null;
  const entry = await ScoreEntry.create({
    activityId: activity._id,
    participantId: target._id,
    userId: scoredByUserId,
    round,
    points,
    note,
    recordedUtc: new Date(),
  });

  const user = scoredByUserId ? await User.findById(scoredByUserId).select('name').lean() : null;
  return scoreEntryDto(entry, {
    participantName: target.displayName,
    userName: user ? user.name : null,
  });
}

// ScoreGame / Memory auto-finish (port of TryAutoFinishScoreGameAsync). Event team
// games only — that's where "complete" is well-defined. Returns true on transition.
async function tryAutoFinishScoreGame(activity) {
  if (![ActivityType.ScoreGame, ActivityType.Memory].includes(activity.type)
    || activity.status !== ActivityStatus.Live || !activity.eventId) {
    return false;
  }

  const teams = await Participant.find({ activityId: activity._id, isTeam: true }).select('_id members').lean();
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

  activity.status = ActivityStatus.Finished;
  activity.finishedUtc = new Date();
  await activity.save();
  return true;
}

// POST /api/activities/:id/scores — participant of THIS activity acts as scorekeeper.
// RecordScoreRequest { participantId, userId?, round(default 1), points, note? }.
router.post('/:id/scores', asyncHandler(async (req, res) => {
  const { id } = req.params;
  // Any participant of this activity (or a manager) may record a score; resolving
  // the participant token both authenticates and asserts activity membership.
  await resolveParticipantForActivity(req, id);

  const activity = await Activity.findById(id);
  if (!activity) throw new RuleViolation('Activity not found.', 404);

  const dto = await recordScore(activity, req.body || {});
  await pushScoreboard(id);

  // Auto-finalize once every expected score is in (so the slap ceremony self-fires).
  if (await tryAutoFinishScoreGame(activity)) {
    emit.activityStatusChanged(id, { activityId: idStr(activity), status: activity.status });
    notifyActivityFinished(activity._id).catch(() => {});
  }

  res.json(dto);
}));

// GET /api/activities/:id/scores — all score lines, by round then recorded order.
router.get('/:id/scores', asyncHandler(async (req, res) => {
  const entries = await ScoreEntry.find({ activityId: req.params.id })
    .sort({ round: 1, _id: 1 })
    .populate('participantId', 'displayName')
    .populate('userId', 'name')
    .lean();
  res.json(entries.map((e) => scoreEntryDto(e, {
    participantName: e.participantId ? e.participantId.displayName : null,
    userName: e.userId ? e.userId.name : null,
  })));
}));

// DELETE /api/activities/:id/scores/:scoreId — host removes a score line.
router.delete('/:id/scores/:scoreId', asyncHandler(async (req, res) => {
  const activity = await Activity.findById(req.params.id);
  if (!activity) return res.status(404).json({ error: 'Activity not found.' });
  if (!(await canManageActivity(req, activity))) {
    return res.status(403).json({ error: 'Only the host or an event admin can do this.' });
  }

  const entry = await ScoreEntry.findOne({ _id: req.params.scoreId, activityId: req.params.id });
  if (!entry) return res.status(404).json({ error: 'Score not found.' });

  await entry.deleteOne();
  await pushScoreboard(req.params.id);
  res.status(204).end();
}));

// ── Activity photo wall ────────────────────────────────────────────────────────

// GET /api/activities/:id/photos — newest first.
router.get('/:id/photos', asyncHandler(async (req, res) => {
  const { ActivityPhoto } = require('../models');
  const photos = await ActivityPhoto.find({ activityId: req.params.id }).sort({ _id: -1 }).lean();
  res.json(photos.map(activityPhotoDto));
}));

// POST /api/activities/:id/photos — participant of THIS activity uploads one image.
// multipart/form-data field `file`. The participant token is checked (requireParticipant)
// BEFORE multer parses the body, so an unauthorized request never writes to disk.
router.post('/:id/photos', requireParticipant, photoUpload.single('file'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { participant } = req;
  if (!req.file) throw new RuleViolation('No photo was uploaded.');

  const { ActivityPhoto } = require('../models');
  const photo = await ActivityPhoto.create({
    activityId: id,
    author: participant.displayName,
    url: `/uploads/${req.file.filename}`,
    createdUtc: new Date(),
  });

  // Web Push for an event activity (best-effort).
  const activity = await Activity.findById(id).select('eventId').lean();
  if (activity && activity.eventId) {
    notify(idStr(activity.eventId), '📷 New photo', `${participant.displayName} added a photo.`, `a/${id}`, 'photo');
  }

  res.json(activityPhotoDto(photo));
}));

// DELETE /api/activities/:id/photos/:photoId — event-host OR the uploading player.
router.delete('/:id/photos/:photoId', asyncHandler(async (req, res) => {
  const { id, photoId } = req.params;
  const { ActivityPhoto } = require('../models');
  const photo = await ActivityPhoto.findOne({ _id: photoId, activityId: id });
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });

  // Allowed for whoever can manage the event …
  const activity = await Activity.findById(id);
  let allowed = activity ? await canManageActivity(req, activity) : false;

  // … or the player who uploaded it (their token's name matches; names are unique).
  if (!allowed) {
    const token = (req.headers[PARTICIPANT_HEADER] || '').toString().trim();
    if (token) {
      const p = await Participant.findOne({ activityId: id, token }).select('displayName').lean();
      allowed = !!p && p.displayName === photo.author;
    }
  }

  if (!allowed) return res.status(403).end();

  const fileUrl = photo.url;
  await photo.deleteOne();

  // Best-effort: drop the file too (an orphan is harmless otherwise).
  try {
    const fs = require('fs');
    const full = path.join(uploadsDir, path.basename(fileUrl || ''));
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch { /* ignore */ }

  res.status(204).end();
}));

module.exports = router;
