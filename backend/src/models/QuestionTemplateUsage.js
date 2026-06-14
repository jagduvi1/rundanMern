const mongoose = require('mongoose');

// Marks a library question as already used by the host so it isn't picked again.
// Loose ref to the template (no populate guarantee); unique so a template is
// consumed at most once.
const questionTemplateUsageSchema = new mongoose.Schema({
  questionTemplateId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  usedUtc: { type: Date, default: Date.now },
});

module.exports = mongoose.model('QuestionTemplateUsage', questionTemplateUsageSchema);
