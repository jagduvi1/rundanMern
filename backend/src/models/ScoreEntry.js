const mongoose = require('mongoose');

// One recorded score line for a round-based game (boule, generic score game,
// map-pin). A participant's total = sum of their entries. `points` is a double
// (points, seconds, or millimetres for measured games). On User delete, set
// userId = null (do NOT delete the entry); on Activity/Participant delete, remove.
const scoreEntrySchema = new mongoose.Schema({
  activityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', required: true },
  participantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Participant', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  round: { type: Number, default: 1 },
  points: { type: Number, default: 0 },
  note: { type: String, maxlength: 200, default: null },
  recordedUtc: { type: Date, default: Date.now },
});

scoreEntrySchema.index({ activityId: 1, participantId: 1 });

module.exports = mongoose.model('ScoreEntry', scoreEntrySchema);
