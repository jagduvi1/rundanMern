const mongoose = require('mongoose');
const crypto = require('crypto');

// A roster user selected into an event. `token` is the device secret that
// authenticates that user's device (sent as x-rundan-member) — preserves
// rundan's account-less co-host/identity model alongside the new JWT accounts.
// `isAdmin` lets a chosen participant manage the event without a site admin.
const eventMemberSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  token: { type: String, required: true, unique: true, default: () => crypto.randomUUID() },
  isAdmin: { type: Boolean, default: false },
  // Optional claim PIN: when set, claiming THIS roster identity by code (i.e. not
  // via your own logged-in account) requires the PIN, so a guest can't tap an
  // admin's name and receive its co-host token. Admins are ALWAYS protected (a PIN
  // is auto-generated); the host may also set one on any other member. Visible only
  // to managers (DTO strips it for everyone else) + delivered via a per-member QR.
  claimPin: { type: String, default: null, maxlength: 16 },
  addedUtc: { type: Date, default: Date.now },
});

// A user is in an event at most once.
eventMemberSchema.index({ eventId: 1, userId: 1 }, { unique: true });
// The player-facing "/events/active" path, the "my events" list and cascade
// look up memberships by userId alone — the compound above leads with eventId
// so it can't serve those. This single-field index removes the scan.
eventMemberSchema.index({ userId: 1 });

module.exports = mongoose.model('EventMember', eventMemberSchema);
