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
  deck: { type: [String], default: [] },
  teams: { type: [teamSchema], default: [] },
  roundsPlayed: { type: Number, default: 0 },
  finished: { type: Boolean, default: false },
  winnerId: { type: String, default: null },
});

module.exports = mongoose.model('HitsterGame', hitsterGameSchema);
