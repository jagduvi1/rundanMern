const mongoose = require('mongoose');

// Single-use tokens for host email flows (verify-email, reset-password,
// magic-link). Only the SHA-256 hash of the raw token is stored; a TTL index
// auto-purges expired rows. Mirrors Glosan. Optional — degrades gracefully when
// no email provider is configured.
const tokenSchema = new mongoose.Schema({
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, index: true },
  kind: {
    type: String,
    enum: ['verify-email', 'reset-password', 'magic-link'],
    required: true,
  },
  tokenHash: { type: String, required: true, unique: true, index: true },
  // Optional — an event invite magic-link carries the event so consuming it
  // drops the player straight into that event.
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', default: null },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

// MongoDB purges documents once expiresAt has passed.
tokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Token', tokenSchema);
