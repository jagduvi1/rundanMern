// Spotify OAuth (PKCE) + token management — the MERN port of rundan's
// `SpotifyService.cs`.
//
// A host with Spotify Premium completes a browser OAuth login (Authorization Code
// + PKCE, NO client secret). The browser hands the server the code; the server
// exchanges it for tokens, stores them as a reusable named CONNECTION, and uses
// them to read exact track metadata, drive the Web Playback SDK (a short-lived
// access token handed to the browser), and bulk-import playlist tracks.
//
// SECURITY: refresh/access tokens are SERVER-ONLY. They live on the
// SpotifyConnection doc with `select:false` and are NEVER returned to clients —
// this module reads them explicitly with `.select('+refreshToken +accessToken')`
// and only ever surfaces a freshly-minted access token via getPlaybackToken
// (admin-gated by the route layer).

const { SpotifyConnection, AppSetting, Activity } = require('../models');
const { RuleViolation } = require('../middleware/error');
const { spotifyConnectionDto } = require('./serializers');
const musicLookup = require('./musicLookup');
const env = require('../config/env');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
// AppSetting key that overrides env.spotifyClientId (matches SpotifyService.ClientIdSettingKey).
const CLIENT_ID_SETTING_KEY = 'Spotify.ClientId';
const HTTP_TIMEOUT_MS = 6000; // matches the C# "music" named HttpClient (6 s)

const now = () => new Date();

// Truncate an error/body to a short single line (port of SpotifyService.Short).
function short(s) {
  if (!s || !s.trim()) return 'unknown error';
  const t = s.length > 200 ? s.slice(0, 200) : s;
  return t.trim();
}

// fetch with an AbortController timeout (Node 20 global fetch).
async function httpFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The effective Spotify app Client ID: the UI-saved AppSetting if present, else
 * the env config; trimmed; null when blank. Port of SpotifyService.ClientIdAsync.
 *
 * @returns {Promise<string|null>}
 */
async function effectiveClientId() {
  const row = await AppSetting.findById(CLIENT_ID_SETTING_KEY).lean();
  const fromDb = row && typeof row.value === 'string' ? row.value : '';
  const id = fromDb && fromDb.trim() ? fromDb : (env.spotifyClientId || '');
  return id && id.trim() ? id.trim() : null;
}

/**
 * Save (or clear, when blank) the Spotify Client ID set from the UI. Port of
 * SpotifyService.SetClientIdAsync — empty deletes the row, else upserts.
 *
 * @param {string} clientId
 * @returns {Promise<void>}
 */
async function setClientId(clientId) {
  const val = (clientId || '').trim();
  if (val.length === 0) {
    await AppSetting.deleteOne({ _id: CLIENT_ID_SETTING_KEY });
  } else {
    await AppSetting.updateOne(
      { _id: CLIENT_ID_SETTING_KEY },
      { $set: { value: val } },
      { upsert: true },
    );
  }
}

// POST the form-encoded token request; parse the token response. Throws a clear
// RuleViolation on non-2xx / missing access token. Port of SpotifyService.ExchangeAsync.
async function exchange(form) {
  const body = new URLSearchParams(form).toString();
  let resp;
  try {
    resp = await httpFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new RuleViolation('Spotify login timed out — please try again.', 502);
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new RuleViolation(`Spotify rejected the login (${resp.status}): ${short(text)}`);
  }

  let root;
  try {
    root = JSON.parse(text);
  } catch {
    throw new RuleViolation('Spotify returned an unreadable token response.');
  }

  const access = typeof root.access_token === 'string' ? root.access_token : null;
  if (!access) throw new RuleViolation("Spotify didn't return an access token.");

  const expires = Number.isInteger(root.expires_in) ? root.expires_in : 3600;
  const refresh = typeof root.refresh_token === 'string' ? root.refresh_token : null;
  return { accessToken: access, expiresIn: expires, refreshToken: refresh };
}

