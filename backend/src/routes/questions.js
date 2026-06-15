// QuestionEndpoints — the MERN port of Rundan.Server/Endpoints/QuestionEndpoints.cs.
// Player-facing question list + results; admin question CRUD (build the set only
// while Draft), per-station location, post-finish answer-key correction (re-scores
// every stored answer), and the tipspromenad station-count setter.
//
// All routes mount under the shared base `/api/activities` (see app.js); only this
// router's sub-paths are defined here. Management routes use `activityManager`.
const express = require('express');

const {
  Activity, Question, Answer, Participant,
} = require('../models');
const {
  ActivityType, ActivityStatus, QuestionKind,
} = require('../constants/enums');
const {
  idStr, questionDto, questionAdminDto, questionResultDto, questionIsComplete,
} = require('../services/serializers');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { activityManager } = require('../middleware/eventAuth');
const { pushScoreboard } = require('../services/scoreboard');
const musicBrainzSimilar = require('../services/musicBrainzSimilar');

const router = express.Router();

// TextHelpers.Clean — trim; empty becomes null.
const clean = (s) => {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t.length === 0 ? null : t;
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// A plausible release year, or null (NormalizeYear).
const normalizeYear = (year) => (Number.isInteger(year) && year >= 1860 && year <= 2100 ? year : null);

// Ordered questions (with embedded options) for an activity.
const loadOrdered = (activityId) => Question.find({ activityId }).sort({ order: 1 }).lean();

// activity must use questions AND be a Draft to edit (EnsureQuestionEditable).
function ensureQuestionEditable(activity) {
  if (![ActivityType.Quiz, ActivityType.Tipspromenad, ActivityType.MusicQuiz].includes(activity.type)) {
    throw new RuleViolation('This activity type does not use questions.');
  }
  if (activity.status !== ActivityStatus.Draft) {
    throw new RuleViolation(
      'Questions can only be edited while the activity is a draft (before it opens).',
      409,
    );
  }
}

// Validate a QuestionUpsertRequest (per kind). Mirrors Validate.
function validateUpsert(req, type) {
  if (!req.text || !String(req.text).trim()) {
    throw new RuleViolation('A question needs some text.');
  }
  if (req.kind === QuestionKind.FreeText) {
    // Music tracks may be saved blank — completeness is enforced at open.
    if (type !== ActivityType.MusicQuiz && (!req.acceptedFreeTextAnswer || !String(req.acceptedFreeTextAnswer).trim())) {
      throw new RuleViolation('A free-text question needs an accepted answer.');
    }
    return;
  }
  const options = req.options || [];
  if (options.length < 2) throw new RuleViolation('Add at least two options.');
  if (options.filter((o) => o.isCorrect).length !== 1) {
    throw new RuleViolation('Mark exactly one option as correct.');
  }
  if (options.some((o) => !o.text || !String(o.text).trim())) {
    throw new RuleViolation('Every option needs some text.');
  }
}

// Build the embedded options array from a request (order 0..n, trimmed text).
function buildOptions(req) {
  if (req.kind === QuestionKind.FreeText) return [];
  return (req.options || []).map((o, i) => ({
    order: i, text: String(o.text).trim(), isCorrect: !!o.isCorrect,
  }));
}

// Serialize a list of questions, masking completed ones if the host hides them.
const maskIfHidden = (questions, hide) => questions.map((q) => questionAdminDto(q, {
  hidden: hide && questionIsComplete(q),
}));

// ── Players: questions to play, and the answer key once finished ──────────────

// GET /api/activities/:id/questions — Live/Finished only; correctness omitted.
router.get('/:id/questions', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const activity = await Activity.findById(id).lean();
  if (!activity) throw new RuleViolation('Activity not found.', 404);
  if (activity.status === ActivityStatus.Draft || activity.status === ActivityStatus.Open) {
    throw new RuleViolation("Questions aren't available until the activity starts.", 409);
  }

  const questions = await loadOrdered(id);
  const dtos = questions.map(questionDto);

  // Kahoot-style music quiz: attach four artist options (never leaking the right one).
  if (activity.type === ActivityType.MusicQuiz && activity.musicChoices) {
    let similar = null;
    if (musicBrainzSimilar.enabled()) {
      // MusicBrainz "similar artists" per distinct correct artist (best-effort distractors).
      similar = new Map();
      // eslint-disable-next-line no-restricted-syntax
      for (const q of questions) {
        const correct = (q.acceptedArtist || '').trim();
        if (correct.length > 0 && !similar.has(correct.toLowerCase())) {
          // eslint-disable-next-line no-await-in-loop
          similar.set(correct.toLowerCase(), await musicBrainzSimilar.similarArtists(correct));
        }
      }
    }
    populateMusicChoices(dtos, questions, similar);
  }

  res.json(dtos);
}));

