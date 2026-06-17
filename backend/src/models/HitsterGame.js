const mongoose = require('mongoose');

const timelineCardSchema = new mongoose.Schema({
  questionId: { type: String, required: true },
  year: { type: Number, required: true },
  title: { type: String, default: '' },
}, { _id: false });

const teamSchema = new mongoose.Schema({
  participantId: { type: String, required: true },
  displayName: { type: String, default: '' },
  cards: { type: [timelineCardSchema], default: [] },
  bonusCount: { type: Number, default: 0 },
  totalBonus: { type: Number, default: 0 },
  // questionId of the card this team last made a bonus guess for — one bonus
  // attempt per drawn card (prevents replaying a correct guess for free points).
  bonusGuessedForCardId: { type: String, default: null },
}, { _id: false });

const hitsterGameSchema = new mongoose.Schema({
  activityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', required: true, unique: true },
  turnOrder: { type: [String], default: [] },
  currentTurnIndex: { type: Number, default: 0 },
  currentCard: {
    questionId: { type: String, default: null },
    year: { type: Number, default: null },
    title: { type: String, default: null },
    artist: { type: String, default: null },
  },
  // The most recently placed card — kept so every client can flip the face-down
  // card to reveal it (year/title + whether it was placed correctly). Cleared when
  // the next card is drawn.
  lastPlaced: {
    questionId: { type: String, default: null },
    teamId: { type: String, default: null },
    teamName: { type: String, default: null },
    year: { type: Number, default: null },
    title: { type: String, default: null },
    correct: { type: Boolean, default: null },
  },
  deck: { type: [String], default: [] },
  teams: { type: [teamSchema], default: [] },
  roundsPlayed: { type: Number, default: 0 },
  finished: { type: Boolean, default: false },
  winnerId: { type: String, default: null },
});

module.exports = mongoose.model('HitsterGame', hitsterGameSchema);
