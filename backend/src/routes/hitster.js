const express = require('express');

const { Activity, Question, Participant, HitsterGame, ScoreEntry } = require('../models');
const { ActivityType, ActivityStatus } = require('../constants/enums');
const { idStr } = require('../services/serializers');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { activityManager } = require('../middleware/eventAuth');
const { resolveParticipantForActivity } = require('../middleware/participant');
const { pushScoreboard } = require('../services/scoreboard');
const { fuzzyMatches } = require('../services/scoring');
const emit = require('../socket/emit');

const router = express.Router();

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildStateDto(game, forParticipantId) {
  const currentTeam = game.teams[game.currentTurnIndex] || null;
  const isMyTurn = forParticipantId && currentTeam
    && String(currentTeam.participantId) === String(forParticipantId);

  return {
    activityId: String(game.activityId),
    currentTurnIndex: game.currentTurnIndex,
    currentTeamId: currentTeam ? currentTeam.participantId : null,
    currentTeamName: currentTeam ? currentTeam.displayName : null,
    isMyTurn,
    currentCard: game.currentCard?.questionId ? {
      questionId: game.currentCard.questionId,
      title: isMyTurn ? null : null,
      artist: isMyTurn ? null : null,
      year: null,
    } : null,
    hasCurrentCard: !!game.currentCard?.questionId,
    teams: game.teams.map((t) => ({
      participantId: t.participantId,
      displayName: t.displayName,
      cardCount: t.cards.length,
      bonusCount: t.bonusCount,
      totalBonus: t.totalBonus,
      cards: t.cards.map((c) => ({ year: c.year, title: c.title })),
    })),
    roundsPlayed: game.roundsPlayed,
    deckRemaining: game.deck.length,
    finished: game.finished,
    winnerId: game.winnerId,
  };
}

// POST /api/activities/:id/hitster/start — host initializes the game
router.post('/:id/hitster/start', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  if (activity.type !== ActivityType.MusicQuiz || !activity.hitsterMode) {
    throw new RuleViolation('This activity is not a Hitster game.');
  }
  if (activity.status !== ActivityStatus.Live) {
    throw new RuleViolation('The activity must be live to start a Hitster game.', 409);
  }

  let game = await HitsterGame.findOne({ activityId: activity._id });
  if (game && !game.finished) {
    throw new RuleViolation('A Hitster game is already in progress.', 409);
  }

  const questions = await Question.find({
    activityId: activity._id,
    releaseYear: { $ne: null },
  }).select('_id releaseYear acceptedFreeTextAnswer acceptedArtist').lean();

  if (questions.length < 3) {
    throw new RuleViolation('Need at least 3 tracks with release years to play Hitster.');
  }

  const participants = await Participant.find({ activityId: activity._id }).lean();
  if (participants.length < 1) {
    throw new RuleViolation('At least one team must have joined.');
  }

  const questionMap = new Map(questions.map((q) => [idStr(q), q]));
  const deck = shuffle(questions.map((q) => idStr(q)));

  const teams = shuffle(participants.map((p) => ({
    participantId: idStr(p),
    displayName: p.displayName || p.name || 'Team',
    cards: [],
    bonusCount: 0,
    totalBonus: 0,
  })));

  // Deal one starting card to each team
  for (const team of teams) {
    if (deck.length === 0) break;
    const cardId = deck.shift();
    const q = questionMap.get(cardId);
    team.cards.push({
      questionId: cardId,
      year: q.releaseYear,
      title: q.acceptedFreeTextAnswer || '',
    });
  }

  if (game) {
    game.turnOrder = teams.map((t) => t.participantId);
    game.currentTurnIndex = 0;
    game.currentCard = { questionId: null, year: null, title: null, artist: null };
    game.deck = deck;
    game.teams = teams;
    game.roundsPlayed = 0;
    game.finished = false;
    game.winnerId = null;
    await game.save();
  } else {
    game = await HitsterGame.create({
      activityId: activity._id,
      turnOrder: teams.map((t) => t.participantId),
      currentTurnIndex: 0,
      currentCard: { questionId: null, year: null, title: null, artist: null },
      deck,
      teams,
      roundsPlayed: 0,
      finished: false,
      winnerId: null,
    });
  }

  const dto = buildStateDto(game, null);
  emit.hitsterStateChanged(idStr(activity), dto);
  res.json(dto);
}));

