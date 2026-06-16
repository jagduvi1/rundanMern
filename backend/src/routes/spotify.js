// SpotifyEndpoints — PER-USER Spotify connections. Every logged-in host manages
// THEIR OWN Spotify app: they set their own Client ID and connect their own
// Premium account(s) for music-quiz auto-fill + the host browser's Web Playback
// SDK. There is NO global/shared key. A "connection" stores OAuth tokens that
// NEVER leave the server — only the safe SpotifyConnectionDto (no tokens) and a
// short-lived SpotifyTokenDto (the Web Playback access token) are ever returned.
//
// All routes mount under the shared base `/api/spotify` (see app.js); only this
// router's sub-paths are defined here. Every route is `requireAuth` and scoped to
// the caller's own account (`req.user.id`) — a host can only see/touch their own
// Client ID and connections.
const express = require('express');

const { asyncHandler } = require('../middleware/error');
const { requireAuth } = require('../middleware/auth');
const spotify = require('../services/spotify');

const router = express.Router();

// ── Client ID (per-account; the host's own Spotify app) ───────────────────────

// GET /api/spotify/client-id — { clientId } (the caller's own, or "").
router.get('/client-id', requireAuth, asyncHandler(async (req, res) => {
  res.json({ clientId: (await spotify.getClientId(req.user.id)) || '' });
}));

// PUT /api/spotify/client-id — { clientId } → { clientId }. Blank clears it.
router.put('/client-id', requireAuth, asyncHandler(async (req, res) => {
  const clientId = await spotify.setClientId(req.user.id, (req.body || {}).clientId);
  res.json({ clientId });
}));

// ── OAuth: exchange the browser's PKCE code, save the host's own connection ────

// POST /api/spotify/connect — SpotifyConnectRequest { code, codeVerifier,
// redirectUri } → SpotifyConnectionDto (no tokens). Owned by the caller.
router.post('/connect', requireAuth, asyncHandler(async (req, res) => {
  const r = req.body || {};
  res.json(await spotify.exchangeCode({
    accountId: req.user.id,
    code: r.code,
    codeVerifier: r.codeVerifier,
    redirectUri: r.redirectUri,
  }));
}));

// ── List / validate / delete connections (all scoped to the caller) ────────────

// GET /api/spotify/connections — the caller's SpotifyConnectionDto[] (by name).
router.get('/connections', requireAuth, asyncHandler(async (req, res) => {
  res.json(await spotify.listConnections(req.user.id));
}));

// POST /api/spotify/connections/:id/validate — refresh + /me, report the outcome.
// Always 200 — the result lives in the body (SpotifyValidateResultDto), not the status.
router.post('/connections/:id/validate', requireAuth, asyncHandler(async (req, res) => {
  res.json(await spotify.validate(req.params.id, req.user.id));
}));

// DELETE /api/spotify/connections/:id — delete + null out referencing activities. 204.
router.delete('/connections/:id', requireAuth, asyncHandler(async (req, res) => {
  await spotify.deleteConnection(req.params.id, req.user.id);
  res.status(204).end();
}));

// ── Playback token (short-lived; host browser Web Playback SDK only) ───────────

// GET /api/spotify/connections/:id/token — SpotifyTokenDto { accessToken }.
// 404 if the connection is gone (or not the caller's). This is the ONLY route
// that surfaces a token, and it mints a fresh short-lived access token (the
// refresh token never leaves the server). Scoped to the caller's own connection.
router.get('/connections/:id/token', requireAuth, asyncHandler(async (req, res) => {
  const dto = await spotify.getPlaybackToken(req.params.id, req.user.id);
  if (!dto) return res.status(404).json({ error: 'Connection not found.' });
  res.json(dto);
}));

module.exports = router;
