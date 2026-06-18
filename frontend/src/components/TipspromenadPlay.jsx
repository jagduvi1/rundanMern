// TipspromenadPlay — a geo quiz walk. Stations are placed on a map and a
// station's question unlocks only when the player is physically within range
// (a client-side proximity HINT; the server is authoritative). On arrival we
// vibrate and reveal the question. A small MapView shows the player + stations.
//
// The React port of rundan's TipspromenadPlay.razor.
//
// Props:
//   activity   : ActivityDto — { id, randomizeQuestions, ... }.
//   participant: ParticipantDto — its id seeds the per-player shuffle.
//
// Degenerate case: a walk with no placed stations is just a quiz → render QuizPlay.
import { useEffect, useMemo, useRef, useState } from 'react';
import { getQuestions } from '../api/questions';
import { submitAnswer, getMyAnswers } from '../api/gameplay';
import { QuestionKind } from '../config/enums';
import { useGeolocation, distanceMeters } from '../utils/useGeolocation';
import { vibrate } from '../utils/vibrate';
import MapView from './MapView';
import Spinner from './Spinner';
import QuizPlay, {
  OptionButton, OptionKey, optionColor, feedbackStyle, seededShuffle,
} from './QuizPlay';

const DEFAULT_RADIUS_M = 40;
const radiusOf = (q) => (q.radiusMeters > 0 ? q.radiusMeters : DEFAULT_RADIUS_M);
const hasLocation = (q) => q.latitude != null && q.longitude != null;

// Google Maps walking directions to a station (invariant '.' decimals).
const mapsUrl = (q) =>
  `https://www.google.com/maps/dir/?api=1&destination=${q.latitude},${q.longitude}&travelmode=walking`;

