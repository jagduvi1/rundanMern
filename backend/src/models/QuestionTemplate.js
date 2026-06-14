const mongoose = require('mongoose');
const { QuestionKind, values } = require('../constants/enums');

// A reusable library question (seeded at runtime from question-library.json).
// The host pulls random ones (filtered by tag) into a quiz/tipspromenad. Options
// and tags are embedded; tags are normalised lowercase for $in filtering.
const templateOptionSchema = new mongoose.Schema(
  {
    order: { type: Number, default: 0 },
    text: { type: String, required: true, maxlength: 300 },
    isCorrect: { type: Boolean, default: false },
  },
  { _id: false }
);

const questionTemplateSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 1000 },
  kind: { type: Number, enum: values(QuestionKind), default: QuestionKind.MultipleChoice },
  points: { type: Number, default: 1 },
  acceptedFreeTextAnswer: { type: String, maxlength: 200, default: null },
  options: { type: [templateOptionSchema], default: [] },
  tags: { type: [String], default: [], index: true }, // lowercase, multikey index
});

module.exports = mongoose.model('QuestionTemplate', questionTemplateSchema);
