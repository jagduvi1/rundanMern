const express = require('express');
const env = require('../config/env');
const { asyncHandler } = require('../middleware/error');

// Public, ungated — the port of rundan's GET /api/bootstrap. Lets the SPA decide
// whether to show the access-code screen, BEFORE the access gate. Never leaks
// secrets (only booleans). NOTE: Spotify is now PER-USER (each host sets their
// own Client ID on their account), so it is NOT surfaced here — the SPA reads the
// logged-in host's own `spotifyClientId` from /api/auth/me instead.
const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({
      appName: env.appName,
      requiresAccessCode: env.requiresAccessCode,
      authMode: 'accounts', // hybrid: host accounts + anonymous players
      hasWebPush: env.hasWebPush,
    });
  })
);

module.exports = router;
