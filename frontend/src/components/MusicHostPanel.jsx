// MusicHostPanel — the host's live "now playing" panel for a MusicQuiz in progress.
// The React port of rundan's MusicHostPanel.razor. Lists the tracks; each "Start"
// reveals a track to players (POST .../music/start/:qid → emits MusicTrackStarted +
// starts a countdown) and, if speedScoring is on, begins a fastest-to-answer round.
// Starting a track does NOT play it — playback is a separate "▶ Spela" action, so
// the host can start the timer first and then start the song (matching rundan).
// When a Spotify connection exists "▶ Spela" plays the full track in-app via the Web
// Playback SDK (useSpotifyPlayer, Premium required); otherwise the "Spotify ↗" link
// opens the track. Host-only — mounted by Activity.jsx behind the canManage check.
//
// Props:
//   activity : ActivityDto — reads { id, spotifyConnectionId, speedScoring }.
import { useEffect, useRef, useState } from 'react';
import { startTrack } from '../api/music';
import { getAdminQuestions } from '../api/questions';
import { apiPost } from '../api/client';
import { useSpotifyPlayer } from '../utils/spotifyPlayer';
import Spinner from './Spinner';

// Best-effort "wrap up the quiz if that was the last track" — no dedicated API
// helper exists, so call the endpoint directly (204, ignore failures).
const maybeFinishMusic = (activityId) =>
  apiPost(`/activities/${activityId}/music/maybe-finish`, {}, { activityId }).catch(() => {});

const secondsSince = (start) => Math.floor((Date.now() - start) / 1000);

