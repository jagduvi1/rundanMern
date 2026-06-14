const mongoose = require('mongoose');

// A persisted key/value app setting editable from the UI, overriding env config
// (e.g. Spotify Client ID) without a restart. The only entity with a string
// primary key — we map the key directly to _id and disable the default ObjectId.
const appSettingSchema = new mongoose.Schema(
  {
    _id: { type: String, maxlength: 80 }, // the setting key
    value: { type: String, maxlength: 500, default: '' },
  },
  { _id: false }
);

module.exports = mongoose.model('AppSetting', appSettingSchema);
