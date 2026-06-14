const express = require('express');
const env = require('../config/env');
const { AppSetting } = require('../models');
const { asyncHandler } = require('../middleware/error');

// Public, ungated — the port of rundan's GET /api/bootstrap. Lets the SPA decide
// whether to show the access-code screen and whether Spotify is available,
// BEFORE the access gate. Never leaks secrets (only booleans + the public
// Spotify client id).
const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const setting = await AppSetting.findById('SpotifyClientId').lean();
    const spotifyClientId = (setting && setting.value) || env.spotifyClientId || '';
    res.json({
      appName: env.appName,
      requiresAccessCode: env.requiresAccessCode,
      authMode: 'accounts', // hybrid: host accounts + anonymous players
      spotifyClientId,
      hasSpotify: !!spotifyClientId,
      hasWebPush: env.hasWebPush,
    });
  })
);

module.exports = router;
