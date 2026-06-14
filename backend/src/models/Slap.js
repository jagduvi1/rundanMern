const mongoose = require('mongoose');

// One resolved slap per activity (at most one). Reduces the slapped player's
// event total by `penalty` (exactly half their lead over the next player); for a
// "send" slap those points go to recipientUserId. User ids are loose refs (no
// FK); the event cascade cleans up.
const slapSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  activityId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  slapperUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
  slappedUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
  recipientUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
  penalty: { type: Number, default: 0 },
  skipped: { type: Boolean, default: false },
  createdUtc: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Slap', slapSchema);