// GET /me → { id, displayName }. Throws on non-2xx. Port of SpotifyService.MeAsync.
async function me(accessToken) {
  let resp;
  try {
    resp = await httpFetch(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new RuleViolation('Spotify profile check timed out.', 502);
  }
  if (!resp.ok) {
    throw new RuleViolation(`Spotify profile check failed (${resp.status}).`);
  }
  const root = await resp.json();
  return {
    id: typeof root.id === 'string' ? root.id : null,
    displayName: typeof root.display_name === 'string' ? root.display_name : null,
  };
}

// Access-token freshness: if now < expiresUtc AND a token exists → keep it.
// Otherwise refresh via the refresh grant (rotating the refresh token if Spotify
// returns a new one) and persist. `conn` MUST have been loaded WITH the
// +refreshToken +accessToken selects. Port of SpotifyService.EnsureFreshAsync.
async function ensureFresh(conn) {
  if (conn.expiresUtc && now() < new Date(conn.expiresUtc) && conn.accessToken) {
    return;
  }

  const clientId = await effectiveClientId();
  if (!clientId) throw new RuleViolation("Spotify isn't set up yet (no Client ID).");

  const token = await exchange({
    grant_type: 'refresh_token',
    refresh_token: conn.refreshToken,
    client_id: clientId,
  });

  conn.accessToken = token.accessToken;
  conn.expiresUtc = new Date(now().getTime() + (token.expiresIn - 30) * 1000); // 30 s safety margin
  if (token.refreshToken) {
    conn.refreshToken = token.refreshToken; // Spotify may rotate it
  }
  await conn.save();
}

// Load a connection WITH its server-only tokens (or null).
function findWithTokens(connectionId) {
  return SpotifyConnection.findById(connectionId).select('+refreshToken +accessToken');
}

/**
 * Exchange the OAuth code (PKCE) for tokens and save a new connection named after
 * the account. Port of SpotifyService.ConnectAsync. Returns the client-safe
 * SpotifyConnectionDto (tokens stay server-side).
 *
 * @param {object} args
 * @param {string} args.code
 * @param {string} args.codeVerifier
 * @param {string} args.redirectUri  must match the authorize request exactly
 * @returns {Promise<object>} SpotifyConnectionDto
 */
async function exchangeCode({ code, codeVerifier, redirectUri }) {
  const clientId = await effectiveClientId();
  if (!clientId) throw new RuleViolation("Spotify isn't set up yet (no Client ID).");

  const token = await exchange({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  if (!token.refreshToken) {
    throw new RuleViolation("Spotify didn't return a refresh token — try connecting again.");
  }

  const { id, displayName } = await me(token.accessToken);

  const conn = await SpotifyConnection.create({
    name: displayName && displayName.trim() ? displayName : 'Spotify account',
    spotifyUserId: id || '',
    refreshToken: token.refreshToken,
    accessToken: token.accessToken,
    expiresUtc: new Date(now().getTime() + (token.expiresIn - 30) * 1000),
    createdUtc: now(),
    lastStatus: 'valid',
  });

  return spotifyConnectionDto(conn);
}

/**
 * List saved connections (client-safe DTOs), ordered by name. Port of
 * SpotifyService.ListAsync.
 *
 * @returns {Promise<object[]>}
 */
async function listConnections() {
  const conns = await SpotifyConnection.find().sort({ name: 1 }).lean();
  return conns.map(spotifyConnectionDto);
}

/**
 * Delete a connection; activities that pointed at it fall back to the free oEmbed
 * path (their spotifyConnectionId is nulled out). Port of SpotifyService.DeleteAsync
 * (incl. the Activity cascade).
 *
 * @param {string} connectionId
 * @returns {Promise<void>}
 */
async function deleteConnection(connectionId) {
  await SpotifyConnection.deleteOne({ _id: connectionId });
  await Activity.updateMany(
    { spotifyConnectionId: connectionId },
    { $set: { spotifyConnectionId: null } },
  );
}

/**
 * Refresh a connection's access token using its refresh token (rotates the
 * refresh token if Spotify returns a new one) and persist. Accepts a connection
 * id or a loaded doc. Port of the public surface around EnsureFreshAsync.
 *
 * @param {string|object} connection  id or a SpotifyConnection doc
 * @returns {Promise<object|null>} the refreshed doc (with tokens), or null if gone
 */
async function refreshConnection(connection) {
  const conn = typeof connection === 'object' && connection.save
    ? connection
    : await findWithTokens(typeof connection === 'object' ? connection._id : connection);
  if (!conn) return null;
  await ensureFresh(conn);
  return conn;
}

/**
 * A FRESH access token for the host's browser to drive the Web Playback SDK
 * (refreshes if expired). Null if the connection is gone; throws if the refresh
 * fails. Admin-only — enforced by the route layer. Port of SpotifyService.GetAccessTokenAsync.
 *
 * @param {string} connectionId
 * @returns {Promise<{accessToken:string}|null>} SpotifyTokenDto, or null if gone
 */
async function getPlaybackToken(connectionId) {
  const conn = await findWithTokens(connectionId);
  if (!conn) return null;
  await ensureFresh(conn);
  return { accessToken: conn.accessToken };
}

/**
 * Re-check a connection: refresh the token and call /me, recording + returning
 * the outcome (and re-syncing the display name). Port of SpotifyService.ValidateAsync.
 *
 * @param {string} connectionId
 * @returns {Promise<{valid:boolean,message:string}>} SpotifyValidateResultDto
 */
async function validate(connectionId) {
  const conn = await findWithTokens(connectionId);
  if (!conn) {
    return { valid: false, message: 'Connection not found.' };
  }

  try {
    await ensureFresh(conn);
    const { displayName } = await me(conn.accessToken);
    conn.lastStatus = 'valid';
    if (displayName && displayName.trim()) conn.name = displayName;
    await conn.save();
    return { valid: true, message: 'valid' };
  } catch (ex) {
    conn.lastStatus = short(ex && ex.message);
    await conn.save();
    return { valid: false, message: conn.lastStatus };
  }
}

/**
 * Exact track metadata via a connection (refreshes the token first), or null if
 * the connection is gone / the lookup failed (caller falls back to the free
 * path). Port of SpotifyService.GetTrackAsync — delegates the HTTP/parse to
 * musicLookup once a fresh token is in hand.
 *
 * @param {string} connectionId
 * @param {string} spotifyUrl  track link or URI
 * @returns {Promise<object|null>} MusicLookupResultDto (source "Spotify") or null
 */
async function lookupTrackViaConnection(connectionId, spotifyUrl) {
  const trackId = musicLookup.tryGetTrackId(spotifyUrl);
  if (!trackId) return null;

  const conn = await findWithTokens(connectionId);
  if (!conn) return null;

  try {
    await ensureFresh(conn);
  } catch {
    return null; // refresh failed — let the caller fall back to the free lookup
  }
  return musicLookup.lookupTrackWithToken(trackId, conn.accessToken);
}

module.exports = {
  CLIENT_ID_SETTING_KEY,
  effectiveClientId,
  setClientId,
  exchangeCode,
  listConnections,
  deleteConnection,
  refreshConnection,
  getPlaybackToken,
  validate,
  lookupTrackViaConnection,
};
