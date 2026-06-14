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

module.exports = mongoose.model('EventViewer', eventViewerSchema);
