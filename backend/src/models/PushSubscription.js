const mongoose = require('mongoose');

// A browser Web Push subscription for one device, scoped to the event it
// subscribed under. Delivered via the `web-push` npm package.
const pushSubscriptionSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  endpoint: { type: String, required: true, maxlength: 800, unique: true },
  p256dh: { type: String, required: true, maxlength: 200 }, // client public key (base64url)
  auth: { type: String, required: true, maxlength: 100 }, // client auth secret (base64url)
  createdUtc: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
