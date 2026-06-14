// SpotifyCallback — "/spotify-callback" — completes the Spotify Auth-Code + PKCE
// flow started from Admin (port of rundan's SpotifyCallback.razor). Reads the
// code/state/error off the URL, recovers the PKCE verifier from sessionStorage,
// validates state, and exchanges via POST /api/spotify/connect. This must be a
// real route the Spotify app's Redirect URI points at (SPA fallback serves it).
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { connectSpotify } from '../api/spotify';
import { readCallback, redirectUri } from '../utils/spotifyAuth';
import { useDocumentTitle } from '../utils/useDocumentTitle';

export default function SpotifyCallback() {
  useDocumentTitle('Ansluter Spotify · Rundan');
  const [status, setStatus] = useState('working'); // working | done | error
  const [name, setName] = useState(null);
  const [error, setError] = useState(null);
  const ran = useRef(false);

  useEffect(() => {
    // StrictMode double-invokes effects in dev; the auth code is single-use, so
    // guard against exchanging it twice.
    if (ran.current) return;
    ran.current = true;

    (async () => {
      const cb = readCallback();
      if (cb.error) {
        setError(`Spotify rapporterade: ${cb.error}.`);
        setStatus('error');
        return;
      }
      if (!cb.code || !cb.stateOk || !cb.verifier) {
        setError('Inloggningen slutfördes inte (svar saknas eller stämmer inte). Börja om från värdinställningarna.');
        setStatus('error');
        return;
      }
      try {
        const conn = await connectSpotify(cb.code, cb.verifier, redirectUri());
        setName(conn?.name || 'Spotify');
        setStatus('done');
      } catch (err) {
        setError(err?.message || 'Kunde inte slutföra anslutningen.');
        setStatus('error');
      }
    })();
  }, []);

  return (
    <div className="card stack center">
      <img src="/assets/rundan-mark.svg" width={56} height={56} alt="" style={{ margin: '0 auto' }} />
      <h1>Spotify</h1>
      {status === 'error' ? (
        <>
          <p className="error-text">{error}</p>
          <Link className="btn" to="/admin">Tillbaka till värdinställningar</Link>
        </>
      ) : status === 'done' ? (
        <>
          <p style={{ color: 'var(--ok)' }}>Ansluten som <b>{name}</b> ✓</p>
          <Link className="btn success" to="/admin">Tillbaka till värdinställningar</Link>
        </>
      ) : (
        <>
          <p className="muted">Slutför anslutningen…</p>
          <span className="spinner" style={{ margin: '1rem auto' }} />
        </>
      )}
    </div>
  );
}