// GET /api/activities/:id/results — Finished only; MusicQuiz returns [].
router.get('/:id/results', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const activity = await Activity.findById(id).lean();
  if (!activity) throw new RuleViolation('Activity not found.', 404);
  if (activity.status !== ActivityStatus.Finished) {
    throw new RuleViolation('Results are revealed once the activity is finished.', 409);
  }
  // Music answers stay host-only — players already got the per-track reveal.
  if (activity.type === ActivityType.MusicQuiz) return res.json([]);

  const questions = await loadOrdered(id);
  res.json(questions.map(questionResultDto));
}));

// ── Admin: build the question set (only while Draft) ──────────────────────────

// GET /api/activities/:id/questions/admin?reveal=
router.get('/:id/questions/admin', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const reveal = req.query.reveal === 'true' || req.query.reveal === true;
  const questions = await loadOrdered(activity._id);
  res.json(maskIfHidden(questions, activity.hideQuestionsFromHost && !reveal));
}));

// POST /api/activities/:id/questions
router.post('/:id/questions', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;
  const r = req.body || {};
  ensureQuestionEditable(activity);
  validateUpsert(r, activity.type);

  let order = r.order != null ? r.order : 0;
  if (order <= 0) {
    const maxQ = await Question.findOne({ activityId: id }).sort({ order: -1 }).select('order').lean();
    order = (maxQ ? maxQ.order : 0) + 1;
  }

  const isFreeText = r.kind === QuestionKind.FreeText;
  const question = await Question.create({
    activityId: id,
    order,
    text: String(r.text).trim(),
    kind: r.kind != null ? r.kind : QuestionKind.MultipleChoice,
    points: Math.max(0, r.points != null ? r.points : 1),
    imageUrl: clean(r.imageUrl),
    latitude: r.latitude != null ? r.latitude : null,
    longitude: r.longitude != null ? r.longitude : null,
    radiusMeters: r.radiusMeters != null ? r.radiusMeters : null,
    acceptedFreeTextAnswer: isFreeText ? clean(r.acceptedFreeTextAnswer) : null,
    spotifyUrl: clean(r.spotifyUrl),
    acceptedArtist: clean(r.acceptedArtist),
    releaseYear: normalizeYear(r.releaseYear),
    options: buildOptions(r),
  });

  res.status(201)
    .location(`/api/activities/${idStr(activity)}/questions/${idStr(question)}`)
    .json(questionAdminDto(question.toObject()));
}));

// PUT /api/activities/:id/questions/:qid
router.put('/:id/questions/:qid', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;
  const r = req.body || {};
  ensureQuestionEditable(activity);
  validateUpsert(r, activity.type);

  const question = await Question.findOne({ _id: req.params.qid, activityId: id });
  if (!question) return res.status(404).json({ error: 'Question not found.' });

  // A masked save (host hides answers) must not wipe stored values when the
  // incoming field is blank — keep the stored value in that case.
  const hidden = activity.hideQuestionsFromHost;
  const blank = (v) => !v || !String(v).trim();
  const keep = (stored, incoming) => (hidden && blank(incoming) ? stored : incoming);

  question.order = r.order > 0 ? r.order : question.order;
  question.text = hidden && blank(r.text) ? question.text : String(r.text).trim();
  question.kind = r.kind;
  question.points = Math.max(0, r.points != null ? r.points : 0);
  question.imageUrl = clean(r.imageUrl);
  question.latitude = r.latitude != null ? r.latitude : null;
  question.longitude = r.longitude != null ? r.longitude : null;
  question.radiusMeters = r.radiusMeters != null ? r.radiusMeters : null;
  question.acceptedFreeTextAnswer = r.kind === QuestionKind.FreeText
    ? keep(question.acceptedFreeTextAnswer, clean(r.acceptedFreeTextAnswer))
    : null;
  question.spotifyUrl = keep(question.spotifyUrl, clean(r.spotifyUrl));
  question.acceptedArtist = keep(question.acceptedArtist, clean(r.acceptedArtist));
  question.releaseYear = hidden && normalizeYear(r.releaseYear) == null
    ? question.releaseYear
    : normalizeYear(r.releaseYear);

  // A masked save carries no options; don't let it wipe the stored ones.
  if (!(hidden && (!r.options || r.options.length === 0))) {
    question.options = buildOptions(r);
  }

  await question.save();
  res.json(questionAdminDto(question.toObject()));
}));

