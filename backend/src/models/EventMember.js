const mongoose = require('mongoose');
const crypto = require('crypto');

// A roster user selected into an event. `token` is the device secret that
// authenticates that user's device (sent as x-rundan-member) — preserves
// rundan's account-less co-host/identity model alongside the new JWT accounts.
// `isAdmin` lets a chosen participant manage the event without a site admin.
const eventMemberSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Optional PER-EVENT link to the logged-in Account that "is" this roster slot in
  // THIS event. Distinct from the global Account.userId (one identity everywhere):
  // accountId lets one login be a different roster person in different events, and is
  // the source of truth for that account's "my events" list. Nullable — guest /
  // device-only members and host-created slots have no account attached.
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
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
// An account is at most one roster member per event. Partial filter so the many
// account-less members (accountId: null) don't collide — only real ObjectId links
// are constrained unique (mirrors Account.userId_unique). This is what makes a
// returning logged-in player re-attach to their existing slot rather than duplicate.
eventMemberSchema.index(
  { eventId: 1, accountId: 1 },
  {
    name: 'eventId_accountId_unique',
    unique: true,
    partialFilterExpression: { accountId: { $type: 'objectId' } },
  },
);
// The "my events"/stats lookups query by accountId alone — single-field index.
eventMemberSchema.index(
  { accountId: 1 },
  { partialFilterExpression: { accountId: { $type: 'objectId' } } },
);

module.exports = mongoose.model('EventMember', eventMemberSchema);
