const mongoose = require('mongoose');

// A photo a player uploaded during an activity, shown on its shared photo wall.
// `url` points at an uploaded file served from /uploads.
const activityPhotoSchema = new mongoose.Schema({
  activityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', required: true },
  author: { type: String, required: true, maxlength: 60 },
  url: { type: String, required: true, maxlength: 500 },
  createdUtc: { type: Date, default: Date.now },
});

activityPhotoSchema.index({ activityId: 1, _id: 1 });

module.exports = mongoose.model('ActivityPhoto', activityPhotoSchema);
