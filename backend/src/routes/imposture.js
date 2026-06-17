// ImpostureEndpoints — the "find the impostor" word game.
//
// Host-paced rounds, one at a time (the active round is embedded on the activity).
// Each round the server picks the next secret word and randomly assigns the
// impostor(s); every player privately fetches their role via GET /imposture/me
// (non-impostors see the word, the impostor sees only "you're the impostor" plus
// an optional category hint). Players give clues out loud, then vote in-app; the
// host reveals, which tallies the votes and writes ScoreEntry rows (so the normal
// scoreboard aggregation scores it). Scheme is host-selectable (ImpostureScoring).
//
// Routes mount under /api/activities. Host actions use `activityManager`; player
// actions resolve the participant token. State changes are picked up by the
// clients via short polling (no dedicated socket event).
const express = require('express');
const mongoose = require('mongoose');

const {
  Activity, Participant, ScoreEntry, ImpostureVote,
} = require('../models');
const { ActivityType, ActivityStatus, ImpostureScoring } = require('../constants/enums');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { activityManager } = require('../middleware/eventAuth');
const { resolveParticipantForActivity } = require('../middleware/participant');
const { pushScoreboard } = require('../services/scoreboard');
const { idStr, impostureWordDto } = require('../services/serializers');

const router = express.Router();

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const norm = (s) => (s || '').trim().toLowerCase();

// Round phases.
const PHASE = { CLUES: 0, VOTING: 1, REVEALED: 2 };

// Scoring constants (the scheme picks which apply — see ImpostureScoring).
const DETECTIVE_POINTS = 1; // a player who votes the real impostor
const IMPOSTOR_SURVIVE = 2; // an impostor the group failed to catch
const GUESS_BONUS = 2;      // a caught impostor who then guesses the word (+Guess scheme)

const MAX_WORDS = 200;

// A family-friendly Swedish starter pack so a quiz is playable out of the box.
const STARTER_WORDS = [
  { word: 'Pizza', category: 'Mat' },
  { word: 'Glass', category: 'Mat' },
  { word: 'Kaffe', category: 'Dryck' },
  { word: 'Strand', category: 'Platser' },
  { word: 'Bibliotek', category: 'Platser' },
  { word: 'Flygplats', category: 'Platser' },
  { word: 'Gitarr', category: 'Musik' },
  { word: 'Trummor', category: 'Musik' },
  { word: 'Fotboll', category: 'Sport' },
  { word: 'Skidor', category: 'Sport' },
  { word: 'Simning', category: 'Sport' },
  { word: 'Elefant', category: 'Djur' },
  { word: 'Pingvin', category: 'Djur' },
  { word: 'Katt', category: 'Djur' },
  { word: 'Tandborste', category: 'Prylar' },
  { word: 'Paraply', category: 'Prylar' },
  { word: 'Cykel', category: 'Fordon' },
  { word: 'Helikopter', category: 'Fordon' },
  { word: 'Vinter', category: 'Årstider' },
  { word: 'Midsommar', category: 'Högtider' },
  { word: 'Astronaut', category: 'Yrken' },
  { word: 'Brandman', category: 'Yrken' },
  { word: 'Vulkan', category: 'Natur' },
  { word: 'Regnbåge', category: 'Natur' },
];

function ensureImposture(activity) {
  if (activity.type !== ActivityType.Imposture) {
    throw new RuleViolation('That activity is not an Imposture game.');
  }
}

// The word list defines the game's content — editable only while a draft (mirrors
// how questions/tracks/cards lock once the activity opens).
function ensureDraft(activity) {
  if (activity.status !== ActivityStatus.Draft) {
    throw new RuleViolation('Words can only be edited while the activity is a draft.', 409);
  }
}

// Shuffle a copy (Fisher–Yates) and take the first `n` — the round's impostor(s).
function pickRandom(items, n) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// Read participants + this round's votes and derive the tally + who was caught.
// An impostor is "caught" when they got strictly more votes than any non-impostor.
async function tallyRound(activity) {
  const round = activity.impostureRound;
  const order = round.order;
  const [participants, votes] = await Promise.all([
    Participant.find({ activityId: activity._id }).select('_id displayName').lean(),
    ImpostureVote.find({ activityId: activity._id, round: order }).lean(),
  ]);

  const impostorSet = new Set((round.impostorIds || []).map((x) => String(x)));
  const votesFor = new Map(); // candidateId → count
  const voterMap = new Map(); // voterId → votedId
  for (const v of votes) {
    const voted = String(v.votedParticipantId);
    votesFor.set(voted, (votesFor.get(voted) || 0) + 1);
    voterMap.set(String(v.voterParticipantId), voted);
  }

  let maxNonImpostor = 0;
  for (const p of participants) {
    const pid = idStr(p);
    if (!impostorSet.has(pid)) maxNonImpostor = Math.max(maxNonImpostor, votesFor.get(pid) || 0);
  }
  const caughtByImpostor = new Map();
  for (const iid of impostorSet) {
    const c = votesFor.get(iid) || 0;
    caughtByImpostor.set(iid, c > 0 && c > maxNonImpostor);
  }
  return { participants, votes, voterMap, votesFor, impostorSet, caughtByImpostor };
}