// PUT /api/activities/:id/questions/:qid/location — geo only, allowed any time.
router.put('/:id/questions/:qid/location', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const r = req.body || {};
  const question = await Question.findOne({ _id: req.params.qid, activityId: activity._id });
  if (!question) return res.status(404).json({ error: 'Question not found.' });

  question.latitude = r.latitude != null ? r.latitude : null;
  question.longitude = r.longitude != null ? r.longitude : null;
  question.radiusMeters = r.radiusMeters != null && r.radiusMeters > 0 ? r.radiusMeters : null;
  await question.save();

  // The response must not leak a hidden activity's question once it's complete.
  const hide = activity.hideQuestionsFromHost && questionIsComplete(question.toObject());
  res.json(questionAdminDto(question.toObject(), { hidden: hide }));
}));

// PUT /api/activities/:id/questions/:qid/answer-key — post-finish correction;
// re-scores every submitted answer for the question. (Ports GameService.UpdateAnswerKeyAsync.)
router.put('/:id/questions/:qid/answer-key', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;
  const r = req.body || {};

  if (![ActivityType.Quiz, ActivityType.Tipspromenad].includes(activity.type)) {
    throw new RuleViolation('This activity type does not use questions.');
  }
  // Post-finish correction only (also stops leaking answers to a host who hid them).
  if (activity.status !== ActivityStatus.Finished) {
    throw new RuleViolation('The answer key can only be corrected once the activity is finished.', 409);
  }

  const question = await Question.findOne({ _id: req.params.qid, activityId: id });
  if (!question) throw new RuleViolation('That question no longer exists.', 404);

  // Apply + validate the new key in place (option ids preserved).
  if (question.kind === QuestionKind.FreeText) {
    const accepted = (r.acceptedFreeTextAnswer || '').trim();
    if (accepted.length === 0) {
      throw new RuleViolation('A free-text question needs an accepted answer.');
    }
    question.acceptedFreeTextAnswer = accepted;
  } else {
    const wanted = r.correctOptionId != null ? String(r.correctOptionId) : null;
    if (wanted == null || !question.options.some((o) => String(o._id) === wanted)) {
      throw new RuleViolation('Pick which option is correct.');
    }
    question.options.forEach((o) => { o.isCorrect = String(o._id) === wanted; });
  }
  await question.save();

  // Re-evaluate every stored answer against the corrected key (non-throwing —
  // the scoreboard + standings both sum awardedPoints, so this reflects across all).
  const answers = await Answer.find({ questionId: question._id });
  // eslint-disable-next-line no-restricted-syntax
  for (const a of answers) {
    let isCorrect;
    if (question.kind === QuestionKind.FreeText) {
      const accepted = (question.acceptedFreeTextAnswer || '').trim();
      isCorrect = accepted.length > 0
        && (a.freeText || '').trim().toLowerCase() === accepted.toLowerCase();
    } else {
      isCorrect = a.selectedOptionId != null
        && question.options.some((o) => String(o._id) === String(a.selectedOptionId) && o.isCorrect);
    }
    a.isCorrect = isCorrect;
    a.awardedPoints = isCorrect ? question.points : 0;
    // eslint-disable-next-line no-await-in-loop
    await a.save();
  }

  await pushScoreboard(id);
  res.json(questionResultDto(question.toObject()));
}));

// DELETE /api/activities/:id/questions/:qid — delete + renumber to 1..N.
router.delete('/:id/questions/:qid', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;
  ensureQuestionEditable(activity);

  const question = await Question.findOne({ _id: req.params.qid, activityId: id });
  if (!question) return res.status(404).json({ error: 'Question not found.' });

  // No answers exist yet (editing is Draft-only), but cascade defensively.
  await Answer.deleteMany({ questionId: question._id });
  await Question.deleteOne({ _id: question._id });

  const remaining = await Question.find({ activityId: id }).sort({ order: 1 });
  for (let i = 0; i < remaining.length; i += 1) {
    remaining[i].order = i + 1;
    // eslint-disable-next-line no-await-in-loop
    await remaining[i].save();
  }

  res.status(204).end();
}));

