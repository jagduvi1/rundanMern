// WordGamePlay — a timed letter-tile word builder. Open up to N of the 20
// face-down tiles, build the longest valid word before the timer expires; the
// longest word wins. Local countdown; auto-submits on timeout when the typed word
// is valid. The word is validated client-side (server re-validates).
//
// The React port of rundan's WordGamePlay.razor.
//
// Props:
//   activity   : ActivityDto — { id, ... }.
//   participant: ParticipantDto — the team identity (tiles are fixed per team).
//
// WordGameDto: { tiles:[20 letters], maxOpen, seconds, submittedWord?, submittedScore? }
import { useEffect, useRef, useState } from 'react';
import { getWordGame, submitWord } from '../api/games';
import { ApiError } from '../api/client';
import Spinner from './Spinner';

export default function WordGamePlay({ activity, participant }) {
  const [game, setGame] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [opened, setOpened] = useState(() => new Set()); // tile indices face-up
  const [word, setWord] = useState('');
  const [started, setStarted] = useState(false);
  const [timeUp, setTimeUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [remaining, setRemaining] = useState(0);

  const tickRef = useRef(null);
  const aliveRef = useRef(true);
  // Latest validity/state for the timeout auto-submit (avoids stale closures).
  const stateRef = useRef({ opened, word, submitted: false });

  const cleanWord = (word || '').trim().toUpperCase();

  // Letters available from the opened tiles (with multiplicity).
  function openedLetters() {
    if (!game) return [];
    return [...opened].map((i) => (game.tiles[i] || '')[0]).filter(Boolean);
  }

  // Can `cleanWord` be spelled from the opened letters, honoring counts?
  function wordValid() {
    const w = cleanWord;
    if (w.length === 0) return false;
    const avail = new Map();
    for (const c of openedLetters()) avail.set(c, (avail.get(c) || 0) + 1);
    for (const c of w) {
      const n = avail.get(c) || 0;
      if (n === 0) return false;
      avail.set(c, n - 1);
    }
    return true;
  }

  const valid = wordValid();
  stateRef.current = { opened, word, submitted: game?.submittedScore != null };

  // Load (tiles are deterministic per team — refetching never reshuffles).
  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    setError(null);
    getWordGame(activity.id)
      .then((dto) => {
        if (aliveRef.current) setGame(dto);
      })
      .catch((e) => {
        if (aliveRef.current && !(e instanceof ApiError && e.status === 404)) {
          setError(e?.message || 'Kunde inte ladda ordspelet.');
        }
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
    return () => {
      aliveRef.current = false;
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [activity.id]);

  async function doSubmit() {
    // Read latest validity from refs (the timeout path can call this).
    if (stateRef.current.submitted) return;
    const w = (stateRef.current.word || '').trim().toUpperCase();
    if (submitting || w.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await submitWord(activity.id, [...stateRef.current.opened], w);
      if (aliveRef.current) setGame(updated);
    } catch (e) {
      if (aliveRef.current) setError(e?.message || 'Kunde inte skicka ordet.');
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }

  function start() {
    if (!game) return;
    setStarted(true);
    setRemaining(game.seconds);
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(tickRef.current);
          tickRef.current = null;
          setTimeUp(true);
          // Auto-submit on timeout if the current word is valid.
          if (aliveRef.current && !stateRef.current.submitted) {
            const w = (stateRef.current.word || '').trim().toUpperCase();
            const avail = new Map();
            for (const i of stateRef.current.opened) {
              const c = (game.tiles[i] || '')[0];
              if (c) avail.set(c, (avail.get(c) || 0) + 1);
            }
            let ok = w.length > 0;
            for (const c of w) {
              const n = avail.get(c) || 0;
              if (n === 0) { ok = false; break; }
              avail.set(c, n - 1);
            }
            if (ok) doSubmit();
          }
          return 0;
        }
        return r - 1;
      });
    }, 1000);
  }

  function toggleTile(i) {
    if (!game || timeUp || submitting) return;
    setOpened((prev) => {
      if (prev.has(i) || prev.size >= game.maxOpen) return prev;
      const next = new Set(prev);
      next.add(i);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="card center muted" style={{ padding: '1.2rem' }}>
        <Spinner />
      </div>
    );
  }
  if (!game) {
    return <div className="card muted">{error || 'Kunde inte ladda ordspelet.'}</div>;
  }

  // Already played → show the prior submission.
  if (game.submittedScore != null) {
    return (
      <div className="card stack center" style={{ background: '#dcfce7', color: '#166534' }}>
        <h2 style={{ margin: 0 }}>Ditt ord</h2>
        <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{game.submittedWord}</div>
        <p style={{ margin: 0 }}>
          {game.submittedScore} bokstav{game.submittedScore === 1 ? '' : 'er'} — längsta ordet vinner.
        </p>
      </div>
    );
  }

  const wordStatus = cleanWord.length === 0
    ? 'Skriv ett ord med dina öppnade bokstäver.'
    : valid
      ? `${cleanWord.length} bokstäver`
      : 'Använder bokstäver du inte har öppnat.';

  return (
    <div className="card stack">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>Ordbygge</h2>
        {started ? (
          <span className={`pill ${remaining <= 10 ? 'live' : 'accent'}`}>{remaining} s</span>
        ) : null}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Öppna upp till {game.maxOpen} av de 20 brickorna och bygg det längsta ord du kan.
        Du har {game.seconds} sekunder.
      </p>

      {error ? <div style={errorBox}>{error}</div> : null}

      {!started ? (
        <button className="btn block success" onClick={start}>
          Starta ({game.seconds} s)
        </button>
      ) : (
        <>
          <div style={tilesGrid}>
            {game.tiles.map((t, i) => {
              const open = opened.has(i);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggleTile(i)}
                  disabled={open || timeUp || opened.size >= game.maxOpen || submitting}
                  style={tileStyle(open)}
                >
                  {open ? t : '?'}
                </button>
              );
            })}
          </div>
          <div className="muted">Öppnade {opened.size} / {game.maxOpen}</div>

          <input
            type="text"
            placeholder="Ditt ord"
            maxLength={20}
            value={word}
            onChange={(e) => setWord(e.target.value)}
            disabled={timeUp || submitting}
          />
          <div className="muted" style={{ fontSize: '.85rem' }}>{wordStatus}</div>

          <button
            className="btn block success"
            onClick={doSubmit}
            disabled={submitting || !valid}
          >
            Skicka ord ({cleanWord.length} bokstav{cleanWord.length === 1 ? '' : 'er'})
          </button>

          {timeUp ? <p className="muted" style={{ margin: 0 }}>Tiden är ute!</p> : null}
        </>
      )}
    </div>
  );
}

const tilesGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(5, 1fr)',
  gap: 6,
};
function tileStyle(open) {
  return {
    minHeight: 48,
    borderRadius: 'var(--radius-sm, 8px)',
    fontWeight: 800,
    fontSize: '1.1rem',
    textTransform: 'uppercase',
    border: `2px solid ${open ? 'var(--accent)' : 'var(--border)'}`,
    background: open ? 'var(--accent-soft)' : 'var(--surface)',
    color: 'var(--text)',
    cursor: open ? 'default' : 'pointer',
  };
}
const errorBox = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#fee2e2', color: '#991b1b', fontWeight: 600,
};
