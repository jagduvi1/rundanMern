// ImpostureHostPanel — the host's live control panel for an Imposture game.
// Polls the host view (which reveals the secret word + the impostor(s), host-only)
// and drives the round: Start → Open voting → Reveal & score. Shows the live vote
// tally and the outcome. Host-only — mounted by Activity.jsx behind canManage.
//
// Props:
//   activity : ActivityDto — reads { id }.
import { useEffect, useRef, useState } from 'react';
import {
  getImpostureHost, startImpostureRound, openImpostureVoting, revealImpostureRound,
} from '../api/imposture';
import Spinner from './Spinner';

const PHASE = { CLUES: 0, VOTING: 1, REVEALED: 2 };
const POLL_MS = 2500;

export default function ImpostureHostPanel({ activity }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const aliveRef = useRef(true);
  const pollRef = useRef(null);

  const load = async () => {
    try {
      const s = await getImpostureHost(activity.id);
      if (aliveRef.current) setState(s);
    } catch (e) {
      if (aliveRef.current) setError(e?.message || 'Kunde inte ladda.');
    }
  };

  useEffect(() => {
    aliveRef.current = true;
    (async () => { await load(); if (aliveRef.current) setLoading(false); })();
    pollRef.current = setInterval(load, POLL_MS);
    return () => { aliveRef.current = false; if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const s = await fn(activity.id);
      if (aliveRef.current) setState(s);
    } catch (e) {
      setError(e?.message || 'Något gick fel.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="card center muted"><Spinner /></div>;

  const phase = state?.phase;
  const hasRound = state && state.round > 0;

  return (
    <div className="card stack" style={{ borderColor: 'var(--accent)' }}>
      <h2 style={{ margin: 0 }}>Imposture (värd)</h2>
      <p className="muted small" style={{ margin: 0 }}>
        Starta en runda — appen väljer ett hemligt ord och utser impostorn i hemlighet. Spelarna ser sin roll på sina telefoner, ger ledord i tur och ordning, och röstar sedan i appen. Den här panelen är bara din.
      </p>
      {error ? <div className="error-text">{error}</div> : null}

      {!hasRound ? (
        <p className="muted">Ingen runda igång än. Tryck <b>Starta runda</b>.</p>
      ) : (
        <div className="card stack" style={{ background: 'var(--accent-soft, #faf7f2)', gap: 6 }}>
          <div className="row">
            <b className="grow">Runda {state.round}</b>
            <span className="pill">{phase === PHASE.CLUES ? 'Ledord' : phase === PHASE.VOTING ? 'Röstning' : 'Avslöjad'}</span>
          </div>
          <div>Hemligt ord: <b>{state.word}</b>{state.category ? <span className="muted small"> · {state.category}</span> : null}</div>
          <div>
            Impostor{(state.impostors || []).length > 1 ? 'er' : ''}:{' '}
            <b>{(state.impostors || []).map((i) => i.displayName).join(', ') || '—'}</b>
          </div>
          {state.tally ? (
            <div className="stack" style={{ gap: 2 }}>
              <span className="muted small">Röster ({state.voteCount} av {state.participantCount}):</span>
              {state.tally.map((row) => (
                <div key={row.id} className="row small">
                  <span className="grow">{row.displayName}{row.isImpostor && phase === PHASE.REVEALED ? ' 🕵️' : ''}</span>
                  <b>{row.votes}</b>
                </div>
              ))}
            </div>
          ) : null}
          {phase === PHASE.REVEALED ? (
            <span className={`pill ${state.caught ? 'ok' : 'live'}`} style={{ alignSelf: 'flex-start' }}>
              {state.caught ? 'Impostorn avslöjades!' : 'Impostorn kom undan!'}
            </span>
          ) : null}
          {phase === PHASE.REVEALED && state.guess != null ? (
            <div className="muted small">Impostorns gissning: <b>{state.guess}</b> {state.guessCorrect ? '✓' : '✗'}</div>
          ) : null}
        </div>
      )}

      <div className="row wrap" style={{ gap: '.4rem' }}>
        <button
          type="button" className="btn sm" onClick={() => act(startImpostureRound)}
          disabled={busy || (hasRound && phase !== PHASE.REVEALED)}
          title={hasRound && phase !== PHASE.REVEALED ? 'Avslöja den pågående rundan först' : undefined}
        >
          {hasRound ? '▶ Nästa runda' : '▶ Starta runda'}
        </button>
        {hasRound && phase === PHASE.CLUES ? (
          <button type="button" className="btn sm" onClick={() => act(openImpostureVoting)} disabled={busy}>Öppna röstning</button>
        ) : null}
        {hasRound && phase === PHASE.VOTING ? (
          <button type="button" className="btn sm success" onClick={() => act(revealImpostureRound)} disabled={busy}>Avslöja &amp; poängsätt</button>
        ) : null}
      </div>
    </div>
  );
}