export default function MusicHostPanel({ activity }) {
  const canPlayInApp = activity?.spotifyConnectionId != null;
  // The hook no-ops when connectionId is null, so it's safe to call unconditionally.
  const {
    ready, deviceId, error: playerError, play, pause, resume, activate, debug,
  } = useSpotifyPlayer(activity?.spotifyConnectionId || null);

  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Live (fastest-to-answer) round.
  const [live, setLive] = useState(null); // { id, start(ms), window(s) } | null
  const [, setTick] = useState(0); // forces a re-render each 500ms while live
  const tickerRef = useRef(null);
  const liveRef = useRef(null);
  liveRef.current = live;

  // In-app playback.
  const [playingId, setPlayingId] = useState(null);
  const [paused, setPaused] = useState(false);
  const [playBusy, setPlayBusy] = useState(false);
  const [playError, setPlayError] = useState(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Load tracks once.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const list = await getAdminQuestions(activity.id);
        if (alive) setTracks(list || []);
      } catch (e) {
        if (alive) setError(e?.message || 'Kunde inte ladda spåren.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [activity.id]);

  // Countdown ticker — computes remaining from timestamps so it's resilient to tab
  // throttling. When it reaches 0, stop and call maybe-finish once.
  function ensureTicking() {
    if (tickerRef.current) return;
    tickerRef.current = setInterval(() => {
      const cur = liveRef.current;
      if (!cur) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
        return;
      }
      const remaining = Math.max(0, cur.window - secondsSince(cur.start));
      if (remaining <= 0) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
        if (aliveRef.current) setLive(null);
        maybeFinishMusic(activity.id);
      } else if (aliveRef.current) {
        setTick((n) => n + 1);
      }
    }, 500);
  }

  useEffect(() => () => {
    if (tickerRef.current) clearInterval(tickerRef.current);
  }, []);

  async function start(t) {
    // "Starta" only reveals the track to players and starts the countdown — it does
    // NOT play the song. The host plays it separately with "▶ Spela" (same flow as
    // the original rundan: start the timer first, then start the song). We still
    // pre-warm audio within this click gesture so the later "▶ Spela" click is
    // already unlocked under the browser's autoplay policy.
    if (canPlayInApp) activate();
    setBusy(true);
    setError(null);
    try {
      const res = await startTrack(activity.id, t.id);
      if (!aliveRef.current) return;
      setLive({
        id: res?.questionId ?? t.id,
        start: res?.startedUtc ? new Date(res.startedUtc).getTime() : Date.now(),
        window: res?.windowSeconds || 30,
      });
      ensureTicking();
    } catch (e) {
      setError(e?.message || 'Kunde inte starta spåret.');
    } finally {
      setBusy(false);
    }
  }

  async function playTrack(t) {
    if (!(t.spotifyUrl && t.spotifyUrl.trim())) return;
    if (!canPlayInApp) {
      window.open(t.spotifyUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    activate(); // unlock audio within the click gesture (autoplay policy)
    setPlayBusy(true);
    setPlayError(null);
    try {
      if (!ready) {
        setPlayError('Kunde inte starta spelaren i appen — kontrollera att det anslutna kontot är Spotify Premium. Du kan fortfarande använda ”Spotify ↗”-länken.');
        return;
      }
      const ok = await play(t.spotifyUrl);
      if (ok) {
        setPlayingId(t.id);
        setPaused(false);
      } else {
        setPlayError('Spotify ville inte starta det spåret. Prova ”Spotify ↗”-länken.');
      }
    } catch (e) {
      setPlayError(e?.message || 'Uppspelningen misslyckades.');
    } finally {
      setPlayBusy(false);
    }
  }

  async function togglePause() {
    setPlayBusy(true);
    try {
      if (paused) await resume(); else await pause();
      setPaused((p) => !p);
    } catch {
      /* best effort */
    } finally {
      setPlayBusy(false);
    }
  }

  if (loading) {
    return <div className="card center muted"><Spinner /></div>;
  }

  const playingIndex = tracks.findIndex((t) => t.id === playingId);
  const playingLabel = playingIndex >= 0 ? `Spår ${playingIndex + 1}` : '';
  const liveRemaining = live ? Math.max(0, live.window - secondsSince(live.start)) : 0;
  const windowSec = live?.window || 30;

  return (
    <div className="card stack" style={{ borderColor: 'var(--accent)' }}>
      <h2 style={{ margin: 0 }}>Spår att spela (värd)</h2>
      <p className="muted small" style={{ margin: 0 }}>
        {canPlayInApp
          ? 'Spela hela spår här med din Spotify Premium-anslutning, eller öppna dem i Spotify. '
          : 'Spela varje spår högt. '}
        Tryck <b>Starta</b> för att avslöja ett spår för spelarna
        {activity.speedScoring
          ? ` och starta en snabbast-svar-runda — ett rätt svar ger mer ju snabbare det kommer in (bonusen avtar över ${windowSec} s).`
          : '.'}
        {' '}Spelarna ser ett spår först när du startat det, och i tryck-på-artisten-läget låses deras val när tiden går ut. Den här panelen är bara din.
      </p>

      {error ? <div className="error-text">{error}</div> : null}
      {(playError || playerError) ? <div className="error-text">{playError || playerError}</div> : null}

      {canPlayInApp && playingId != null ? (
        <div className="row" style={{ gap: '.5rem', alignItems: 'center', background: 'var(--accent-soft, #f3f0ea)', borderRadius: 10, padding: '.4rem .6rem' }}>
          <span className="grow"><b>♪ Spelar</b> {playingLabel}</span>
          <button type="button" className="btn sm" onClick={togglePause} disabled={playBusy}>{paused ? '▶ Återuppta' : '⏸ Pausa'}</button>
        </div>
      ) : null}

      <ul style={listStyle}>
        {tracks.map((t, i) => {
          const isLive = live?.id === t.id;
          return (
            <li key={t.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '.3rem' }}>
              <div className="row wrap">
                <b className="grow">Spår {i + 1}</b>
                {isLive ? <span className="pill live">▶ LIVE · {liveRemaining} s</span> : null}
                <button type="button" className={`btn sm ${isLive ? 'ghost' : 'success'}`} onClick={() => start(t)} disabled={busy}>
                  {isLive ? 'Starta om' : 'Starta'}
                </button>
                {t.spotifyUrl && t.spotifyUrl.trim() ? (
                  <>
                    <button type="button" className="btn sm" onClick={() => playTrack(t)} disabled={playBusy} title={canPlayInApp ? 'Spela hela spåret i appen (Premium)' : 'Öppna i Spotify'}>▶ Spela</button>
                    <a className="btn sm ghost" href={t.spotifyUrl} target="_blank" rel="noopener noreferrer" title="Öppna spåret i Spotify">Spotify ↗</a>
                  </>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: '.82rem' }}>
                {t.hidden ? (
                  <span>Svar dolt medan du spelar</span>
                ) : (
                  <span>
                    Svar: <b>{t.acceptedFreeTextAnswer && t.acceptedFreeTextAnswer.trim() ? t.acceptedFreeTextAnswer : '—'}</b>
                    {' av '}
                    <b>{t.acceptedArtist && t.acceptedArtist.trim() ? t.acceptedArtist : '—'}</b>
                    {t.releaseYear != null ? ` · ${t.releaseYear}` : ''}
                  </span>
                )}
                {' · '}<b>{t.points} p</b>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Verbose Spotify diagnostics — temporary, while we get playback solid. */}
      <details style={{ marginTop: '.4rem' }}>
        <summary className="muted small" style={{ cursor: 'pointer' }}>🔧 Spotify-debug</summary>
        <div className="stack" style={{ gap: 4, marginTop: '.4rem', fontSize: '.78rem' }}>
          <div className="muted">canPlayInApp: <b>{String(canPlayInApp)}</b> · connectionId: <b>{String(activity?.spotifyConnectionId ?? 'null')}</b></div>
          <div className="muted">SDK laddad: <b>{String(debug.sdkLoaded)}</b> · spelare skapad: <b>{String(debug.playerCreated)}</b> · connect(): <b>{String(debug.connectResult)}</b></div>
          <div className="muted">redo (ready): <b>{String(ready)}</b> · device_id: <b>{deviceId || '—'}</b></div>
          <div className="muted">token: <b>{debug.token ? (debug.token.ok ? `ok (len ${debug.token.len}) @ ${debug.token.at}` : `MISSLYCKADES @ ${debug.token.at}`) : '—'}</b></div>
          <div className="muted">
            senaste play():{' '}
            <b>{debug.lastPlay ? `HTTP ${debug.lastPlay.status} ${debug.lastPlay.ok ? 'OK ✓' : (debug.lastPlay.body || '')}${debug.lastPlay.transferred ? ' (efter transfer)' : ''} @ ${debug.lastPlay.at}` : '—'}</b>
          </div>
          <div className="muted">spår med spotifyUrl: <b>{tracks.filter((t) => t.spotifyUrl && t.spotifyUrl.trim()).length}/{tracks.length}</b></div>
          {playerError ? <div className="error-text">player-fel: {playerError}</div> : null}
          <pre style={{ maxHeight: 220, overflow: 'auto', background: 'var(--surface-2)', padding: '.4rem .5rem', borderRadius: 6, fontSize: '.72rem', margin: 0, whiteSpace: 'pre-wrap' }}>
            {debug.events.length ? debug.events.map((e) => `${e.t}  [${e.kind}] ${e.msg}`).join('\n') : '(inga händelser än — tryck ▶ Spela)'}
          </pre>
        </div>
      </details>
    </div>
  );
}

const listStyle = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 };
