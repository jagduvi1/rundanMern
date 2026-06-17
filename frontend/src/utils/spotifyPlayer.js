// Spotify Web Playback SDK hook — the React port of rundan's wwwroot/js/spotify-player.js.
// Loads the SDK script on demand, creates a Spotify.Player, and controls full-track
// playback in the host's browser (Premium account required). The short-lived access
// token is fetched on demand from the API (getPlaybackToken → SpotifyTokenDto
// { accessToken }); the long-lived refresh token never leaves the server.
//
// It also exposes a verbose `debug` object (every SDK event, token fetch result, and
// the play() HTTP status/body) so the host panel can show exactly why playback fails.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPlaybackToken } from '../api/spotify';

const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';
const SDK_ELEMENT_ID = 'spotify-sdk';

function loadSdk() {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Spotify-spelaren kräver en webbläsare.'));
      return;
    }
    if (window.Spotify && window.Spotify.Player) {
      resolve();
      return;
    }
    const prev = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      if (typeof prev === 'function') prev();
      resolve();
    };
    if (!document.getElementById(SDK_ELEMENT_ID)) {
      const s = document.createElement('script');
      s.id = SDK_ELEMENT_ID;
      s.src = SDK_SRC;
      s.async = true;
      s.onerror = () => reject(new Error('Kunde inte ladda Spotify-spelaren.'));
      document.head.appendChild(s);
    }
  });
}

// Accept an open.spotify.com/track/… URL or a spotify:track: URI.
function toTrackUri(s) {
  if (!s) return null;
  if (s.startsWith('spotify:track:')) return s;
  const m = s.match(/track[:/]([A-Za-z0-9]+)/);
  return m ? 'spotify:track:' + m[1] : null;
}

const clock = () => {
  try { return new Date().toLocaleTimeString(); } catch { return ''; }
};

