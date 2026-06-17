import { useEffect, useRef, useState } from 'react';
import { getHitsterState, startHitster, drawHitsterCard } from '../api/hitster';
import { getAdminQuestions } from '../api/questions';
import { startTrack } from '../api/music';
import { useSpotifyPlayer } from '../utils/spotifyPlayer';
import { getSocket } from '../utils/socket';
import { ServerEvents } from '../config/socketEvents';
import Spinner from './Spinner';

export default function HitsterHostPanel({ activity }) {
  const canPlayInApp = activity?.spotifyConnectionId != null;
  const { ready, play, pause, resume, activate } = useSpotifyPlayer(activity?.spotifyConnectionId || null);

  const [state, setState] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [playingId, setPlayingId] = useState(null);
  const [paused, setPaused] = useState(false);
  const [playBusy, setPlayBusy] = useState(false);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    Promise.all([
      getHitsterState(activity.id),
      // reveal=true: the host runs the game, so they need the real release years
      // (and titles) even when "hide answers from host" is on — otherwise every
      // track comes back masked and the panel shows "0 spår med årtal redo".
      getAdminQuestions(activity.id, true),
    ]).then(([s, q]) => {
      if (!aliveRef.current) return;
      setState(s);
      setTracks(q || []);
    }).catch((e) => {
      if (aliveRef.current) setError(e?.message || 'Kunde inte ladda.');
    }).finally(() => {
      if (aliveRef.current) setLoading(false);
    });
    return () => { aliveRef.current = false; };
  }, [activity.id]);

  // Socket: live state changes
  useEffect(() => {
    let socket = null;
    let alive = true;
    const onUpdate = (dto) => {
      if (!alive || !dto || String(dto.activityId) !== String(activity.id)) return;
      setState(dto);
    };
    getSocket().then((s) => {
      if (!alive) return;
      socket = s;
      s.on(ServerEvents.HitsterStateChanged, onUpdate);
    });
    return () => {
      alive = false;
      if (socket) socket.off(ServerEvents.HitsterStateChanged, onUpdate);
    };
  }, [activity.id]);

  async function doStart() {
    setBusy(true);
    setError(null);
    try {
      const s = await startHitster(activity.id);
      setState(s);
    } catch (e) {
      setError(e?.message || 'Kunde inte starta.');
    } finally {
      setBusy(false);
    }
  }

  async function doDraw() {
    setBusy(true);
    setError(null);
    try {
      const s = await drawHitsterCard(activity.id);
      setState(s);
    } catch (e) {
      setError(e?.message || 'Kunde inte dra kort.');
    } finally {
      setBusy(false);
    }
  }

  async function doStartTrack(questionId, spotifyUrl) {
    // Unlock audio within this click gesture before any await (autoplay policy).
    if (canPlayInApp) activate();
    setBusy(true);
    try {
      await startTrack(activity.id, questionId);

      if (canPlayInApp && ready && spotifyUrl) {
        setPlayBusy(true);
        try {
          await play(spotifyUrl);
          setPlayingId(questionId);
          setPaused(false);
        } catch { /* fallback to manual Spotify play */ }
        setPlayBusy(false);
      }
    } catch (e) {
      setError(e?.message);
    } finally {
      setBusy(false);
    }
  }

  async function togglePlayback() {
    setPlayBusy(true);
    try {
      if (paused) { await resume(); setPaused(false); }
      else { await pause(); setPaused(true); }
    } catch { /* ignore */ }
    setPlayBusy(false);
  }

  if (loading) {
    return <div className="card center muted"><Spinner /></div>;
  }

  const currentTrack = state?.currentCard?.questionId
    ? tracks.find((t) => String(t.id) === String(state.currentCard.questionId))
    : null;

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>🎵 Hitster — Värdpanel</h2>
      {error ? <div style={errorStyle}>{error}</div> : null}

      {/* Not started yet */}
      {!state?.started ? (
        <div className="stack">
          <p className="muted">
            {tracks.filter((t) => t.releaseYear != null).length} spår med årtal redo.
            Starta spelet för att blanda och dela ut kort.
          </p>
          <button type="button" className="btn success" onClick={doStart} disabled={busy}>
            {busy ? 'Startar…' : 'Starta Hitster'}
          </button>
        </div>
      ) : null}

      {/* Game in progress */}
      {state?.started && !state?.finished ? (
        <div className="stack" style={{ gap: 12 }}>
          {/* Current turn */}
          <div className="row" style={{ gap: 8 }}>
            <span className="grow">
              <b>{state.teams[state.currentTurnIndex]?.displayName}</b>s tur
            </span>
            <span className="muted small">Runda {state.roundsPlayed + 1} · {state.deckRemaining} kort kvar</span>
          </div>

          {/* Draw / play controls */}
          {!state.hasCurrentCard ? (
            <button type="button" className="btn success" onClick={doDraw} disabled={busy}>
              {busy ? 'Drar…' : 'Dra nästa kort'}
            </button>
          ) : (
            <div className="stack" style={{ gap: 8, background: 'var(--surface-2)', padding: 12, borderRadius: 'var(--radius-sm)' }}>
              <span className="muted small">Kort draget — spela låten för laget!</span>
              {currentTrack ? (
                <div className="row wrap" style={{ gap: 8 }}>
                  <span className="grow" style={{ fontStyle: 'italic' }}>
                    {currentTrack.acceptedFreeTextAnswer || 'Okänd låt'}
                    {currentTrack.acceptedArtist ? ` — ${currentTrack.acceptedArtist}` : ''}
                    {currentTrack.releaseYear ? ` (${currentTrack.releaseYear})` : ''}
                  </span>
                  {currentTrack.spotifyUrl ? (
                    <>
                      {canPlayInApp && ready ? (
                        <button
                          type="button"
                          className={`btn sm ${playingId === currentTrack.id ? 'ghost' : ''}`}
                          disabled={playBusy}
                          onClick={() => {
                            if (playingId === currentTrack.id) { togglePlayback(); }
                            else { doStartTrack(currentTrack.id, currentTrack.spotifyUrl); }
                          }}
                        >
                          {playingId === currentTrack.id ? (paused ? '▶ Fortsätt' : '⏸ Pausa') : '▶ Spela'}
                        </button>
                      ) : null}
                      <a className="btn ghost sm" href={currentTrack.spotifyUrl} target="_blank" rel="noopener noreferrer">
                        Spotify ↗
                      </a>
                    </>
                  ) : null}
                  {!currentTrack.spotifyUrl ? (
                    <button type="button" className="btn sm" onClick={() => doStartTrack(currentTrack.id, null)} disabled={busy}>
                      Starta
                    </button>
                  ) : null}
                </div>
              ) : (
                <span className="muted">Laddar spår…</span>
              )}
            </div>
          )}

          {/* All teams' timelines (everyone plays against each other) */}
          <HostTimelines teams={state.teams} />
        </div>
      ) : null}

      {/* Finished */}
      {state?.finished ? (
        <div className="stack">
          <div style={successStyle}>
            🏆 Spelet är slut!
            {state.winnerId
              ? ` ${state.teams.find((t) => t.participantId === state.winnerId)?.displayName} vann!`
              : ''
            }
          </div>
          <button type="button" className="btn sm" onClick={doStart} disabled={busy}>
            Starta om
          </button>
          <HostTimelines teams={state.teams} />
        </div>
      ) : null}
    </div>
  );
}

