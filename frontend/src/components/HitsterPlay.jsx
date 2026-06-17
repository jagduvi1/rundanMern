import { useEffect, useRef, useState } from 'react';
import { getHitsterState, placeHitsterCard, submitHitsterBonus } from '../api/hitster';
import { getSocket } from '../utils/socket';
import { ServerEvents } from '../config/socketEvents';
import Spinner from './Spinner';

export default function HitsterPlay({ activity, participant }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [titleGuess, setTitleGuess] = useState('');
  const [artistGuess, setArtistGuess] = useState('');
  const [bonusResult, setBonusResult] = useState(null);
  const [bonusSubmitted, setBonusSubmitted] = useState(false);
  const [placeResult, setPlaceResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const disposedRef = useRef(false);
  const busyRef = useRef(false); // synchronous guard so a rapid double-tap can't double-submit
  const actedCardRef = useRef(null); // questionId of the card we last acted on (don't reset its result on echo)
  const myId = participant?.id || participant?._id || '';

  useEffect(() => {
    disposedRef.current = false;
    setLoading(true);
    getHitsterState(activity.id)
      .then((s) => { if (!disposedRef.current) setState(s); })
      .catch((e) => { if (!disposedRef.current) setError(e?.message || 'Kunde inte ladda spelet.'); })
      .finally(() => { if (!disposedRef.current) setLoading(false); });
    return () => { disposedRef.current = true; };
  }, [activity.id]);

  // Socket: live state changes
  useEffect(() => {
    let socket = null;
    let alive = true;
    const onUpdate = (dto) => {
      if (!alive || !dto || String(dto.activityId) !== String(activity.id)) return;
      setState(dto);
      // Only reset the guess/result UI when a FRESH card arrives for US — NOT on the
      // echo of our own bonus/place (same card), which would wipe the result we just
      // got from the HTTP response and reopen the form (then 409 on a re-tap).
      const myTurn = dto.currentTeamId && String(dto.currentTeamId) === String(myId);
      const cardId = dto.currentCard?.questionId ? String(dto.currentCard.questionId) : null;
      if (myTurn && cardId && cardId !== actedCardRef.current) {
        setPlaceResult(null);
        setBonusResult(null);
        setBonusSubmitted(false);
        setTitleGuess('');
        setArtistGuess('');
      }
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

  if (loading) {
    return <div className="card center muted"><Spinner /> Laddar Hitster…</div>;
  }
  if (error) {
    return <div className="card" style={errorBox}>{error}</div>;
  }
  if (!state || !state.started) {
    return <div className="card muted">Värden har inte startat Hitster-spelet ännu.</div>;
  }
  if (state.finished) {
    const winner = state.teams.find((t) => t.participantId === state.winnerId);
    return (
      <div className="card stack">
        <div style={successBox}>
          🏆 Spelet är slut! {winner ? `${winner.displayName} vann med ${winner.cardCount} kort!` : 'Spelet är avslutat.'}
        </div>
        <AllTimelines teams={state.teams} myId={myId} />
      </div>
    );
  }

  const myTeam = state.teams.find((t) => String(t.participantId) === String(myId));
  const isMyTurn = state.currentTeamId && String(state.currentTeamId) === String(myId);
  const currentTeam = state.teams.find((t) => t.participantId === state.currentTeamId);

  async function doBonus() {
    if (busyRef.current || bonusSubmitted) return; // ref guard blocks a rapid double-tap
    busyRef.current = true;
    actedCardRef.current = state.currentCard?.questionId ? String(state.currentCard.questionId) : null;
    setBusy(true);
    try {
      const res = await submitHitsterBonus(activity.id, titleGuess, artistGuess);
      if (!disposedRef.current) {
        setBonusResult(res.bonusResult);
        setBonusSubmitted(true);
        setState(res);
      }
    } catch (e) {
      if (!disposedRef.current) setError(e?.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function doPlace(position) {
    if (busyRef.current) return; // ref guard blocks a rapid double-tap (double-place)
    busyRef.current = true;
    actedCardRef.current = state.currentCard?.questionId ? String(state.currentCard.questionId) : null;
    setBusy(true);
    try {
      const res = await placeHitsterCard(activity.id, position);
      if (!disposedRef.current) {
        setPlaceResult(res.placeResult);
        setState(res);
      }
    } catch (e) {
      if (!disposedRef.current) setError(e?.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {/* Turn indicator */}
      <div className="card">
        <div className="row" style={{ gap: 8 }}>
          <span style={{ fontSize: '1.3rem' }}>🎵</span>
          <div className="grow">
            {isMyTurn ? (
              <b style={{ color: 'var(--accent)' }}>Din tur!</b>
            ) : (
              <span className="muted">{currentTeam?.displayName || 'Väntar…'}s tur</span>
            )}
          </div>
          <span className="muted small">{state.deckRemaining} kort kvar</span>
        </div>
      </div>

      {/* Place result feedback */}
      {placeResult ? (
        <div className="card" style={placeResult.correct ? successBox : errorBox}>
          {placeResult.correct
            ? `✓ Rätt! "${placeResult.revealedCard.title}" (${placeResult.revealedCard.year}) — kortet lades till i din tidslinje!`
            : `✗ Fel! "${placeResult.revealedCard.title}" kom ut ${placeResult.revealedCard.year} — kortet kasseras.`
          }
        </div>
      ) : null}

      {/* Active turn: bonus guess + placement */}
      {isMyTurn && state.hasCurrentCard && !placeResult ? (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>Lyssna på låten</h3>
          <p className="muted small" style={{ margin: 0 }}>
            Gissa titel och artist för bonuspoäng, sedan placera kortet på din tidslinje.
          </p>

          {/* Bonus guess */}
          {!bonusSubmitted ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <input
                  type="text"
                  className="grow"
                  placeholder="Låttitel (valfritt)"
                  value={titleGuess}
                  onChange={(e) => setTitleGuess(e.target.value)}
                />
                <input
                  type="text"
                  className="grow"
                  placeholder="Artist (valfritt)"
                  value={artistGuess}
                  onChange={(e) => setArtistGuess(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={doBonus}
                disabled={busy || (!titleGuess.trim() && !artistGuess.trim())}
              >
                Gissa bonus
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setBonusSubmitted(true)}
              >
                Skippa bonus — placera direkt
              </button>
            </div>
          ) : null}

          {/* Bonus result */}
          {bonusResult ? (
            <div className="card" style={{ background: 'var(--surface-2)', gap: 6 }}>
              <div className="stack" style={{ gap: 4 }}>
                {bonusResult.titleCorrect
                  ? <span style={{ color: 'var(--ok)' }}>✓ Titel rätt! "{bonusResult.correctTitle}"</span>
                  : bonusResult.titleGuess
                    ? <span style={{ color: 'var(--danger)' }}>✗ Titel: "{bonusResult.correctTitle}"</span>
                    : null
                }
                {bonusResult.artistCorrect
                  ? <span style={{ color: 'var(--ok)' }}>✓ Artist rätt! "{bonusResult.correctArtist}"</span>
                  : bonusResult.artistGuess
                    ? <span style={{ color: 'var(--danger)' }}>✗ Artist: "{bonusResult.correctArtist}"</span>
                    : null
                }
                {bonusResult.bonusEarned > 0
                  ? <b>+{bonusResult.bonusEarned} bonus{bonusResult.bonusCardAdded ? ' — bonuskort tillagt i din tidslinje!' : ''}</b>
                  : null
                }
              </div>
            </div>
          ) : null}

          {/* Timeline placement */}
          {bonusSubmitted ? (
            <div className="stack" style={{ gap: 8 }}>
              <h3 style={{ margin: 0 }}>Placera kortet</h3>
              <p className="muted small" style={{ margin: 0 }}>
                Tryck på rätt plats i din tidslinje — var tror du att låten kom ut?
              </p>
              <Timeline
                cards={myTeam?.cards || []}
                onPlace={doPlace}
                disabled={busy}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Waiting state for other teams */}
      {!isMyTurn && state.hasCurrentCard ? (
        <div className="card muted center">
          🎧 {currentTeam?.displayName} lyssnar och gissar…
        </div>
      ) : null}

      {/* Waiting for host to draw */}
      {isMyTurn && !state.hasCurrentCard && !placeResult ? (
        <div className="card muted center">
          Väntar på att värden drar nästa kort…
        </div>
      ) : null}

      {/* My timeline */}
      {myTeam ? (
        <div className="card stack">
          <div className="row">
            <h3 style={{ margin: 0 }} className="grow">Min tidslinje ({myTeam.cardCount} kort)</h3>
            <span className="muted small">Bonus: {myTeam.bonusCount}/3</span>
          </div>
          <TimelineDisplay cards={myTeam.cards} />
        </div>
      ) : null}

      {/* All timelines */}
      <AllTimelines teams={state.teams} myId={myId} />
    </div>
  );
}

function Timeline({ cards, onPlace, disabled }) {
  const slots = [];

  // Slot before first card
  slots.push(
    <button
      key="slot-0"
      type="button"
      className="btn ghost sm"
      style={slotStyle}
      onClick={() => onPlace(0)}
      disabled={disabled}
    >
      ← Före {cards.length > 0 ? cards[0].year : '?'}
    </button>
  );

  for (let i = 0; i < cards.length; i++) {
    slots.push(
      <div key={`card-${i}`} style={timelineCardStyle}>
        <b>{cards[i].year}</b>
        <span className="small muted" style={{ textAlign: 'center' }}>{cards[i].title}</span>
      </div>
    );

    // Slot between cards or after last
    if (i < cards.length - 1) {
      slots.push(
        <button
          key={`slot-${i + 1}`}
          type="button"
          className="btn ghost sm"
          style={slotStyle}
          onClick={() => onPlace(i + 1)}
          disabled={disabled}
        >
          Här
        </button>
      );
    } else {
      slots.push(
        <button
          key={`slot-${i + 1}`}
          type="button"
          className="btn ghost sm"
          style={slotStyle}
          onClick={() => onPlace(i + 1)}
          disabled={disabled}
        >
          Efter {cards[i].year} →
        </button>
      );
    }
  }

  if (cards.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '1rem' }}>
        <button
          type="button"
          className="btn sm success"
          onClick={() => onPlace(0)}
          disabled={disabled}
        >
          Placera här (tom tidslinje)
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
      {slots}
    </div>
  );
}

function TimelineDisplay({ cards }) {
  if (cards.length === 0) {
    return <span className="muted">Inga kort ännu.</span>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'stretch' }}>
      {cards.map((c, i) => (
        <div key={i} style={timelineCardStyle}>
          <b>{c.year}</b>
          <span className="small muted" style={{ textAlign: 'center' }}>{c.title}</span>
        </div>
      ))}
    </div>
  );
}

function AllTimelines({ teams, myId }) {
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Alla lag</h3>
      {teams.map((t) => (
        <div key={t.participantId} className="stack" style={{ gap: 4, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
          <div className="row">
            <b className="grow">
              {t.displayName}
              {String(t.participantId) === String(myId) ? ' (du)' : ''}
            </b>
            <span className="muted small">{t.cardCount} kort · bonus {t.bonusCount}/3</span>
          </div>
          <TimelineDisplay cards={t.cards} />
        </div>
      ))}
    </div>
  );
}

const timelineCardStyle = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  padding: '8px 12px',
  borderRadius: 'var(--radius-sm, 8px)',
  border: '2px solid var(--accent)',
  background: 'var(--accent-soft)',
  minWidth: 70,
  maxWidth: 120,
};

const slotStyle = {
  minWidth: 60,
  padding: '6px 10px',
  fontSize: '.8rem',
  border: '2px dashed var(--border)',
  borderRadius: 'var(--radius-sm, 8px)',
};

const errorBox = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#fee2e2', color: '#991b1b', fontWeight: 600,
};
const successBox = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#dcfce7', color: '#166534', fontWeight: 600,
};
