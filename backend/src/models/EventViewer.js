const mongoose = require('mongoose');
const crypto = require('crypto');

// A spectator of an event — sees everything, doesn't compete. Tracked so others
// see who's watching; stale viewers (lastSeenUtc older than ~15 min) drop off.
const eventViewerSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  name: { type: String, required: true, maxlength: 60 },
  token: { type: String, required: true, unique: true, default: () => crypto.randomUUID() },
  lastSeenUtc: { type: Date, default: Date.now },
});

// Stale viewers drop off ~15 min after their last heartbeat (matches the
// recently-seen window); the heartbeat refreshes lastSeenUtc and resets the TTL.
eventViewerSchema.index({ lastSeenUtc: 1 }, { expireAfterSeconds: 900 });

module.exports = mongoose.model('EventViewer', eventViewerSchema);
