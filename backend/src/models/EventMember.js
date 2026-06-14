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
  addedUtc: { type: Date, default: Date.now },
});

// A user is in an event at most once.
eventMemberSchema.index({ eventId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('EventMember', eventMemberSchema);
