// MapPinPlay — "Pin the city". For each drawn city, drop a pin on a map where you
// think it is; the server reveals the real spot + distance. Lowest total distance
// wins. Sequential, city by city.
//
// The React port of rundan's MapPinPlay.razor, rebuilt on the shared <MapView>
// with the `noLabels` option so it serves CARTO `light_nolabels` tiles (no place
// names) and clamps the zoom — players can't read the city's name off the map or
// zoom into street detail to cheat, matching the original. The reveal (real
// location marker + distance) and the lowest-total-wins flow are faithful.
//
// Props:
//   activity   : ActivityDto — { id, ... }.
//   participant: ParticipantDto — the player identity (token attribution).
//
// MapCityDto:       { id, order, name, pinned, distanceKm? }
// MapPinResultDto:  { distanceKm, realLat, realLng }  (also { cityId })
import { useEffect, useState } from 'react';
import { getCities, pinCity } from '../api/games';
import { ApiError } from '../api/client';
import { num } from '../utils/format';
import MapView from './MapView';
import Spinner from './Spinner';

const SWEDEN_CENTER = [62.5, 16.5];
const SWEDEN_ZOOM = 4;

export default function MapPinPlay({ activity, participant }) {
  const [cities, setCities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [currentId, setCurrentId] = useState(null); // city being pinned
  const [pin, setPin] = useState(null); // { lat, lng } guess
  const [result, setResult] = useState(null); // { distanceKm, realLat, realLng }
  const [busy, setBusy] = useState(false);

  // Load the drawn cities; the current city is the first not-yet-pinned one.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getCities(activity.id)
      .then((list) => {
        if (!alive) return;
        const arr = Array.isArray(list) ? list : [];
        setCities(arr);
        const next = arr.find((c) => !c.pinned);
        setCurrentId(next ? next.id : null);
      })
      .catch((e) => {
        if (alive && !(e instanceof ApiError && e.status === 404)) {
          setError(e?.message || 'Kunde inte ladda städerna.');
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activity.id]);

  const current = cities.find((c) => String(c.id) === String(currentId)) || null;
  const allPinned = cities.length > 0 && cities.every((c) => c.pinned);
  const totalKm = cities
    .filter((c) => c.distanceKm != null)
    .reduce((s, c) => s + c.distanceKm, 0);

  function onMapClick({ lat, lng }) {
    // Ignore clicks while submitting or after the answer is revealed.
    if (busy || result) return;
    setPin({ lat, lng });
  }

  async function submit() {
    if (!pin || !current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await pinCity(activity.id, current.id, pin.lat, pin.lng);
      setResult(res);
      setCities((prev) =>
        prev.map((c) => (String(c.id) === String(current.id)
          ? { ...c, pinned: true, distanceKm: res.distanceKm }
          : c)));
    } catch (e) {
      setError(e?.message || 'Kunde inte registrera nålen.');
    } finally {
      setBusy(false);
    }
  }

  function next() {
    setResult(null);
    setPin(null);
    const upcoming = cities.find((c) => !c.pinned);
    setCurrentId(upcoming ? upcoming.id : null);
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Sätt nålen</h2>

      {error ? <div style={errorBox}>{error}</div> : null}

      {loading ? (
        <div className="center muted" style={{ padding: '1rem' }}>
          <Spinner />
        </div>
      ) : current ? (
        <>
          <p className="muted" style={{ margin: 0 }}>
            Stad {current.order + 1} av {cities.length} — sätt en nål där du tror att{' '}
            <b style={{ color: 'var(--text)' }}>{current.name}</b> ligger.
          </p>

          <MapView
            center={result ? [result.realLat, result.realLng] : SWEDEN_CENTER}
            zoom={SWEDEN_ZOOM}
            height="380px"
            onMapClick={onMapClick}
            pins={pin ? [{ lat: pin.lat, lng: pin.lng }] : []}
            markers={result ? [{ lat: result.realLat, lng: result.realLng, label: current.name, color: '#16a34a' }] : []}
            fitToMarkers={!!result && !!pin}
            fitMaxZoom={9}
            noLabels
          />

          {!result ? (
            <button className="btn block success" onClick={submit} disabled={!pin || busy}>
              {!pin ? 'Tryck på kartan för att sätta din nål' : busy ? 'Kollar…' : `Lås in ${current.name}`}
            </button>
          ) : (
            <>
              <div style={infoBox}>
                <b>{current.name}</b> är den gröna pricken — du var <b>{num(result.distanceKm)} km</b> bort.
              </div>
              <button className="btn block soft" onClick={next}>
                {allPinned ? 'Slutför' : 'Nästa stad →'}
              </button>
            </>
          )}
        </>
      ) : allPinned ? (
        <div style={successBox}>
          Alla {cities.length} städer är satta! Din totala sträcka är <b>{num(totalKm)} km</b> —
          lägst total vinner, se poängtavlan ovan.
        </div>
      ) : (
        <div className="center muted">Inga städer än — värden drar dem när spelet öppnar.</div>
      )}
    </div>
  );
}

const infoBox = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: 'var(--accent-soft)', color: 'var(--accent-dark)',
  border: '1px solid var(--accent)',
};
const successBox = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#dcfce7', color: '#166534', fontWeight: 600,
};
const errorBox = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#fee2e2', color: '#991b1b', fontWeight: 600,
};