export function useSpotifyPlayer(connectionId) {
  const ref = useRef({ player: null, deviceId: null });
  const [ready, setReady] = useState(false);
  const [deviceId, setDeviceId] = useState(null);
  const [error, setError] = useState(null);

  // Verbose, host-only diagnostics. `events` is a rolling log of SDK callbacks +
  // play() attempts; the flags mirror the current player state.
  const [debug, setDebug] = useState(() => ({
    connectionId: connectionId || null,
    sdkLoaded: false,
    playerCreated: false,
    connectResult: null, // true/false from player.connect()
    ready: false,
    deviceId: null,
    token: null, // { at, ok, len }
    lastPlay: null, // { at, uri, status, ok, body, transferred }
    events: [], // [{ t, kind, msg }]
  }));
  const log = useCallback((kind, msg) => {
    setDebug((d) => ({
      ...d,
      events: [...d.events.slice(-59), { t: clock(), kind, msg: String(msg ?? '') }],
    }));
  }, []);
  const patch = useCallback((p) => setDebug((d) => ({ ...d, ...p })), []);

  const getToken = useCallback(async () => {
    if (!connectionId) { log('token', 'no connectionId — skipping'); return ''; }
    try {
      const dto = await getPlaybackToken(connectionId);
      const t = dto?.accessToken || '';
      patch({ token: { at: clock(), ok: !!t, len: t.length } });
      log('token', t ? `ok (len ${t.length})` : 'empty token returned');
      return t;
    } catch (e) {
      patch({ token: { at: clock(), ok: false, len: 0 } });
      const m = e?.message || 'Kunde inte hämta Spotify-token.';
      setError(m);
      log('token', `FAILED: ${m}`);
      return '';
    }
  }, [connectionId, log, patch]);

  // Create + connect the player when we have a connection id.
  useEffect(() => {
    patch({ connectionId: connectionId || null });
    if (!connectionId) { log('init', 'no connectionId — player not started'); return undefined; }
    let cancelled = false;
    let timer = null;

    (async () => {
      try {
        log('init', 'loading SDK…');
        await loadSdk();
        if (cancelled) return;
        patch({ sdkLoaded: true });
        log('init', 'SDK loaded');
        if (ref.current.player) { log('init', 'player already exists — reusing'); return; }

        const player = new window.Spotify.Player({
          name: 'GameDo (värd)',
          getOAuthToken: (cb) => { getToken().then((t) => cb(t || '')); },
          volume: 0.8,
        });
        ref.current.player = player;
        patch({ playerCreated: true });
        log('init', 'player created');

        player.addListener('ready', ({ device_id }) => {
          if (cancelled) return;
          ref.current.deviceId = device_id;
          setDeviceId(device_id);
          setReady(true);
          patch({ ready: true, deviceId: device_id });
          log('ready', `device_id ${device_id}`);
        });
        player.addListener('not_ready', ({ device_id }) => {
          ref.current.deviceId = null;
          setDeviceId(null);
          setReady(false);
          patch({ ready: false, deviceId: null });
          log('not_ready', `device went offline (${device_id})`);
        });
        player.addListener('initialization_error', (e) => { setError(e?.message || 'Spotify-initieringsfel.'); log('error', `init_error: ${e?.message}`); });
        player.addListener('authentication_error', (e) => { setError(e?.message || 'Spotify-autentiseringsfel.'); log('error', `auth_error: ${e?.message} — token rejected (re-connect the account?)`); });
        player.addListener('account_error', (e) => { setError(e?.message || 'Spotify-kontofel (kräver Premium?).'); log('error', `account_error: ${e?.message} — Premium required`); });
        player.addListener('playback_error', (e) => { log('error', `playback_error: ${e?.message}`); });

        log('init', 'connecting…');
        const connected = await player.connect();
        patch({ connectResult: connected });
        log('init', `connect() → ${connected}`);
        if (!connected && !cancelled) setError('Kunde inte ansluta till Spotify-spelaren.');

        timer = setTimeout(() => {
          if (!cancelled && !ref.current.deviceId) {
            setError((prev) => prev || 'Spotify-spelaren blev inte redo (kräver Premium?).');
            log('init', 'TIMEOUT: no device_id after 8s (Premium? pop-up/cookie blockers?)');
          }
        }, 8000);
      } catch (e) {
        if (!cancelled) { setError(e?.message || 'Spotify-spelaren kunde inte startas.'); log('error', `startup: ${e?.message}`); }
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      const { player } = ref.current;
      if (player) { try { player.disconnect(); } catch { /* ignore */ } }
      ref.current = { player: null, deviceId: null };
    };
  }, [connectionId, getToken, log, patch]);

  // Raw Web API play call against our SDK device.
  const playOnDevice = useCallback(async (uri, id, token) => {
    const res = await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [uri] }),
      },
    );
    let body = '';
    if (!res.ok) { try { body = await res.text(); } catch { /* ignore */ } }
    return { ok: res.ok, status: res.status, body };
  }, []);

  // Start a track via the Web API (the SDK is the playback device). On a 404
  // ("device not found") we transfer playback to our device, then retry once.
  const play = useCallback(
    async (spotifyUri) => {
      const uri = toTrackUri(spotifyUri);
      const id = ref.current.deviceId;
      if (!uri) { log('play', `bad URI from "${spotifyUri}"`); patch({ lastPlay: { at: clock(), uri: null, status: 0, ok: false, body: 'unparseable url' } }); return false; }
      if (!id) { log('play', 'no deviceId yet — player not ready'); patch({ lastPlay: { at: clock(), uri, status: 0, ok: false, body: 'no device' } }); return false; }
      const token = await getToken();
      if (!token) { log('play', 'no token — aborting'); return false; }
      try {
        let r = await playOnDevice(uri, id, token);
        let transferred = false;
        if (!r.ok && r.status === 404) {
          // Device not found — transfer playback to it, then retry.
          log('play', '404 — transferring playback to device, retrying…');
          try {
            await fetch('https://api.spotify.com/v1/me/player', {
              method: 'PUT',
              headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ device_ids: [id], play: false }),
            });
            transferred = true;
            r = await playOnDevice(uri, id, token);
          } catch (e) { log('play', `transfer failed: ${e?.message}`); }
        }
        patch({ lastPlay: { at: clock(), uri, status: r.status, ok: r.ok, body: r.body, transferred } });
        log('play', `${uri} → HTTP ${r.status}${r.ok ? ' (playing)' : ` ${r.body || ''}`}${transferred ? ' [after transfer]' : ''}`);
        return r.ok;
      } catch (e) {
        setError(e?.message || 'Uppspelning misslyckades.');
        patch({ lastPlay: { at: clock(), uri, status: 0, ok: false, body: e?.message || 'fetch threw' } });
        log('play', `threw: ${e?.message}`);
        return false;
      }
    },
    [getToken, playOnDevice, log, patch],
  );

  // Unlock audio for autoplay-restricted browsers — must run inside a user gesture
  // (a click) before the first play(); otherwise the device reports ready and play()
  // returns 204 but NO audio is heard. Called synchronously in the click handlers.
  const activate = useCallback(() => {
    const { player } = ref.current;
    if (player && typeof player.activateElement === 'function') {
      try { const r = player.activateElement(); log('activate', 'activateElement() called'); return r; } catch (e) { log('activate', `activateElement threw: ${e?.message}`); }
    } else { log('activate', 'no player / no activateElement'); }
    return undefined;
  }, [log]);

  const pause = useCallback(() => {
    const { player } = ref.current;
    if (player) { try { return player.pause(); } catch { /* ignore */ } }
    return undefined;
  }, []);

  const resume = useCallback(() => {
    const { player } = ref.current;
    if (player) { try { return player.resume(); } catch { /* ignore */ } }
    return undefined;
  }, []);

  return { ready, deviceId, error, play, pause, resume, activate, debug };
}