export default function TipspromenadPlay({ activity, participant }) {
  const [loading, setLoading] = useState(true);
  const [questions, setQuestions] = useState([]);
  const [answered, setAnswered] = useState(() => new Map());
  const [selectedId, setSelectedId] = useState(null);
  const [selectedOptionId, setSelectedOptionId] = useState(null);
  const [freeText, setFreeText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [arrivedId, setArrivedId] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const notified = useRef(new Set()); // one-time arrival vibrate per question id
  const { coords, error: geoError, start } = useGeolocation();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        let qs = await getQuestions(activity.id);
        if (activity.randomizeQuestions) qs = seededShuffle(qs, participant?.id);
        const mine = await getMyAnswers(activity.id);
        if (!alive) return;
        setQuestions(qs);
        setAnswered(new Map(mine.map((a) => [String(a.questionId), a])));
      } catch (e) {
        if (alive) setLoadError(e?.message || 'Kunde inte ladda promenaden.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  const located = useMemo(() => {
    const l = questions.filter(hasLocation);
    return activity.randomizeQuestions ? l : l.slice().sort((a, b) => a.order - b.order);
  }, [questions, activity.randomizeQuestions]);

  const anyLocated = located.length > 0;

  // Start watching GPS once we know there are placed stations.
  useEffect(() => {
    if (anyLocated && !loading) start();
  }, [anyLocated, loading, start]);

  // Station number = rank in the host's Order sequence (1..N, gap-tolerant) — so
  // "Station 3" means the same to everyone, regardless of this player's shuffle.
  const stationNumber = (q) => questions.filter((x) => x.order < q.order).length + 1;

  // Per-question distance + nearest, recomputed whenever the fix moves.
  const { distances, nearestId } = useMemo(() => {
    const d = new Map();
    let best = null;
    let bestId = null;
    if (coords) {
      for (const q of located) {
        if (answered.has(String(q.id))) continue;
        const dist = distanceMeters(coords.lat, coords.lng, q.latitude, q.longitude);
        d.set(String(q.id), dist);
        if (best == null || dist < best) {
          best = dist;
          bestId = q.id;
        }
      }
    }
    return { distances: d, nearestId: bestId };
  }, [coords, located, answered]);

  const withinRadius = (q) => {
    const dist = distances.get(String(q.id));
    return dist != null && dist <= radiusOf(q);
  };
  // Location denied / unavailable → let the player open & answer stations manually
  // (the banner promises this; the server has no geofence, so it stays authoritative).
  const geoBlocked = !!geoError;
  const atNearest = nearestId != null
    && distances.get(String(nearestId)) != null
    && distances.get(String(nearestId)) <= radiusOf(questions.find((x) => String(x.id) === String(nearestId)) || {});

  // One-time arrival: vibrate + raise the "You've arrived!" overlay.
  useEffect(() => {
    for (const q of located) {
      if (answered.has(String(q.id))) continue;
      const dist = distances.get(String(q.id));
      if (dist != null && dist <= radiusOf(q) && !notified.current.has(String(q.id))) {
        notified.current.add(String(q.id));
        vibrate([90, 50, 140]);
        setArrivedId(q.id);
      }
    }
  }, [distances, located, answered]);

  function open(qId) {
    const q = questions.find((x) => String(x.id) === String(qId));
    if (!q) return;
    // Only opens once you're within range (or already answered) — unless location
    // is unavailable, in which case proximity can't be checked so we allow it.
    if (!answered.has(String(qId)) && !withinRadius(q) && !geoBlocked) return;
    setSelectedId(qId);
    setSelectedOptionId(null);
    setFreeText('');
    setError(null);
  }

  async function send(q, body) {
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitAnswer(activity.id, body);
      setAnswered((prev) => {
        const next = new Map(prev);
        next.set(String(q.id), {
          questionId: q.id,
          selectedOptionId: body.selectedOptionId ?? null,
          freeText: body.freeText ?? null,
          isCorrect: result.isCorrect,
          awardedPoints: result.awardedPoints,
        });
        return next;
      });
      setSelectedOptionId(null);
    } catch (e) {
      setError(e?.message || 'Kunde inte skicka svaret.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="card center muted" style={{ padding: '1.2rem' }}>
        <Spinner /> Laddar promenad…
      </div>
    );
  }
  if (loadError) {
    return <div className="card error-text">{loadError}</div>;
  }
  // A quiz-walk with no placed stations behaves like a plain quiz.
  if (!anyLocated) {
    return <QuizPlay activity={activity} participant={participant} />;
  }

  const answeredCount = located.filter((q) => answered.has(String(q.id))).length;
  const selected = selectedId != null ? questions.find((x) => String(x.id) === String(selectedId)) : null;

  // Map markers: stations (green when done) + the player's live position.
  const markers = located.map((q) => ({
    lat: q.latitude,
    lng: q.longitude,
    label: `Fråga ${q.order}`,
    color: answered.has(String(q.id)) ? '#16a34a' : '#2563eb',
  }));
  // Station geofence zones — show how close you must get to trigger each station.
  const circles = located.map((q) => ({
    lat: q.latitude,
    lng: q.longitude,
    radiusMeters: radiusOf(q),
    color: answered.has(String(q.id)) ? '#16a34a' : '#2563eb',
  }));
  const pins = coords ? [{ lat: coords.lat, lng: coords.lng }] : [];

  return (
    <div className="stack">
      <div className="card stack">
        <div className="spread">
          <span className="muted small">Stationer</span>
          <span className="small">
            <b>{answeredCount}</b> av {located.length}
          </span>
        </div>
        <GeoBanner
          geoError={geoError}
          hasFix={!!coords}
          nearest={nearestId != null ? questions.find((x) => String(x.id) === String(nearestId)) : null}
          atNearest={atNearest}
          distances={distances}
        />
        <MapView center={mapCenter(located)} markers={markers} circles={circles} pins={pins} fitToMarkers height="300px" />
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Stationer</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Gå till en station — frågan låses upp när du är inom räckhåll.
        </p>
        <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {located.map((q) => {
            const done = answered.has(String(q.id));
            const canOpen = done || withinRadius(q) || geoBlocked;
            return (
              <li key={q.id} className="row" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                <span className="grow"><b>Station {stationNumber(q)}</b></span>
                <a className="btn ghost sm" href={mapsUrl(q)} target="_blank" rel="noopener noreferrer">
                  🗺️ Karta
                </a>
                {done ? (
                  <span className="pill ok">klar</span>
                ) : canOpen ? (
                  <button className="btn sm" onClick={() => open(q.id)}>Öppna</button>
                ) : (
                  <span className="muted small">{statusText(q, distances)}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {selected ? (
        <SelectedCard
          q={selected}
          stationNumber={stationNumber(selected)}
          mine={answered.get(String(selected.id))}
          selectedOptionId={selectedOptionId}
          freeText={freeText}
          submitting={submitting}
          error={error}
          onClose={() => setSelectedId(null)}
          onPickOption={(id) => {
            setSelectedOptionId(id);
            setError(null);
          }}
          onFreeText={setFreeText}
          onSubmitChoice={() => send(selected, { questionId: selected.id, selectedOptionId })}
          onSubmitFreeText={() => send(selected, { questionId: selected.id, freeText: freeText.trim() })}
        />
      ) : null}

      {arrivedId != null ? (
        <ArrivalOverlay
          stationNumber={stationNumber(questions.find((x) => String(x.id) === String(arrivedId)) || {})}
          onDismiss={() => setArrivedId(null)}
          onOpen={() => {
            open(arrivedId);
            setArrivedId(null);
          }}
        />
      ) : null}
    </div>
  );
}

function mapCenter(located) {
  if (located.length === 0) return undefined;
  const lat = located.reduce((s, q) => s + q.latitude, 0) / located.length;
  const lng = located.reduce((s, q) => s + q.longitude, 0) / located.length;
  return [lat, lng];
}

function statusText(q, distances) {
  const dist = distances.get(String(q.id));
  return dist != null ? `${Math.round(dist)} m` : '—';
}

function GeoBanner({ geoError, hasFix, nearest, atNearest, distances }) {
  let icon = '🧭';
  let text;
  if (geoError) {
    icon = '⚠️';
    text = `${geoError} Du kan ändå trycka på en fråga för att svara.`;
  } else if (!hasFix) {
    text = 'Letar efter din position…';
  } else if (!nearest) {
    text = 'Alla frågor besvarade — fin promenad! 🎉';
  } else if (atNearest) {
    icon = '📍';
    text = `Du är vid fråga ${nearest.order} — svara nedan!`;
  } else {
    const dist = distances.get(String(nearest.id));
    text = `Närmast: fråga ${nearest.order}, cirka ${dist != null ? Math.round(dist) : 0} m bort.`;
  }
  return (
    <div
      className="row"
      style={{
        gap: 8,
        padding: '10px 12px',
        borderRadius: 'var(--radius-sm)',
        background: atNearest ? '#dcfce7' : 'var(--surface-2)',
        color: atNearest ? '#166534' : 'var(--text)',
      }}
    >
      <span aria-hidden="true">{icon}</span>
      <span className="small">{text}</span>
    </div>
  );
}

function SelectedCard({
  q, stationNumber, mine, selectedOptionId, freeText, submitting, error,
  onClose, onPickOption, onFreeText, onSubmitChoice, onSubmitFreeText,
}) {
  const isFreeText = q.kind === QuestionKind.FreeText;
  return (
    <div className="card stack">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>Fråga {stationNumber}</h2>
        <a className="btn ghost sm" href={mapsUrl(q)} target="_blank" rel="noopener noreferrer">🗺️ Karta</a>
        <button className="btn ghost sm" onClick={onClose}>Stäng</button>
      </div>
      <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>{q.text}</div>
      {q.imageUrl ? <img src={q.imageUrl} alt="" style={{ borderRadius: 'var(--radius-sm)' }} /> : null}
      {error ? <div className="error-text">{error}</div> : null}

      {isFreeText ? (
        mine ? (
          <div style={feedbackStyle(mine.isCorrect)}>
            Du svarade: <b>{mine.freeText}</b>
            <br />
            {mine.isCorrect ? `Rätt! +${mine.awardedPoints}` : 'Inte rätt.'}
          </div>
        ) : (
          <div className="stack">
            <input
              type="text"
              placeholder="Skriv ditt svar"
              value={freeText}
              onChange={(e) => onFreeText(e.target.value)}
            />
            <button className="btn block" disabled={submitting || freeText.trim().length === 0} onClick={onSubmitFreeText}>
              Skicka svar
            </button>
          </div>
        )
      ) : (
        <div className="stack">
          {(q.options || []).map((opt, i) => (
            <OptionButton
              key={opt.id}
              indexKey={OptionKey(i, q.options.length)}
              accent={optionColor(i, q.options.length)}
              text={opt.text}
              mark={mine && String(opt.id) === String(mine.selectedOptionId)
                ? (mine.isCorrect ? '✓' : '✗')
                : ''}
              state={optionStateFor(mine, opt, selectedOptionId)}
              disabled={!!mine || submitting}
              onClick={() => onPickOption(opt.id)}
            />
          ))}
          {!mine ? (
            <button className="btn block" disabled={selectedOptionId == null || submitting} onClick={onSubmitChoice}>
              Skicka svar
            </button>
          ) : (
            <div style={feedbackStyle(mine.isCorrect)}>
              {mine.isCorrect ? `Rätt! +${mine.awardedPoints}` : 'Inte den här gången.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function optionStateFor(mine, opt, selectedOptionId) {
  if (!mine) return String(selectedOptionId) === String(opt.id) ? 'selected' : '';
  if (String(opt.id) === String(mine.selectedOptionId)) return mine.isCorrect ? 'correct' : 'wrong';
  return '';
}

// Full-screen confetti reveal on arrival; tap the backdrop to dismiss.
function ArrivalOverlay({ stationNumber, onDismiss, onOpen }) {
  const colors = ['#fb7185', '#fbbf24', '#86efac', '#fff', '#bae6fd'];
  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(15,20,34,.78)',
        color: '#fff',
        textAlign: 'center',
        overflow: 'hidden',
        padding: 24,
      }}
    >
      {Array.from({ length: 14 }).map((_, c) => (
        <span
          // eslint-disable-next-line react/no-array-index-key
          key={c}
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '-10%',
            left: `${((c * 7 + 6) % 96)}%`,
            width: 10,
            height: 10,
            background: colors[c % colors.length],
            borderRadius: c % 2 === 0 ? '50%' : '3px',
            animation: 'spin 1.2s linear infinite',
            animationDelay: `${(c % 6) * 250}ms`,
            opacity: 0.9,
          }}
        />
      ))}
      <div style={{ position: 'relative' }}>
        <div style={{ fontSize: '3rem' }}>✓</div>
        <div style={{ fontSize: '1.6rem', fontWeight: 800, margin: '6px 0' }}>Framme!</div>
        <div className="muted" style={{ color: 'rgba(255,255,255,.85)' }}>Fråga {stationNumber}</div>
        <button
          className="btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          style={{ marginTop: 14, background: '#fff', color: 'var(--accent-dark)' }}
        >
          Öppna frågan
        </button>
      </div>
    </div>
  );
}
