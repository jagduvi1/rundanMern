// Spotify OAuth (PKCE) + token management — per-user.
//
// PER-USER MODEL: there is NO global/shared Spotify key. Each logged-in host
// registers their OWN Spotify app and pastes its public Client ID onto their
// Account (`Account.spotifyClientId`). A host with Spotify Premium then completes
// a browser OAuth login (Authorization Code + PKCE, NO client secret); the server
// exchanges the code for tokens and stores them as a reusable CONNECTION OWNED BY
// that account (`SpotifyConnection.ownerId`). Connections are used to read exact
// track metadata, drive the Web Playback SDK (a short-lived access token handed to
// the browser), and bulk-import playlist tracks.
//
// SECURITY: refresh/access tokens are SERVER-ONLY. They live on the
// SpotifyConnection doc with `select:false` and are NEVER returned to clients —
// this module reads them explicitly with `.select('+refreshToken +accessToken')`
// and only ever surfaces a freshly-minted access token via getPlaybackToken
// (auth-gated by the route layer). A connection refreshes against its OWNER's
// Client ID (resolved via `ownerId`), so playback keeps working regardless of who
// triggers it.

const { SpotifyConnection, Account, Activity } = require('../models');
const { RuleViolation } = require('../middleware/error');
const { spotifyConnectionDto } = require('./serializers');
const musicLookup = require('./musicLookup');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const HTTP_TIMEOUT_MS = 6000; // matches the C# "music" named HttpClient (6 s)

const now = () => new Date();

// Trim a Client ID to its non-blank value, or null.
const trimId = (v) => (v && typeof v === 'string' && v.trim() ? v.trim() : null);

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
 * The Spotify app Client ID configured on an account (per-user), trimmed, or null.
 *
 * @param {string} accountId
 * @returns {Promise<string|null>}
 */
async function getClientId(accountId) {
  if (!accountId) return null;
  const acct = await Account.findById(accountId).select('spotifyClientId').lean();
  return acct ? trimId(acct.spotifyClientId) : null;
}

/**
 * Save (or clear, when blank) the account's own Spotify Client ID. Returns the
 * stored (trimmed) value so the caller can echo it back to the client.
 *
 * @param {string} accountId
 * @param {string} clientId
 * @returns {Promise<string>}
 */
async function setClientId(accountId, clientId) {
  // Hard-cap to the schema's maxlength (updateOne runs no validators).
  const val = (clientId || '').trim().slice(0, 200);
  await Account.updateOne({ _id: accountId }, { $set: { spotifyClientId: val } });
  return val;
}

// The Client ID that OWNS a connection — used to refresh its tokens.
async function clientIdForConnection(conn) {
  return getClientId(conn && conn.ownerId);
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

  const clientId = await clientIdForConnection(conn);
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

// Load a connection WITH its server-only tokens (or null). When `ownerId` is
// given, the lookup is scoped to that owner (so a host only ever touches their
// own connections); omit it for the game-time playback path.
function findWithTokens(connectionId, ownerId = null) {
  const filter = ownerId ? { _id: connectionId, ownerId } : { _id: connectionId };
  return SpotifyConnection.findOne(filter).select('+refreshToken +accessToken');
}

/**
 * Exchange the OAuth code (PKCE) for tokens and save a new connection owned by the
 * account. Returns the client-safe SpotifyConnectionDto (tokens stay server-side).
 *
 * @param {object} args
 * @param {string} args.accountId    the host whose Client ID + connection this is
 * @param {string} args.code
 * @param {string} args.codeVerifier
 * @param {string} args.redirectUri  must match the authorize request exactly
 * @returns {Promise<object>} SpotifyConnectionDto
 */
async function exchangeCode({ accountId, code, codeVerifier, redirectUri }) {
  const clientId = await getClientId(accountId);
  if (!clientId) throw new RuleViolation('Add your Spotify Client ID first, then connect.');

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
    ownerId: accountId,
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
 * List an account's own saved connections (client-safe DTOs), ordered by name.
 *
 * @param {string} ownerId
 * @returns {Promise<object[]>}
 */
async function listConnections(ownerId) {
  const conns = await SpotifyConnection.find({ ownerId }).sort({ name: 1 }).lean();
  return conns.map(spotifyConnectionDto);
}

/**
 * Delete one of the account's connections; activities that pointed at it fall back
 * to the free oEmbed path (their spotifyConnectionId is nulled out).
 *
 * @param {string} connectionId
 * @param {string} ownerId  scopes the delete to the caller's own connections
 * @returns {Promise<void>}
 */
async function deleteConnection(connectionId, ownerId) {
  const filter = ownerId ? { _id: connectionId, ownerId } : { _id: connectionId };
  const res = await SpotifyConnection.deleteOne(filter);
  if (res.deletedCount) {
    await Activity.updateMany(
      { spotifyConnectionId: connectionId },
      { $set: { spotifyConnectionId: null } },
    );
  }
}

/**
 * A FRESH access token for the host's browser to drive the Web Playback SDK
 * (refreshes if expired). Null if the connection is gone; throws if the refresh
 * fails. When `ownerId` is given the lookup is scoped to that owner (the Admin
 * connection-management route); the game-time path omits it. Port of
 * SpotifyService.GetAccessTokenAsync.
 *
 * @param {string} connectionId
 * @param {string|null} ownerId
 * @returns {Promise<{accessToken:string}|null>} SpotifyTokenDto, or null if gone
 */
async function getPlaybackToken(connectionId, ownerId = null) {
  const conn = await findWithTokens(connectionId, ownerId);
  if (!conn) return null;
  await ensureFresh(conn);
  return { accessToken: conn.accessToken };
}

/**
 * Re-check one of the account's connections: refresh the token and call /me,
 * recording + returning the outcome (and re-syncing the display name). Port of
 * SpotifyService.ValidateAsync.
 *
 * @param {string} connectionId
 * @param {string} ownerId
 * @returns {Promise<{valid:boolean,message:string}>} SpotifyValidateResultDto
 */
async function validate(connectionId, ownerId) {
  const conn = await findWithTokens(connectionId, ownerId);
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
  getClientId,
  setClientId,
  exchangeCode,
  listConnections,
  deleteConnection,
  getPlaybackToken,
  validate,
  lookupTrackViaConnection,
};
