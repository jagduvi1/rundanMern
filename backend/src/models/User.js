const mongoose = require('mongoose');

// Roster user — a pre-registered named person (rundan's `User` entity). NOT an
// auth account (see Account.js). Selected into events (EventMember), grouped
// into teams (Participant.members), and referenced by ScoreEntry/Slap for
// per-player attribution.
//
// `owner` scopes the roster to the account that created it: each host sees only
// their own people. Names are unique PER OWNER (two accounts can each have a
// "Calle"), enforced by a partial unique index (legacy/unowned rows are exempt).
// A startup migration (services/migrations.js) backfills `owner` and drops the
// old global-unique name index.
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  owner: {
    type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null, index: true,
  },
  createdUtc: { type: Date, default: Date.now },
});

userSchema.index(
  { owner: 1, name: 1 },
  { unique: true, partialFilterExpression: { owner: { $type: 'objectId' } } },
);

module.exports = mongoose.model('User', userSchema);
