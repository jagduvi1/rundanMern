// LocationPicker — drop a GPS pin on a map and choose a radius. The React port of
// rundan's LocationPicker.razor, built on the shared <MapView> (raw Leaflet, OSM
// tiles, no API key) rather than a bespoke Leaflet wrapper. Click the map to place
// the pin (rounded to 6 dp), set a radius (clamped 5–500 m), or use the device's
// location. Used inline per-station by <StationsEditor> and for the optional
// activity geofence in Manage.
//
// Props:
//   lat      : number | null — current pin latitude (may be null = unplaced).
//   lng      : number | null — current pin longitude.
//   radius   : number — radius in metres (default 25).
//   onChange : ({ lat, lng, radius }) => void — emitted on every pin/radius change.
import { useEffect } from 'react';
import MapView from './MapView';
import { useGeolocation } from '../utils/useGeolocation';

const GOTHENBURG = [57.7089, 11.9746];
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const clampRadius = (r) => Math.min(500, Math.max(5, r));

export default function LocationPicker({ lat = null, lng = null, radius = 40, onChange }) {
  const { coords, error: geoError, watching, start, stop } = useGeolocation();

  const hasPin = lat != null && lng != null;
  const r = clampRadius(Number(radius) || 40);

  // When the one-shot-style geolocation yields a fix, place the pin there once.
  useEffect(() => {
    if (coords && coords.lat != null && coords.lng != null) {
      onChange?.({ lat: round6(coords.lat), lng: round6(coords.lng), radius: r });
      stop();
    }
    // Only react to a fresh coords object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords]);

  // Stop watching if we unmount mid-locate (the hook also self-cleans).
  useEffect(() => () => stop(), [stop]);

  const onMapClick = ({ lat: clat, lng: clng }) => {
    onChange?.({ lat: round6(clat), lng: round6(clng), radius: r });
  };

  const onRadius = (e) => {
    const parsed = parseInt(e.target.value, 10);
    if (Number.isNaN(parsed)) return;
    onChange?.({ lat, lng, radius: clampRadius(parsed) });
  };

  const clearPin = () => onChange?.({ lat: null, lng: null, radius: r });

  const statusText = hasPin
    ? `Nål satt (${lat.toFixed(4)}, ${lng.toFixed(4)}). Tryck på kartan för att flytta den.`
    : 'Tryck på kartan för att sätta en nål (eller använd din position).';

  const markers = hasPin ? [{ lat, lng, label: `${r} m`, color: '#0B84B3' }] : [];

  return (
    <div className="stack">
      <MapView
        center={hasPin ? [lat, lng] : GOTHENBURG}
        zoom={hasPin ? 16 : 11}
        markers={markers}
        onMapClick={onMapClick}
        height="38vh"
      />

      <div className="row wrap">
        <button type="button" className="btn ghost sm" onClick={start} disabled={watching}>
          {watching ? 'Hämtar plats…' : 'Använd min position'}
        </button>
        <span className="muted grow small">{statusText}</span>
        {hasPin ? (
          <button type="button" className="btn ghost sm" onClick={clearPin}>Rensa</button>
        ) : null}
      </div>

      <div className="field" style={{ margin: 0 }}>
        <label>Radie (meter)</label>
        <input type="number" min={5} max={500} value={r} onChange={onRadius} style={{ width: 120 }} />
      </div>

      {geoError ? (
        <div className="error-text">Kunde inte läsa din position — tryck på kartan istället.</div>
      ) : null}
    </div>
  );
}