// GET /api/activities/:id/hitster — get current game state
router.get('/:id/hitster', asyncHandler(async (req, res) => {
  const { id } = req.params;
  let participantId = null;
  try {
    const p = await resolveParticipantForActivity(req, id);
    participantId = idStr(p);
  } catch { /* viewer or host without participant token */ }

  const game = await HitsterGame.findOne({ activityId: id });
  if (!game) {
    return res.json({ started: false });
  }

  const dto = buildStateDto(game, participantId);
  dto.started = true;
  res.json(dto);
}));

// POST /api/activities/:id/hitster/draw — host draws the next card
router.post('/:id/hitster/draw', activityManager, asyncHandler(async (req, res) => {
  const activity = req.targetActivity;
  const game = await HitsterGame.findOne({ activityId: activity._id });
  if (!game || game.finished) {
    throw new RuleViolation('No active Hitster game.');
  }
  if (game.currentCard?.questionId) {
    throw new RuleViolation('A card is already drawn — place it first.', 409);
  }
  if (game.deck.length === 0) {
    throw new RuleViolation('The deck is empty.');
  }

  const cardId = game.deck.shift();
  const question = await Question.findById(cardId)
    .select('releaseYear acceptedFreeTextAnswer acceptedArtist').lean();

  game.currentCard = {
    questionId: cardId,
    year: question.releaseYear,
    title: question.acceptedFreeTextAnswer || '',
    artist: question.acceptedArtist || '',
  };
  await game.save();

  const dto = buildStateDto(game, null);
  emit.hitsterStateChanged(idStr(activity), dto);
  res.json(dto);
}));

// POST /api/activities/:id/hitster/bonus — team guesses title/artist
router.post('/:id/hitster/bonus', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const participant = await resolveParticipantForActivity(req, id);
  const participantId = idStr(participant);

  const game = await HitsterGame.findOne({ activityId: id });
  if (!game || game.finished) {
    throw new RuleViolation('No active Hitster game.');
  }
  if (!game.currentCard?.questionId) {
    throw new RuleViolation('No card is drawn yet.');
  }

  const currentTeam = game.teams[game.currentTurnIndex];
  if (!currentTeam || String(currentTeam.participantId) !== participantId) {
    throw new RuleViolation('It is not your turn.');
  }

  const { title, artist } = req.body || {};
  const titleOk = title ? fuzzyMatches(title, game.currentCard.title) : false;
  const artistOk = artist ? fuzzyMatches(artist, game.currentCard.artist) : false;
  const bonusEarned = (titleOk ? 1 : 0) + (artistOk ? 1 : 0);

  currentTeam.bonusCount += bonusEarned;
  currentTeam.totalBonus += bonusEarned;

  // Convert 3 bonus points into an extra timeline card
  let bonusCardAdded = false;
  if (currentTeam.bonusCount >= 3 && game.deck.length > 0) {
    currentTeam.bonusCount -= 3;
    const bonusCardId = game.deck.shift();
    const q = await Question.findById(bonusCardId)
      .select('releaseYear acceptedFreeTextAnswer').lean();
    if (q) {
      const bonusCard = {
        questionId: bonusCardId,
        year: q.releaseYear,
        title: q.acceptedFreeTextAnswer || '',
      };
      currentTeam.cards.push(bonusCard);
      currentTeam.cards.sort((a, b) => a.year - b.year);
      bonusCardAdded = true;
    }
  }

  await game.save();

  const cardsToWin = (await Activity.findById(id).select('hitsterCardsToWin').lean())?.hitsterCardsToWin || 10;
  if (currentTeam.cards.length >= cardsToWin) {
    await finishGame(game, currentTeam, id);
  }

  const dto = buildStateDto(game, participantId);
  emit.hitsterStateChanged(id, dto);

  res.json({
    ...dto,
    bonusResult: {
      titleGuess: title || null,
      artistGuess: artist || null,
      titleCorrect: titleOk,
      artistCorrect: artistOk,
      bonusEarned,
      bonusCardAdded,
      correctTitle: game.currentCard.title,
      correctArtist: game.currentCard.artist,
    },
  });
}));

