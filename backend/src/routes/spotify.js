// SpotifyEndpoints — the MERN port of Rundan.Server/Endpoints/SpotifyEndpoints.cs.
// Site-level Spotify connections (logged-in Premium accounts) for music-quiz
// auto-fill + the host browser's Web Playback SDK. A "connection" stores OAuth
// tokens that NEVER leave the server — only the safe SpotifyConnectionDto (no
// tokens) and a short-lived SpotifyTokenDto (the Web Playback access token) are
// ever returned, and the latter only to an authorized host.
//
// All routes mount under the shared base `/api/spotify` (see app.js); only this
// router's sub-paths are defined here.
//
// Auth model note: rundan gated these with the site admin code (AdminEndpointFilter).
// This port has no separate admin code — it uses host accounts (JWT). The doc's
// intent is "site host", so every route requires a logged-in host whose context
// can manage at the site level (`requireAuth` + `canManageEvent(req, null)`),
// which on an open/dev server admits any host and on a locked deployment narrows
// to privileged accounts — the same shape `activities.js` uses for standalone
// management.
const express = require('express');

const { RuleViolation, asyncHandler } = require('../middleware/error');
const { requireAuth } = require('../middleware/auth');
const { canManageEvent } = require('../middleware/eventAuth');
const spotify = require('../services/spotify');

const router = express.Router();

// Host-level gate (site host intent). `canManageEvent(req, null)` is the port's
// "no event context" branch: a logged-in host, or open on a non-prod server.
const requireHost = asyncHandler(async (req, res, next) => {
  if (!(await canManageEvent(req, null))) {
    return res.status(403).json({ error: 'Only the host or an event admin can do this.' });
  }
  next();
});

// ── Client ID (UI-saved override of the env config) ───────────────────────────

// PUT /api/spotify/client-id — SetSpotifyClientIdRequest { clientId } → 204.
// Blank clears the AppSetting (falls back to env); else upserts it.
router.put('/client-id', requireAuth, requireHost, asyncHandler(async (req, res) => {
  await spotify.setClientId((req.body || {}).clientId);
  res.status(204).end();
}));

// ── OAuth: exchange the browser's PKCE code, save a named connection ───────────

// POST /api/spotify/connect — SpotifyConnectRequest { code, codeVerifier,
// redirectUri } → SpotifyConnectionDto (no tokens).
router.post('/connect', requireAuth, requireHost, asyncHandler(async (req, res) => {
  const r = req.body || {};
  res.json(await spotify.exchangeCode({
    code: r.code,
    codeVerifier: r.codeVerifier,
    redirectUri: r.redirectUri,
  }));
}));

// ── List / validate / delete connections ──────────────────────────────────────

// GET /api/spotify/connections — SpotifyConnectionDto[] (ordered by name).
router.get('/connections', requireAuth, requireHost, asyncHandler(async (req, res) => {
  res.json(await spotify.listConnections());
}));

// POST /api/spotify/connections/:id/validate — refresh + /me, report the outcome.
// Always 200 — the result lives in the body (SpotifyValidateResultDto), not the status.
router.post('/connections/:id/validate', requireAuth, requireHost, asyncHandler(async (req, res) => {
  res.json(await spotify.validate(req.params.id));
}));

// DELETE /api/spotify/connections/:id — delete + null out referencing activities. 204.
router.delete('/connections/:id', requireAuth, requireHost, asyncHandler(async (req, res) => {
  await spotify.deleteConnection(req.params.id);
  res.status(204).end();
}));

// ── Playback token (short-lived; host browser Web Playback SDK only) ───────────

// GET /api/spotify/connections/:id/token — SpotifyTokenDto { accessToken }.
// 404 if the connection is gone. This is the ONLY route that surfaces a token,
// and it mints a fresh short-lived access token (the refresh token never leaves
// the server). Host-gated.
router.get('/connections/:id/token', requireAuth, requireHost, asyncHandler(async (req, res) => {
  const dto = await spotify.getPlaybackToken(req.params.id);
  if (!dto) return res.status(404).json({ error: 'Connection not found.' });
  res.json(dto);
}));

module.exports = router;
