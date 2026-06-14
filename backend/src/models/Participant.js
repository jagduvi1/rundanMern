const mongoose = require('mongoose');
const crypto = require('crypto');

// Links a team participant to one of its member roster users (embedded). The
// (participantId, userId) uniqueness from rundan is enforced as unique userId
// within the members array (app code, since Mongo can't index across the array
// against the parent). Deleting a User must pull it from all members arrays.
const participantMemberSchema = new mongoose.Schema(
  { userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true } },
  { _id: false }
);

// A friend/team taking part in an activity. `token` is the per-device secret a
// player presents (x-rundan-participant) to prove identity — anonymous, no
// account. `isAdmin` true when the joining device also held host rights.
const participantSchema = new mongoose.Schema({
  activityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', required: true, index: true },
  displayName: { type: String, required: true, trim: true, maxlength: 60 },
  isTeam: { type: Boolean, default: false },
  members: { type: [participantMemberSchema], default: [] },
  token: { type: String, required: true, unique: true, default: () => crypto.randomUUID() },
  isAdmin: { type: Boolean, default: false },
  seed: { type: Number, default: null },
  joinedUtc: { type: Date, default: Date.now },
});

// A display name is unique within an activity.
participantSchema.index({ activityId: 1, displayName: 1 }, { unique: true });

module.exports = mongoose.model('Participant', participantSchema);