// PUT /api/activities/:id/stations — set station count (add blanks / trim trailing
// blanks; never auto-delete authored questions). Returns the renumbered list.
router.put('/:id/stations', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const id = activity._id;
  ensureQuestionEditable(activity);

  const target = clamp((req.body || {}).count != null ? req.body.count : 0, 0, 100);
  const questions = await Question.find({ activityId: id }).sort({ order: 1 });

  if (target > questions.length) {
    const docs = [];
    for (let i = questions.length; i < target; i += 1) {
      docs.push({
        activityId: id, order: i + 1, text: '', kind: QuestionKind.MultipleChoice, points: 1,
      });
    }
    await Question.insertMany(docs);
  } else {
    // Trim from the end, stopping at the first authored (playable) question.
    for (let i = questions.length - 1; i >= target; i -= 1) {
      if (isPlayable(questions[i])) break;
      // eslint-disable-next-line no-await-in-loop
      await Question.deleteOne({ _id: questions[i]._id });
    }
  }

  const remaining = await Question.find({ activityId: id }).sort({ order: 1 });
  for (let i = 0; i < remaining.length; i += 1) {
    remaining[i].order = i + 1;
    // eslint-disable-next-line no-await-in-loop
    await remaining[i].save();
  }

  const fresh = await loadOrdered(id);
  res.json(maskIfHidden(fresh, activity.hideQuestionsFromHost));
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Built-in pool of well-known acts to fill out the wrong options (MusicChoices.Pool).
const MUSIC_POOL = [
  'ABBA', 'Queen', 'The Beatles', 'Madonna', 'Michael Jackson', 'Elton John', 'David Bowie',
  'U2', 'Coldplay', 'Adele', 'Beyoncé', 'Rihanna', 'Taylor Swift', 'Ed Sheeran', 'Bruno Mars',
  'Drake', 'Eminem', 'Kanye West', 'Lady Gaga', 'Katy Perry', 'Justin Bieber', 'Maroon 5',
  'Bob Dylan', 'Bruce Springsteen', 'Prince', 'Whitney Houston', 'Mariah Carey', 'Stevie Wonder',
  'Nirvana', 'Red Hot Chili Peppers', 'Metallica', 'AC/DC', 'Pink Floyd', 'Led Zeppelin',
  'The Rolling Stones', 'Fleetwood Mac', 'Daft Punk', 'The Weeknd', 'Dua Lipa', 'Billie Eilish',
  'Avicii', 'Robyn', 'Roxette', 'Kent', 'Veronica Maggio', 'Håkan Hellström',
];

// Deterministic per-track PRNG: derive a numeric seed from the question id string
// (ObjectId in this port) so options + order are stable across reloads for everyone
// (mirrors the C# `new Random(q.Id)`). Mulberry32.
function seededRng(idString) {
  let h = 1779033703 ^ String(idString).length;
  for (let i = 0; i < String(idString).length; i += 1) {
    h = Math.imul(h ^ String(idString).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ciEq = (a, b) => a.toLowerCase() === b.toLowerCase();

// Attach 4 artist options per track (3 distractors + the correct one), shuffled,
// never flagging the correct one. Port of MusicChoices.Populate.
function populateMusicChoices(dtos, questions, similar) {
  const quizArtists = [...new Map(questions
    .map((q) => (q.acceptedArtist || '').trim())
    .filter((a) => a.length > 0)
    .map((a) => [a.toLowerCase(), a])).values()];

  const byId = new Map(dtos.map((d) => [String(d.id), d]));

  // eslint-disable-next-line no-restricted-syntax
  for (const q of questions) {
    const correct = (q.acceptedArtist || '').trim();
    if (correct.length === 0) continue; // artist-less track stays typed
    const dto = byId.get(idStr(q));
    if (!dto) continue;

    const rng = seededRng(idStr(q));
    const shuffle = (arr) => arr
      .map((v) => [rng(), v])
      .sort((x, y) => x[0] - y[0])
      .map(([, v]) => v);
    const notCorrect = (a) => !ciEq(a, correct);
    const distinctCi = (arr) => [...new Map(arr.map((a) => [a.toLowerCase(), a])).values()];

    const simList = similar && similar.get(correct.toLowerCase()) ? similar.get(correct.toLowerCase()) : [];
    const sim = shuffle(distinctCi(simList.filter(notCorrect)));
    const others = shuffle(quizArtists.filter(notCorrect));
    const pool = shuffle(MUSIC_POOL.filter((p) => !quizArtists.some((a) => ciEq(a, p))));

    const distractors = distinctCi([...sim, ...others, ...pool]).slice(0, 3);
    dto.options = shuffle([...distractors, correct])
      .map((text, i) => ({ id: String(i), order: i, text }));
  }
}

module.exports = router;
