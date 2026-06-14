const mongoose = require('mongoose');

// Roster user — a pre-registered named person (rundan's `User` entity). NOT an
// auth account (see Account.js). Selected into events (EventMember), grouped
// into teams (Participant.members), and referenced by ScoreEntry/Slap for
// per-player attribution. Just a unique name + creation time.
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60, unique: true },
  createdUtc: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
