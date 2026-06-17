// ImposturePlay — the player view of an Imposture game. Polls the per-player role
// endpoint and renders by phase: see your role (secret word, or "you're the
// impostor" + optional category) → vote for who you think the impostor is →
// see the reveal + your points (and, for a caught impostor in the +Guess scheme,
// a last-chance word guess).
//
// Props:
//   activity    : ActivityDto — reads { id }.
//   participant : the player's session.
import { useEffect, useRef, useState } from 'react';
import { getImpostureMe, castImpostureVote, guessImpostureWord } from '../api/imposture';
import { OptionButton, OptionKey, optionColor, feedbackStyle } from './QuizPlay';
import Spinner from './Spinner';

const PHASE = { CLUES: 0, VOTING: 1, REVEALED: 2 };
const POLL_MS = 2500;

export default function ImposturePlay({ activity }) {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [voteBusy, setVoteBusy] = useState(false);
  const [guess, setGuess] = useState('');
  const [guessBusy, setGuessBusy] = useState(false);

  const aliveRef = useRef(true);
  const pollRef = useRef(null);

  const load = async () => {
    try {
      const s = await getImpostureMe(activity.id);
      if (aliveRef.current) setMe(s);
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

  const vote = async (candidateId) => {
    setVoteBusy(true);
    setError(null);
    try {
      await castImpostureVote(activity.id, candidateId);
      await load();
    } catch (e) {
      setError(e?.message || 'Kunde inte rösta.');
    } finally {
      setVoteBusy(false);
    }
  };

  const submitGuess = async () => {
    if (!guess.trim()) return;
    setGuessBusy(true);
    setError(null);
    try {
      await guessImpostureWord(activity.id, guess.trim());
      await load();
    } catch (e) {
      setError(e?.message || 'Kunde inte gissa.');
    } finally {
      setGuessBusy(false);
    }
  };

  if (loading) return <div className="card center muted" style={{ padding: '1.2rem' }}><Spinner /> Laddar…</div>;

  const phase = me?.phase;
  if (!me || me.round === 0 || phase == null) {
    return (
      <div className="stack">
        {error ? <div className="error-text">{error}</div> : null}
        <div className="card center muted" style={{ padding: '1.1rem' }}>
          <Spinner /> Väntar på att värden ska starta en runda…
        </div>
      </div>
    );
  }

  const roleCard = (
    <div className="card stack" style={{ borderColor: me.isImpostor ? 'var(--danger)' : 'var(--accent)' }}>
      <b>Runda {me.round}</b>
      {me.isImpostor ? (
        <>
          <div style={{ fontSize: '1.2rem' }}>🕵️ <b>Du är impostorn!</b></div>
          <p className="muted small" style={{ margin: 0 }}>
            Du vet inte ordet. Lyssna på de andras ledord och bluffa dig igenom — säg något som passar in utan att avslöja att du inte vet.
            {me.category ? <> Kategori: <b>{me.category}</b>.</> : null}
          </p>
        </>
      ) : (
        <>
          <div>Hemligt ord: <b style={{ fontSize: '1.2rem' }}>{me.word}</b></div>
          {me.category ? <div className="muted small">Kategori: {me.category}</div> : null}
          <p className="muted small" style={{ margin: 0 }}>
            Säg ETT ledord om ordet när det är din tur — tydligt nog att visa att du vet, utan att avslöja det.
          </p>
        </>
      )}
    </div>
  );

  if (phase === PHASE.CLUES) {
    return (
      <div className="stack">
        {roleCard}
        {error ? <div className="error-text">{error}</div> : null}
        <div className="card center muted small">Ge era ledord i tur och ordning — vänta på att värden öppnar röstningen.</div>
      </div>
    );
  }

  if (phase === PHASE.VOTING) {
    const candidates = me.candidates || [];
    const votedName = (candidates.find((c) => c.id === me.myVote) || {}).displayName;
    return (
      <div className="stack">
        {roleCard}
        {error ? <div className="error-text">{error}</div> : null}
        <div className="card stack">
          <b>Vem är impostorn?</b>
          {me.myVote ? (
            <div style={feedbackStyle(true)}>
              Du röstade på <b>{votedName || 'din gissning'}</b>. Du kan ändra tills värden avslöjar.
            </div>
          ) : null}
          <div className="stack" style={{ gap: '.3rem' }}>
            {candidates.map((c, i) => (
              <OptionButton
                key={c.id}
                indexKey={OptionKey(i, candidates.length)}
                accent={optionColor(i, candidates.length)}
                text={c.displayName}
                mark={me.myVote === c.id ? '✓' : ''}
                state={me.myVote === c.id ? 'selected' : ''}
                disabled={voteBusy}
                onClick={() => vote(c.id)}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // REVEALED
  return (
    <div className="stack">
      <div style={feedbackStyle((me.myRoundPoints || 0) > 0)}>
        <div>Det hemliga ordet var <b>{me.word}</b>.</div>
        <div>
          Impostor{(me.impostors || []).length > 1 ? 'er' : ''}: <b>{(me.impostors || []).join(', ')}</b>
          {' — '}{me.caught ? 'avslöjad!' : 'kom undan!'}
        </div>
        {me.isImpostor ? (
          <div style={{ marginTop: '.25rem' }}>{me.caught ? 'Du blev avslöjad.' : 'Du lurade dem!'}</div>
        ) : (
          <div style={{ marginTop: '.25rem' }}>Din röst: {me.myVoteCorrect ? 'rätt ✓' : 'fel ✗'}</div>
        )}
        <div style={{ marginTop: '.25rem' }}><b>+{me.myRoundPoints || 0}</b> den här rundan</div>
      </div>
      {error ? <div className="error-text">{error}</div> : null}

      {me.canGuess ? (
        <div className="card stack">
          <b>Sista chansen: gissa ordet</b>
          <p className="muted small" style={{ margin: 0 }}>Du blev avslöjad — gissar du det hemliga ordet rätt får du bonuspoäng.</p>
          <div className="row" style={{ gap: '.4rem' }}>
            <input
              className="grow" type="text" placeholder="Ordet…" value={guess}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitGuess(); }}
            />
            <button type="button" className="btn sm" onClick={submitGuess} disabled={guessBusy || !guess.trim()}>Gissa</button>
          </div>
        </div>
      ) : me.isImpostor && me.guess != null ? (
        <div className="card muted small">Din gissning: <b>{me.guess}</b> {me.guessCorrect ? '✓ rätt — bonus!' : '✗ fel'}</div>
      ) : null}

      <div className="card center muted small">Vänta på att värden startar nästa runda.</div>
    </div>
  );
}