// Host-facing view of the current round (reveals the word + the impostor(s)).
async function hostRoundDto(activity) {
  const base = {
    scoring: activity.impostureScoring ?? ImpostureScoring.Standard,
    impostorCount: activity.impostorCount ?? 1,
    revealCategoryToImpostor: activity.revealCategoryToImpostor !== false,
    wordCount: (activity.impostureWords || []).length,
    participantCount: await Participant.countDocuments({ activityId: activity._id }),
  };
  const round = activity.impostureRound;
  if (!round) return { ...base, round: 0, phase: null };

  const t = await tallyRound(activity);
  const nameById = new Map(t.participants.map((p) => [idStr(p), p.displayName]));
  const impostors = [...t.impostorSet].map((iid) => ({ id: iid, displayName: nameById.get(iid) || '—' }));
  const tally = t.participants
    .map((p) => ({
      id: idStr(p), displayName: p.displayName, votes: t.votesFor.get(idStr(p)) || 0, isImpostor: t.impostorSet.has(idStr(p)),
    }))
    .sort((a, b) => b.votes - a.votes);

  return {
    ...base,
    round: round.order,
    phase: round.phase,
    word: round.word,
    category: round.category ?? null,
    impostors,
    voteCount: t.votes.length,
    tally: round.phase >= PHASE.VOTING ? tally : null,
    caught: round.phase === PHASE.REVEALED ? impostors.some((im) => t.caughtByImpostor.get(im.id)) : null,
    guess: round.guess || null,
    guessCorrect: !!round.guessCorrect,
  };
}

// ── Host: the secret-word list ────────────────────────────────────────────────

// POST /:id/imposture/words — { word, category? } → { words }
router.post('/:id/imposture/words', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  ensureImposture(activity);
  ensureDraft(activity);
  const word = ((req.body || {}).word || '').trim();
  const category = ((req.body || {}).category || '').trim();
  if (!word) throw new RuleViolation('Enter a word.');
  if ((activity.impostureWords || []).length >= MAX_WORDS) {
    throw new RuleViolation(`You can save up to ${MAX_WORDS} words.`);
  }
  activity.impostureWords.push({ word: word.slice(0, 80), category: category ? category.slice(0, 80) : null });
  await activity.save();
  res.json({ words: activity.impostureWords.map(impostureWordDto) });
}));

// DELETE /:id/imposture/words/:wordId → { words }
router.delete('/:id/imposture/words/:wordId', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  ensureImposture(activity);
  ensureDraft(activity);
  const key = req.params.wordId;
  const before = (activity.impostureWords || []).length;
  activity.impostureWords = (activity.impostureWords || []).filter((w) => idStr(w) !== key);
  if (activity.impostureWords.length !== before) await activity.save();
  res.json({ words: activity.impostureWords.map(impostureWordDto) });
}));

// POST /:id/imposture/words/starter — append the starter pack (skip duplicates).
router.post('/:id/imposture/words/starter', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  ensureImposture(activity);
  ensureDraft(activity);
  const have = new Set((activity.impostureWords || []).map((w) => norm(w.word)));
  for (const sw of STARTER_WORDS) {
    if (activity.impostureWords.length >= MAX_WORDS) break;
    if (!have.has(norm(sw.word))) {
      activity.impostureWords.push({ word: sw.word, category: sw.category });
      have.add(norm(sw.word));
    }
  }
  await activity.save();
  res.json({ words: activity.impostureWords.map(impostureWordDto) });
}));

// ── Host: round view + control ────────────────────────────────────────────────

// GET /:id/imposture/host — the host's view of the current round (word + impostor
// + live tally). Host-only; the host panel polls this.
router.get('/:id/imposture/host', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  ensureImposture(activity);
  res.json(await hostRoundDto(activity));
}));


