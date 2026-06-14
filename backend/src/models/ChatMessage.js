const mongoose = require('mongoose');

// A message in an event's group chat, visible to everyone in the event.
// Ordered/paged by _id (ObjectId is timestamp-monotonic); createdUtc breaks ties.
const chatMessageSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  author: { type: String, required: true, maxlength: 60 }, // display name or "Host"
  text: { type: String, required: true, maxlength: 1000 },
  createdUtc: { type: Date, default: Date.now },
});

chatMessageSchema.index({ eventId: 1, _id: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