// All teams' timelines (placed cards are public — face-up years), shown to the
// host so they can follow the race. Mirrors the player view's AllTimelines.
function HostTimelines({ teams }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h3 style={{ margin: 0 }}>Tidslinjer</h3>
      {(teams || []).map((t) => (
        <div key={t.participantId} className="stack" style={{ gap: 4, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
          <div className="row">
            <b className="grow">{t.displayName}</b>
            <span className="pill">{t.cardCount} kort</span>
            <span className="muted small">bonus {t.bonusCount}/3</span>
          </div>
          {(t.cards || []).length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {t.cards.map((c, i) => (
                <div key={i} style={hitsterCardStyle}>
                  <b>{c.year}</b>
                  <span className="small muted" style={{ textAlign: 'center' }}>{c.title}</span>
                </div>
              ))}
            </div>
          ) : <span className="muted small">Inga kort ännu.</span>}
        </div>
      ))}
    </div>
  );
}

const hitsterCardStyle = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
  padding: '6px 10px', borderRadius: 'var(--radius-sm, 8px)',
  border: '2px solid var(--accent)', background: 'var(--accent-soft)',
  minWidth: 64, maxWidth: 120,
};

const errorStyle = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#fee2e2', color: '#991b1b', fontWeight: 600,
};
const successStyle = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#dcfce7', color: '#166534', fontWeight: 600,
};
