const mongoose = require('mongoose');

// A saved Spotify OAuth login (Premium) to auto-fill music-quiz tracks with
// exact title/artist/year. Tokens are SERVER-ONLY: refreshToken/accessToken use
// select:false so they never leave the API by accident; serializers also strip
// them. Referenced loosely by Activity.spotifyConnectionId (no cascade).
const spotifyConnectionSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 120 }, // defaults to Spotify display name
  spotifyUserId: { type: String, maxlength: 120, default: '' }, // account id, for dedupe
  refreshToken: { type: String, required: true, maxlength: 500, select: false },
  accessToken: { type: String, maxlength: 2000, default: '', select: false },
  expiresUtc: { type: Date, default: Date.now },
  createdUtc: { type: Date, default: Date.now },
  lastStatus: { type: String, maxlength: 300, default: null }, // "valid" / error text
});

module.exports = mongoose.model('SpotifyConnection', spotifyConnectionSchema);
