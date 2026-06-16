const mongoose = require('mongoose');

// A pending event invitation — a *reference only*. No Account or roster User is
// created at invite time; the invited person registers (or logs in) themselves
// and the invite is connected to that account when they accept. Only the SHA-256
// hash of the raw token is stored; the raw token lives in the emailed link.
const inviteSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
  // Optional: the roster person this invite designates. When the host invites
  // someone to BE a specific roster identity ("invite Johan"), accepting binds the
  // account to THAT User — an explicit, intentional link instead of guessing by
  // name (which could merge two different real people who share a name).
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  name: { type: String, default: null },
  expiresAt: { type: Date, required: true },
  acceptedAt: { type: Date, default: null },
  acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
  createdAt: { type: Date, default: Date.now },
});

// At most one invite per (email, event) — re-inviting refreshes the row + token.
inviteSchema.index({ email: 1, eventId: 1 }, { unique: true });
// TTL: MongoDB purges invites once they expire (the membership, once accepted,
// persists independently via EventMember).
inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Invite', inviteSchema);
