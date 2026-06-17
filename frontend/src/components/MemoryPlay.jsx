// MemoryPlay — a card-flip pairs game. The team races its own board of text
// pairs (dealt shuffled by the server) and records time (or flip count) as a
// lowest-wins score. All game logic is client-side; only the final score posts.
//
// The React port of rundan's MemoryPlay.razor. The board comes pre-shuffled from
// the server (per request), so there's no client-side seeded shuffle here —
// matching keys on `pairId`, not the visible text, so duplicate labels stay
// distinct, winnable pairs.
//
// Props:
//   activity   : ActivityDto — { id, measurement, measuresTime, ... }.
//   participant: ParticipantDto — { id, displayName } (the team identity).
//
// Memory board: { pairCount, cards: [{ position, pairId, text }] }
import { useEffect, useRef, useState } from 'react';
import { getMemoryBoard, submitMemoryResult } from '../api/games';
import { Measurement } from '../config/enums';
import { ApiError } from '../api/client';
import Spinner from './Spinner';

const FLIP_BACK_MS = 850; // how long a mismatched pair stays face-up

// "m:ss" (seconds zero-padded).
function clock(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const colsFor = (n) => (n <= 8 ? 4 : n <= 18 ? 4 : n <= 30 ? 5 : 6);

export default function MemoryPlay({ activity, participant }) {
  const measuresTime = activity.measurement === Measurement.TimeSeconds;

  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState([]); // [{ pairId, text, state }] in deal order
  const [pairCount, setPairCount] = useState(0);
  const [matched, setMatched] = useState(() => new Set()); // matched pairIds
  const [flips, setFlips] = useState(0);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [submitting, setSubmitting] = useState(false); // final-score POST in flight

  const flippedRef = useRef([]); // indices currently face-up (max 2)
  const startRef = useRef(null); // ms timestamp of the first flip
  const tickRef = useRef(null); // interval id
  const aliveRef = useRef(true);
  const finalFlipsRef = useRef(0); // captured flip count, so we can retry a failed submit

  // Build the board state from the server's dealt cards.
  function build(dealt) {
    return dealt
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((c) => ({ pairId: String(c.pairId), text: c.text, state: 'down' }));
  }

  // Initial load.
  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    setError(null);
    getMemoryBoard(activity.id)
      .then((board) => {
        if (!aliveRef.current) return;
        const dealt = board?.cards || [];
        setCards(build(dealt));
        setPairCount(board?.pairCount ?? dealt.length / 2);
      })
      .catch((e) => {
        if (aliveRef.current && !(e instanceof ApiError && e.status === 404)) {
          setError(e?.message || 'Kunde inte ladda korten.');
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

  function ensureTicking() {
    if (tickRef.current || !measuresTime) return;
    tickRef.current = setInterval(() => {
      if (startRef.current != null) setElapsed((Date.now() - startRef.current) / 1000);
    }, 500);
  }
  function stopTicking() {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }

  async function finish(finalFlips) {
    stopTicking();
    finalFlipsRef.current = finalFlips;
    const seconds = startRef.current != null ? Math.round((Date.now() - startRef.current) / 1000) : 0;
    setSubmitting(true);
    setError(null);
    try {
      // Backend reads `time` (seconds) for time games; `flips` otherwise. We send
      // both `time` and `seconds` so the score lands regardless of which key the
      // server keys on (see the contract note in the summary).
      await submitMemoryResult(activity.id, { time: seconds, seconds, flips: finalFlips });
      // Only mark "done" once the score is safely recorded — otherwise a transient
      // failure would lock the board and silently drop the team's completed score.
      if (aliveRef.current) setDone(true);
    } catch (e) {
      if (aliveRef.current) setError(e?.message || 'Kunde inte spara resultatet — försök igen.');
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }

  function flip(idx) {
    if (busy || done || submitting) return;
    if (cards[idx].state !== 'down' || flippedRef.current.length >= 2) return;

    // Start the clock on the very first flip.
    if (startRef.current == null) {
      startRef.current = Date.now();
      ensureTicking();
    }

    const nextFlips = flips + 1;
    setFlips(nextFlips);

    const open = (board) => board.map((c, i) => (i === idx ? { ...c, state: 'up' } : c));
    flippedRef.current = [...flippedRef.current, idx];

    if (flippedRef.current.length < 2) {
      setCards(open);
      return;
    }

    // Two up — resolve match/mismatch.
    const [a, b] = flippedRef.current;
    const cardA = cards[a];
    const cardB = cards[b];
    if (cardA.pairId === cardB.pairId) {
      const newMatched = new Set(matched);
      newMatched.add(cardA.pairId);
      setMatched(newMatched);
      flippedRef.current = [];
      setCards((board) =>
        board.map((c, i) => (i === a || i === b ? { ...c, state: 'matched' } : c)));
      if (newMatched.size >= pairCount) finish(nextFlips);
    } else {
      // Show both, then flip back after a beat.
      setBusy(true);
      setCards(open);
      setTimeout(() => {
        if (!aliveRef.current) return;
        flippedRef.current = [];
        setCards((board) =>
          board.map((c, i) => (i === a || i === b ? { ...c, state: 'down' } : c)));
        setBusy(false);
      }, FLIP_BACK_MS);
    }
  }

  function reset() {
    stopTicking();
    flippedRef.current = [];
    startRef.current = null;
    setMatched(new Set());
    setFlips(0);
    setElapsed(0);
    setDone(false);
    setError(null);
    setCards((board) => board.map((c) => ({ ...c, state: 'down' })));
  }

  if (loading) {
    return (
      <div className="card center muted" style={{ padding: '1.2rem' }}>
        <Spinner /> Blandar…
      </div>
    );
  }
  if (cards.length === 0) {
    return <div className="card muted">{error || 'Inga kort än — värden förbereder fortfarande.'}</div>;
  }

  const cols = colsFor(cards.length);
  const resultText = measuresTime ? `tid ${clock(elapsed)}` : `${flips} vändningar`;

  return (
    <div className="card stack">
      <div className="row" style={{ fontSize: '.9rem' }}>
        <span className="grow muted">
          Par: <b>{matched.size}</b> / {pairCount}
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {measuresTime ? clock(elapsed) : `${flips} vändningar`}
        </span>
      </div>

      {error ? <div style={errorBox}>{error}</div> : null}
      {error && !done ? (
        <button type="button" className="btn sm" onClick={() => finish(finalFlipsRef.current)} disabled={submitting}>
          {submitting ? 'Sparar…' : 'Försök igen'}
        </button>
      ) : null}
      {submitting && !error ? <div className="muted small">Sparar resultatet…</div> : null}
      {done ? (
        <div style={successBox}>🎉 Klart! {resultText} — registrerat för ditt lag.</div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 6 }}>
        {cards.map((c, i) => (
          <button
            key={i}
            type="button"
            onClick={() => flip(i)}
            disabled={busy || done || submitting || c.state !== 'down'}
            style={cardStyle(c.state)}
          >
            <span>{c.state === 'down' ? '' : c.text}</span>
          </button>
        ))}
      </div>

      {!done ? (
        <button className="btn ghost sm" onClick={reset} disabled={busy || submitting}>
          Blanda och börja om
        </button>
      ) : null}
    </div>
  );
}

function cardStyle(state) {
  const base = {
    minHeight: 56,
    borderRadius: 'var(--radius-sm, 8px)',
    fontWeight: 700,
    fontSize: '.85rem',
    display: 'grid',
    placeItems: 'center',
    padding: 4,
    cursor: state === 'down' ? 'pointer' : 'default',
    transition: 'background .15s, border-color .15s',
    wordBreak: 'break-word',
    textAlign: 'center',
  };
  if (state === 'matched') {
    return { ...base, border: '2px solid #16a34a', background: '#dcfce7', color: '#166534' };
  }
  if (state === 'up') {
    return { ...base, border: '2px solid var(--accent)', background: 'var(--accent-soft)', color: 'var(--text)' };
  }
  return { ...base, border: '2px solid var(--border)', background: 'var(--accent)', color: 'transparent' };
}

const errorBox = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#fee2e2', color: '#991b1b', fontWeight: 600,
};
const successBox = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#dcfce7', color: '#166534', fontWeight: 600,
};
