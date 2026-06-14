// StationsEditor — geofencing UI for a Tipspromenad. The React port of rundan's
// StationsEditor.razor. Set how many stations the walk has (setStationCount), then
// drop each on a map (LocationPicker, inline per station). DELIBERATELY shows no
// question text — stations are normalized to "#1 … #N"; content is authored in the
// sibling QuestionEditor.
//
// Props:
//   activity  : ActivityDto — { id, ... }.
//   onChanged : () => void — called after any mutation so the parent refreshes the
//               sibling QuestionEditor (Manage remounts both via a key bump).
import { useEffect, useRef, useState } from 'react';
import { setStationCount, setQuestionLocation, deleteQuestion, getAdminQuestions } from '../api/questions';
import { QuestionKind } from '../config/enums';
import Spinner from './Spinner';
import LocationPicker from './LocationPicker';

const hasLocation = (q) => q?.latitude != null && q?.longitude != null;

function isComplete(q) {
  if (!q) return false;
  if (q.hidden) return true;
  if (!q.text || !q.text.trim()) return false;
  if (q.kind === QuestionKind.FreeText) return !!(q.acceptedFreeTextAnswer && q.acceptedFreeTextAnswer.trim());
  const opts = q.options || [];
  return opts.length >= 2 && opts.filter((o) => o.isCorrect).length === 1 && opts.every((o) => o.text && o.text.trim());
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export default function StationsEditor({ activity, onChanged }) {
  const [questions, setQuestions] = useState([]);
  const [targetCount, setTargetCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [trimNote, setTrimNote] = useState(null);

  // Inline spot editor (one open at a time).
  const [spotEditId, setSpotEditId] = useState(null);
  const [spot, setSpot] = useState({ lat: null, lng: null, radius: 25 });

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const reload = async () => {
    try {
      const list = await getAdminQuestions(activity.id);
      if (!aliveRef.current) return;
      setQuestions(list || []);
      setTargetCount((list || []).length);
    } catch (e) {
      if (aliveRef.current) setError(e?.message || 'Kunde inte ladda stationerna.');
    }
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      await reload();
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  const notifyChanged = () => { onChanged?.(); };

  const placed = questions.filter(hasLocation).length;
  const need = questions.filter((q) => !isComplete(q)).length;
  const summaryText = `${placed}/${questions.length} placerade${need > 0 ? ` · ${need} behöver fråga` : ''}`;

  async function applyCount() {
    setBusy(true);
    setError(null);
    setTrimNote(null);
    const requested = clamp(targetCount, 0, 100);
    try {
      const list = await setStationCount(activity.id, requested);
      if (aliveRef.current) {
        setQuestions(list || []);
        setTargetCount((list || []).length);
        if ((list || []).length > requested) {
          setTrimNote('Behöll stationerna som redan har en fråga — ta bort dem en och en med ✕.');
        }
      }
      notifyChanged();
    } catch (e) {
      setError(e?.message || 'Kunde inte ändra antalet stationer.');
    } finally {
      setBusy(false);
    }
  }

  function toggleSpot(q) {
    if (spotEditId === q.id) {
      setSpotEditId(null);
      return;
    }
    setSpotEditId(q.id);
    setSpot({ lat: q.latitude ?? null, lng: q.longitude ?? null, radius: q.radiusMeters ?? 25 });
  }

  async function saveSpot(q) {
    setBusy(true);
    setError(null);
    try {
      await setQuestionLocation(activity.id, q.id, spot.lat, spot.lng, spot.radius);
      setSpotEditId(null);
      await reload();
      notifyChanged();
    } catch (e) {
      setError(e?.message || 'Kunde inte spara platsen.');
    } finally {
      setBusy(false);
    }
  }

  async function clearSpot(q) {
    setBusy(true);
    setError(null);
    try {
      await setQuestionLocation(activity.id, q.id, null, null, null);
      setSpotEditId(null);
      await reload();
      notifyChanged();
    } catch (e) {
      setError(e?.message || 'Kunde inte rensa platsen.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(q) {
    setBusy(true);
    setError(null);
    try {
      await deleteQuestion(activity.id, q.id);
      await reload();
      notifyChanged();
    } catch (e) {
      setError(e?.message || 'Kunde inte ta bort stationen.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="card center muted"><Spinner /></div>;
  }

  return (
    <div className="card stack">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>Stationer ({questions.length})</h2>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Sätt hur många stationer rundan har, släpp sedan ut var och en på kartan. Varje station låses upp på en spelares telefon när de kommer fram. Själva frågorna skrivs nedan — de är dolda här med flit.
      </p>

      {error ? <div className="error-text">{error}</div> : null}

      <div className="row wrap" style={{ alignItems: 'flex-end', gap: '.6rem' }}>
        <div className="field" style={{ width: 160, margin: 0 }}>
          <label>Antal stationer</label>
          <input type="number" min={0} max={100} value={targetCount} onChange={(e) => setTargetCount(Number(e.target.value))} />
        </div>
        <button type="button" className="btn success" onClick={applyCount} disabled={busy || targetCount === questions.length}>
          Tillämpa
        </button>
        <span className="grow" />
        <span className="muted small">{summaryText}</span>
      </div>

      {trimNote ? <div className="card" style={{ margin: 0, background: 'var(--accent-soft, #f3f4f6)' }}><span className="muted small">{trimNote}</span></div> : null}

      {questions.length === 0 ? (
        <p className="muted">Inga stationer än — sätt ett antal ovan för att skapa dem.</p>
      ) : (
        <ul style={listStyle}>
          {questions.map((q, idx) => (
            <li key={q.id} style={rowStyle}>
              <span className="grow">
                <b>#{idx + 1}</b>
                <span className="muted" style={{ fontSize: '.78rem' }}>
                  {hasLocation(q) ? ` · placerad · ${q.radiusMeters ?? 25} m` : ' · ingen plats än'}
                </span>
              </span>

              {!isComplete(q) ? <span className="pill warn" title="Den här stationen behöver fortfarande en fråga">behöver fråga</span> : null}
              {hasLocation(q) ? <span className="pill live">placerad</span> : null}

              <button type="button" className="btn ghost sm" onClick={() => toggleSpot(q)} disabled={busy}>
                {spotEditId === q.id ? 'Stäng' : hasLocation(q) ? 'Ändra plats' : 'Sätt plats'}
              </button>
              <button type="button" className="btn ghost sm danger" onClick={() => remove(q)} disabled={busy} title="Ta bort den här stationen">✕</button>

              {spotEditId === q.id ? (
                <div style={{ flexBasis: '100%', marginTop: '.5rem' }}>
                  <LocationPicker
                    key={q.id}
                    lat={spot.lat}
                    lng={spot.lng}
                    radius={spot.radius}
                    onChange={({ lat, lng, radius }) => setSpot({ lat, lng, radius })}
                  />
                  <div className="row" style={{ marginTop: '.4rem' }}>
                    <button type="button" className="btn sm success" onClick={() => saveSpot(q)} disabled={busy || spot.lat == null}>Spara plats</button>
                    <button type="button" className="btn sm ghost" onClick={() => setSpotEditId(null)}>Avbryt</button>
                    {hasLocation(q) ? (
                      <button type="button" className="btn sm ghost danger" onClick={() => clearSpot(q)} disabled={busy}>Ta bort plats</button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const listStyle = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 };
const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
