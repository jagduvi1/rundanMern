const mongoose = require('mongoose');

// A participant's submission for one question (one row per participant per
// question). selectedOptionId is the embedded AnswerOption subdoc's _id.
// Cascade-delete with the parent question or participant (app code).
const answerSchema = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  participantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Participant', required: true },
  // References the chosen option subdoc _id inside the question (no populate).
  selectedOptionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  freeText: { type: String, maxlength: 500, default: null },
  artistText: { type: String, maxlength: 500, default: null },
  guessedYear: { type: Number, default: null },
  isCorrect: { type: Boolean, default: false },
  awardedPoints: { type: Number, default: 0 },
  submittedUtc: { type: Date, default: Date.now },
});

// One answer per participant per question.
answerSchema.index({ questionId: 1, participantId: 1 }, { unique: true });
// Standings/team-shuffle/simulation scan answers by participant; the unique
// compound above leads with questionId so it can't serve a participantId-only
// lookup. This single-field index turns those scans into index seeks.
answerSchema.index({ participantId: 1 });

module.exports = mongoose.model('Answer', answerSchema);
