// Spotify Web Playback SDK hook — the React port of rundan's wwwroot/js/spotify-player.js.
// Loads the SDK script on demand, creates a Spotify.Player, and controls full-track
// playback in the host's browser (Premium account required). The short-lived access
// token is fetched on demand from the API (getPlaybackToken → SpotifyTokenDto
// { accessToken }); the long-lived refresh token never leaves the server.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPlaybackToken } from '../api/spotify';

const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';
const SDK_ELEMENT_ID = 'spotify-sdk';

// Resolve once the global Spotify SDK is available. The SDK calls the global
// `onSpotifyWebPlaybackSDKReady` handshake when it finishes loading.
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

export function useSpotifyPlayer(connectionId) {
  const ref = useRef({ player: null, deviceId: null });
  const [ready, setReady] = useState(false);
  const [deviceId, setDeviceId] = useState(null);
  const [error, setError] = useState(null);

  // Fetch a fresh access token for the SDK / Web API (refresh via the same call
  // on expiry — every play() re-fetches).
  const getToken = useCallback(async () => {
    try {
      const dto = await getPlaybackToken(connectionId);
      return dto?.accessToken || '';
    } catch (e) {
      setError(e?.message || 'Kunde inte hämta Spotify-token.');
      return '';
    }
  }, [connectionId]);

  // Create + connect the player when we have a connection id.
  useEffect(() => {
    if (!connectionId) return undefined;
    let cancelled = false;
    let timer = null;

    (async () => {
      try {
        await loadSdk();
        if (cancelled) return;
        if (ref.current.player) return; // idempotent

        const player = new window.Spotify.Player({
          name: 'Rundan (värd)',
          getOAuthToken: (cb) => {
            getToken().then((t) => cb(t || ''));
          },
          volume: 0.8,
        });
        ref.current.player = player;

        player.addListener('ready', ({ device_id }) => {
          if (cancelled) return;
          ref.current.deviceId = device_id;
          setDeviceId(device_id);
          setReady(true);
        });
        player.addListener('not_ready', () => {
          ref.current.deviceId = null;
          setDeviceId(null);
          setReady(false);
        });
        player.addListener('initialization_error', (e) => setError(e?.message || 'Spotify-initieringsfel.'));
        player.addListener('authentication_error', (e) => setError(e?.message || 'Spotify-autentiseringsfel.'));
        player.addListener('account_error', (e) =>
          setError(e?.message || 'Spotify-kontofel (kräver Premium?).'),
        );

        const connected = await player.connect();
        if (!connected && !cancelled) {
          setError('Kunde inte ansluta till Spotify-spelaren.');
        }
        // Surface a timeout-style readiness so callers don't hang forever.
        timer = setTimeout(() => {
          if (!cancelled && !ref.current.deviceId) {
            setError((prev) => prev || 'Spotify-spelaren blev inte redo (kräver Premium?).');
          }
        }, 8000);
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Spotify-spelaren kunde inte startas.');
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      const { player } = ref.current;
      if (player) {
        try {
          player.disconnect();
        } catch {
          /* ignore */
        }
      }
      ref.current = { player: null, deviceId: null };
    };
  }, [connectionId, getToken]);

  // Start a track via the Web API (the SDK is the playback device).
  const play = useCallback(
    async (spotifyUri) => {
      const uri = toTrackUri(spotifyUri);
      const id = ref.current.deviceId;
      if (!uri || !id) return false;
      const token = await getToken();
      if (!token) return false;
      try {
        const res = await fetch(
          `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(id)}`,
          {
            method: 'PUT',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ uris: [uri] }),
          },
        );
        return res.ok;
      } catch (e) {
        setError(e?.message || 'Uppspelning misslyckades.');
        return false;
      }
    },
    [getToken],
  );

  const pause = useCallback(() => {
    const { player } = ref.current;
    if (player) {
      try {
        return player.pause();
      } catch {
        /* ignore */
      }
    }
    return undefined;
  }, []);

  const resume = useCallback(() => {
    const { player } = ref.current;
    if (player) {
      try {
        return player.resume();
      } catch {
        /* ignore */
      }
    }
    return undefined;
  }, []);

  return { ready, deviceId, error, play, pause, resume };
}
