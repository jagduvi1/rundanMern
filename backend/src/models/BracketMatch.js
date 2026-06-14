const mongoose = require('mongoose');
const { BracketSide, values } = require('../constants/enums');

// One match in a knockout bracket (or round-robin group match) for a Boule
// activity. Participant ids are LOOSE refs (no FK) — handle deleted
// participants. courtId points at an embedded Court subdoc _id on the activity.
const bracketMatchSchema = new mongoose.Schema({
  activityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', required: true, index: true },
  // 0 = Playoff A / single knockout, 1 = Playoff B / plate.
  pool: { type: Number, default: 0 },
  // 0-based group index for round-robin; null for knockout.
  groupIndex: { type: Number, default: null },
  side: { type: Number, enum: values(BracketSide), default: BracketSide.Winners },
  round: { type: Number, default: 1 },
  slot: { type: Number, default: 0 },
  participantAId: { type: mongoose.Schema.Types.ObjectId, default: null },
  participantBId: { type: mongoose.Schema.Types.ObjectId, default: null },
  winnerParticipantId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // e.g. "13-7,9-13,13-10"; single "3-1" for free format; null for byes/sim.
  setScores: { type: String, default: null },
  isBye: { type: Boolean, default: false },
  // References an embedded court subdoc _id on the parent activity.
  courtId: { type: mongoose.Schema.Types.ObjectId, default: null },
});

bracketMatchSchema.index({ activityId: 1, side: 1, round: 1, slot: 1 });

module.exports = mongoose.model('BracketMatch', bracketMatchSchema);
