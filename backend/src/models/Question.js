const mongoose = require('mongoose');
const { QuestionKind, values } = require('../constants/enums');

// A selectable option for multiple-choice / true-false. Embedded in Question but
// KEEP its _id — Answer.selectedOptionId references this subdoc's _id across
// collections. `isCorrect` is an answer key: strip from player payloads while
// the activity is live (serializer layer handles this).
const answerOptionSchema = new mongoose.Schema({
  order: { type: Number, default: 0 },
  text: { type: String, required: true, maxlength: 300 },
  isCorrect: { type: Boolean, default: false },
});

// A question in a Quiz / Tipspromenad / MusicQuiz. Geo fields drive Tipspromenad;
// music fields drive MusicQuiz (acceptedFreeTextAnswer doubles as the correct
// SONG title; spotifyUrl/acceptedArtist are host-only answer keys).
const questionSchema = new mongoose.Schema({
  activityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', required: true, index: true },
  order: { type: Number, default: 0 },
  text: { type: String, required: true, maxlength: 1000 },
  kind: { type: Number, enum: values(QuestionKind), default: QuestionKind.MultipleChoice },
  points: { type: Number, default: 1 },
  imageUrl: { type: String, maxlength: 500, default: null },

  // Tipspromenad geofence
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  radiusMeters: { type: Number, default: null },

  // Free-text / music answer keys (server-only — strip for players)
  acceptedFreeTextAnswer: { type: String, maxlength: 200, default: null },
  spotifyUrl: { type: String, maxlength: 500, default: null },
  acceptedArtist: { type: String, maxlength: 200, default: null },
  releaseYear: { type: Number, default: null },
  playStartedUtc: { type: Date, default: null },

  options: { type: [answerOptionSchema], default: [] },
});

questionSchema.index({ activityId: 1, order: 1 });

module.exports = mongoose.model('Question', questionSchema);
