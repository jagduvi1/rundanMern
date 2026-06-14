// Spotify Authorization-Code + PKCE helpers — the React port of rundan's
// wwwroot/js/spotify.js. The host starts the flow from Admin (startLogin → full
// redirect to Spotify), and SpotifyCallback reads it back (readCallback) and
// exchanges the code server-side via POST /api/spotify/connect.
//
// The PKCE verifier + CSRF state live in sessionStorage (cleared after readback)
// so they survive the round-trip to Spotify but never persist.

const VERIFIER_KEY = 'spotify_verifier';
const STATE_KEY = 'spotify_state';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';

// The redirect URI registered in the Spotify app — always this exact route.
export function redirectUri() {
  return `${window.location.origin}/spotify-callback`;
}

function randomString(length = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) out += chars[bytes[i] % chars.length];
  return out;
}

function base64UrlEncode(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(input) {
  const data = new TextEncoder().encode(input);
  return crypto.subtle.digest('SHA-256', data);
}

// Begin the OAuth flow: mint + stash verifier/state, then redirect the whole tab
// to Spotify's consent screen.
export async function startLogin(clientId, scope) {
  const verifier = randomString(64);
  const state = randomString(24);
  const challenge = base64UrlEncode(await sha256(verifier));

  try {
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);
  } catch { /* sessionStorage blocked — the callback will detect the missing verifier */ }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope,
  });
  window.location.assign(`${AUTHORIZE_URL}?${params.toString()}`);
}

// Read the values Spotify returned on /spotify-callback. Pulls ?code/state/error
// off the URL, recovers the verifier + expected state from sessionStorage,
// validates state, and clears the temp keys. Returns
// { code, error, verifier, stateOk }.
export function readCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const returnedState = url.searchParams.get('state');

  let verifier = '';
  let expectedState = '';
  try {
    verifier = sessionStorage.getItem(VERIFIER_KEY) || '';
    expectedState = sessionStorage.getItem(STATE_KEY) || '';
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
  } catch { /* ignore */ }

  const stateOk = !!returnedState && !!expectedState && returnedState === expectedState;
  return { code, error, verifier, stateOk };
}

// The scopes rundan requests (full-track Web Playback + playlist import).
export const SPOTIFY_SCOPES =
  'user-read-private user-read-email streaming user-modify-playback-state '
  + 'user-read-playback-state playlist-read-private playlist-read-collaborative';
