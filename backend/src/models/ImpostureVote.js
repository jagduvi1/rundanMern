const mongoose = require('mongoose');

// One participant's vote for who the impostor is, in a single Imposture round.
// Keyed by (activityId, round, voter) so a re-vote upserts instead of duplicating.
// Votes are scored (and read for the tally) per round; a results reset clears them.
const impostureVoteSchema = new mongoose.Schema({
  activityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', required: true, index: true },
  round: { type: Number, required: true },
  voterParticipantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Participant', required: true },
  votedParticipantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Participant', required: true },
  createdUtc: { type: Date, default: Date.now },
});

impostureVoteSchema.index({ activityId: 1, round: 1, voterParticipantId: 1 }, { unique: true });

module.exports = mongoose.model('ImpostureVote', impostureVoteSchema);