// POST /api/activities/:id/hitster/place — team places card in timeline
router.post('/:id/hitster/place', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const participant = await resolveParticipantForActivity(req, id);
  const participantId = idStr(participant);

  const game = await HitsterGame.findOne({ activityId: id });
  if (!game || game.finished) {
    throw new RuleViolation('No active Hitster game.');
  }
  if (!game.currentCard?.questionId) {
    throw new RuleViolation('No card is drawn yet.');
  }

  const currentTeam = game.teams[game.currentTurnIndex];
  if (!currentTeam || String(currentTeam.participantId) !== participantId) {
    throw new RuleViolation('It is not your turn.');
  }

  const { position } = req.body || {};
  const pos = Number(position);
  if (!Number.isFinite(pos) || pos < 0 || pos > currentTeam.cards.length) {
    throw new RuleViolation('Invalid position.');
  }

  const cardYear = game.currentCard.year;
  const timeline = currentTeam.cards;

  // Validate placement: card year must fit between neighbors
  const leftYear = pos > 0 ? timeline[pos - 1].year : -Infinity;
  const rightYear = pos < timeline.length ? timeline[pos].year : Infinity;
  const correct = cardYear >= leftYear && cardYear <= rightYear;

  const placedCard = {
    questionId: game.currentCard.questionId,
    year: cardYear,
    title: game.currentCard.title,
  };

  if (correct) {
    timeline.splice(pos, 0, placedCard);
  }

  const revealedCard = {
    year: cardYear,
    title: game.currentCard.title,
    artist: game.currentCard.artist,
  };

  // Clear current card and advance turn
  game.currentCard = { questionId: null, year: null, title: null, artist: null };
  game.currentTurnIndex = (game.currentTurnIndex + 1) % game.teams.length;
  game.roundsPlayed += 1;

  const activity = await Activity.findById(id).select('hitsterCardsToWin').lean();
  const cardsToWin = activity?.hitsterCardsToWin || 10;

  // Check win condition
  if (correct && currentTeam.cards.length >= cardsToWin) {
    await finishGame(game, currentTeam, id);
  } else if (game.deck.length === 0) {
    // Deck empty — find who has the most cards
    const best = game.teams.reduce((a, b) => a.cards.length >= b.cards.length ? a : b);
    await finishGame(game, best, id);
  } else {
    await game.save();
  }

  const dto = buildStateDto(game, participantId);
  emit.hitsterStateChanged(id, dto);

  res.json({
    ...dto,
    placeResult: {
      correct,
      revealedCard,
      position: pos,
    },
  });
}));

async function finishGame(game, winningTeam, activityId) {
  game.finished = true;
  game.winnerId = winningTeam.participantId;
  await game.save();

  // Record ScoreEntries for standings (timeline length as score)
  for (const team of game.teams) {
    await ScoreEntry.deleteMany({
      activityId,
      participantId: team.participantId,
    });
    await ScoreEntry.create({
      activityId,
      participantId: team.participantId,
      round: 1,
      points: team.cards.length,
      recordedUtc: new Date(),
    });
  }

  // Auto-finish the activity
  const activity = await Activity.findById(activityId);
  if (activity && activity.status === ActivityStatus.Live) {
    activity.status = ActivityStatus.Finished;
    activity.finishedUtc = new Date();
    await activity.save();
    emit.activityStatusChanged(activityId, {
      activityId: String(activityId),
      status: activity.status,
    });
  }

  await pushScoreboard(activityId);
}

module.exports = router;
