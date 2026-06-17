// ImpostureResults — the finished-game recap for an Imposture activity: one card
// per round showing the secret word, who the impostor was, whether they were
// caught (and by whom), and any last-chance word guess. Reads the public recap
// endpoint (revealed rounds only — nothing secret).
//
// Props:
//   activity : ActivityDto — reads { id }.
import { useEffect, useRef, useState } from 'react';
import { getImpostureRecap } from '../api/imposture';
import Spinner from './Spinner';

export default function ImpostureResults({ activity }) {
  const [rounds, setRounds] = useState(null);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    getImpostureRecap(activity.id)
      .then((r) => { if (aliveRef.current) setRounds(r?.rounds || []); })
      .catch((e) => { if (aliveRef.current) setError(e?.message || 'Kunde inte ladda resultatet.'); });
    return () => { aliveRef.current = false; };
  }, [activity.id]);

  if (error) return <div className="card error-text">{error}</div>;
  if (rounds == null) return <div className="card center muted"><Spinner /></div>;
  if (rounds.length === 0) return <div className="card muted">Inga rundor spelades den här gången.</div>;

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Rundor</h2>
      <p className="muted small" style={{ margin: 0 }}>Slutresultatet står på resultattavlan ovan — här är vad som hände varje runda.</p>
      {rounds.map((r) => (
        <div key={r.order} className="card stack" style={{ background: 'var(--surface-2, #f1f3f9)', gap: 4 }}>
          <div className="row wrap" style={{ gap: '.4rem' }}>
            <b className="grow">Runda {r.order}: {r.word}{r.category ? <span className="muted small" style={{ fontWeight: 400 }}> · {r.category}</span> : null}</b>
            <span className={`pill ${r.caught ? 'ok' : 'live'}`}>{r.caught ? 'Avslöjad' : 'Kom undan'}</span>
          </div>
          <div className="small">
            Impostor{r.impostors.length > 1 ? 'er' : ''}: <b>{r.impostors.join(', ') || '—'}</b>
          </div>
          {r.catchers.length > 0 ? (
            <div className="muted small">Avslöjades av: {r.catchers.join(', ')}</div>
          ) : (
            <div className="muted small">Ingen röstade rätt.</div>
          )}
          {r.guess != null ? (
            <div className="muted small">Impostorns gissning: <b>{r.guess}</b> {r.guessCorrect ? '✓ rätt' : '✗ fel'}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