// POST /:id/imposture/round/start — next word + fresh random impostor(s); phase=clues.
router.post('/:id/imposture/round/start', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  ensureImposture(activity);
  if (activity.status !== ActivityStatus.Live) {
    throw new RuleViolation('Start the activity (set it live) before running rounds.', 409);
  }
  const words = activity.impostureWords || [];
  if (words.length === 0) throw new RuleViolation('Add at least one secret word first.');

  // Don't abandon an in-progress round: it must be revealed (scored) first, or its
  // votes would be silently lost. (A brand-new game has no round yet.)
  if (activity.impostureRound && !activity.impostureRound.scored) {
    throw new RuleViolation('Reveal the current round before starting the next one.', 409);
  }

  const participants = await Participant.find({ activityId: activity._id }).select('_id').lean();
  const impostorCount = clamp(activity.impostorCount || 1, 1, 5);
  if (participants.length < impostorCount + 1) {
    throw new RuleViolation(`Need at least ${impostorCount + 1} players before starting a round.`, 409);
  }

  const order = (activity.impostureRound ? activity.impostureRound.order : 0) + 1;
  const w = words[(order - 1) % words.length];
  const impostorIds = pickRandom(participants.map((p) => p._id), impostorCount);

  activity.impostureRound = {
    order,
    word: w.word,
    category: w.category || null,
    impostorIds,
    phase: PHASE.CLUES,
    startedUtc: new Date(),
    scored: false,
    guess: null,
    guessCorrect: false,
    guessByParticipantId: null,
  };
  await activity.save();
  res.json(await hostRoundDto(activity));
}));

// POST /:id/imposture/round/voting — open voting (clues → voting).
router.post('/:id/imposture/round/voting', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  ensureImposture(activity);
  if (!activity.impostureRound) throw new RuleViolation('Start a round first.');
  if (activity.impostureRound.phase === PHASE.REVEALED) {
    throw new RuleViolation('This round is already revealed.', 409);
  }
  activity.impostureRound.phase = PHASE.VOTING;
  await activity.save();
  res.json(await hostRoundDto(activity));
}));

// POST /:id/imposture/round/reveal — close voting, tally, write the round's scores.
router.post('/:id/imposture/round/reveal', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  ensureImposture(activity);
  const round = activity.impostureRound;
  if (!round) throw new RuleViolation('Start a round first.');
  if (round.phase === PHASE.REVEALED && round.scored) {
    return res.json(await hostRoundDto(activity)); // idempotent
  }
  if (round.phase !== PHASE.VOTING) {
    throw new RuleViolation('Open voting before revealing.', 409);
  }

  const t = await tallyRound(activity);
  const scheme = activity.impostureScoring ?? ImpostureScoring.Standard;
  const points = new Map();
  const add = (pid, n) => points.set(pid, (points.get(pid) || 0) + n);

  // Detectives (non-impostors) who voted for a real impostor — every scheme.
  for (const [voter, voted] of t.voterMap.entries()) {
    if (!t.impostorSet.has(voter) && t.impostorSet.has(voted)) add(voter, DETECTIVE_POINTS);
  }
  // Impostors who survived — Standard / StandardPlusGuess only.
  if (scheme === ImpostureScoring.Standard || scheme === ImpostureScoring.StandardPlusGuess) {
    for (const iid of t.impostorSet) {
      if (!t.caughtByImpostor.get(iid)) add(iid, IMPOSTOR_SURVIVE);
    }
  }

  // Idempotent: replace this round's score rows.
  await ScoreEntry.deleteMany({ activityId: activity._id, round: round.order });
  const docs = [];
  for (const [pid, pts] of points.entries()) {
    if (pts > 0) {
      docs.push({
        activityId: activity._id, participantId: pid, round: round.order, points: pts, note: 'imposture', recordedUtc: new Date(),
      });
    }
  }
  if (docs.length) await ScoreEntry.insertMany(docs);

  round.phase = PHASE.REVEALED;
  round.scored = true;
  await activity.save();
  await pushScoreboard(activity._id);
  res.json(await hostRoundDto(activity));
}));

// ── Player: role, vote, word-guess ────────────────────────────────────────────

// GET /:id/imposture/me — the caller's role for the current round (role-appropriate).
router.get('/:id/imposture/me', asyncHandler(async (req, res) => {
  const participant = await resolveParticipantForActivity(req, req.params.id);
  const activity = await Activity.findById(req.params.id).lean();
  if (!activity) throw new RuleViolation('Activity not found.', 404);
  const round = activity.impostureRound;
  if (!round) return res.json({ round: 0, phase: null });

  const meId = idStr(participant);
  const isImpostor = (round.impostorIds || []).map(String).includes(meId);
  const out = {
    round: round.order,
    phase: round.phase,
    isImpostor,
    // Non-impostors always see the category; the impostor only if the host allows it.
    category: (isImpostor ? (activity.revealCategoryToImpostor ? round.category : null) : round.category) ?? null,
    word: null,
  };

  if (round.phase < PHASE.REVEALED) {
    out.word = isImpostor ? null : round.word;
    if (round.phase === PHASE.VOTING) {
      const others = await Participant.find({ activityId: activity._id, _id: { $ne: participant._id } })
        .select('_id displayName').lean();
      out.candidates = others.map((p) => ({ id: idStr(p), displayName: p.displayName }));
      const mine = await ImpostureVote.findOne({
        activityId: activity._id, round: round.order, voterParticipantId: participant._id,
      }).lean();
      out.myVote = mine ? idStr(mine.votedParticipantId) : null;
    }
  } else {
    out.word = round.word;
    const t = await tallyRound(activity);
    out.impostors = t.participants.filter((p) => t.impostorSet.has(idStr(p))).map((p) => p.displayName);
    out.caught = [...t.impostorSet].some((iid) => t.caughtByImpostor.get(iid));
    out.myVote = t.voterMap.get(meId) || null;
    out.myVoteCorrect = out.myVote ? t.impostorSet.has(out.myVote) : false;
    const myScore = await ScoreEntry.aggregate([
      { $match: { activityId: activity._id, round: round.order, participantId: participant._id } },
      { $group: { _id: null, pts: { $sum: '$points' } } },
    ]);
    out.myRoundPoints = myScore.length ? myScore[0].pts : 0;
    out.canGuess = isImpostor
      && activity.impostureScoring === ImpostureScoring.StandardPlusGuess
      && t.caughtByImpostor.get(meId) === true
      && !round.guess;
    out.guess = round.guess || null;
    out.guessCorrect = !!round.guessCorrect;
  }
  res.json(out);
}));

// POST /:id/imposture/vote — { votedParticipantId }. Upsert this round's vote.
router.post('/:id/imposture/vote', asyncHandler(async (req, res) => {
  const participant = await resolveParticipantForActivity(req, req.params.id);
  const activity = await Activity.findById(req.params.id);
  if (!activity) throw new RuleViolation('Activity not found.', 404);
  const round = activity.impostureRound;
  if (!round || round.phase !== PHASE.VOTING) throw new RuleViolation('Voting is not open.', 409);

  const votedId = (req.body || {}).votedParticipantId;
  if (!votedId || !mongoose.isValidObjectId(votedId)) throw new RuleViolation('Pick someone to vote for.');
  if (String(votedId) === idStr(participant)) throw new RuleViolation("You can't vote for yourself.");
  const voted = await Participant.findOne({ _id: votedId, activityId: activity._id }).select('_id').lean();
  if (!voted) throw new RuleViolation('That player is not in this game.');

  await ImpostureVote.findOneAndUpdate(
    { activityId: activity._id, round: round.order, voterParticipantId: participant._id },
    { $set: { votedParticipantId: voted._id, createdUtc: new Date() } },
    { upsert: true },
  );
  res.json({ ok: true, votedParticipantId: idStr(voted) });
}));

// POST /:id/imposture/round/guess — { guess }. A caught impostor's one word guess.
router.post('/:id/imposture/round/guess', asyncHandler(async (req, res) => {
  const participant = await resolveParticipantForActivity(req, req.params.id);
  const activity = await Activity.findById(req.params.id);
  if (!activity) throw new RuleViolation('Activity not found.', 404);
  const round = activity.impostureRound;
  if (!round || round.phase !== PHASE.REVEALED) throw new RuleViolation('Nothing to guess yet.', 409);
  if (activity.impostureScoring !== ImpostureScoring.StandardPlusGuess) {
    throw new RuleViolation('Word guessing is off for this game.', 409);
  }
  const meId = idStr(participant);
  if (!(round.impostorIds || []).map(String).includes(meId)) {
    throw new RuleViolation('Only the impostor can guess the word.', 403);
  }
  if (round.guess) throw new RuleViolation('You already guessed.', 409);

  const t = await tallyRound(activity);
  if (!t.caughtByImpostor.get(meId)) throw new RuleViolation('You only get to guess if you were caught.', 409);

  const guess = ((req.body || {}).guess || '').trim();
  if (!guess) throw new RuleViolation('Type your guess.');
  const correct = norm(guess) === norm(round.word);
  round.guess = guess.slice(0, 80);
  round.guessCorrect = correct;
  round.guessByParticipantId = participant._id;
  if (correct) {
    await ScoreEntry.create({
      activityId: activity._id, participantId: participant._id, round: round.order, points: GUESS_BONUS, note: 'imposture-guess', recordedUtc: new Date(),
    });
  }
  await activity.save();
  if (correct) await pushScoreboard(activity._id);
  res.json({ correct });
}));

module.exports = router;
