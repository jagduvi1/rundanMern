// Geolocation hook + haversine helper — the React port of rundan's GeolocationInterop
// + wwwroot/js/geo.js. Uses navigator.geolocation.watchPosition (high accuracy)
// directly; manages the watch id in a ref and clears it on unmount.
//
// The browser Geolocation API requires a secure context (HTTPS); localhost is
// treated as secure by browsers. The authoritative geofence check is server-side
// (reportArrival); distanceMeters() is for client-side proximity hints only.
import { useCallback, useEffect, useRef, useState } from 'react';

const WATCH_OPTS = { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 };

export function useGeolocation() {
  const [coords, setCoords] = useState(null); // { lat, lng, accuracy } | null
  const [error, setError] = useState(null);
  const [watching, setWatching] = useState(false);
  const watchId = useRef(-1);

  const stop = useCallback(() => {
    if (watchId.current >= 0 && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId.current);
    }
    watchId.current = -1;
    setWatching(false);
  }, []);

  const start = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setError('Den här enheten saknar platsåtkomst.');
      return;
    }
    // Already watching — don't open a second watch.
    if (watchId.current >= 0) return;
    setError(null);
    setWatching(true);
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        setError(null);
        setCoords({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => {
        setError(err?.message || 'Kunde inte hämta din position.');
      },
      WATCH_OPTS,
    );
  }, []);

  // Clear any active watch when the consumer unmounts.
  useEffect(() => () => {
    if (watchId.current >= 0 && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId.current);
    }
  }, []);

  return { coords, error, watching, start, stop };
}

// Haversine distance in metres (earth radius 6 371 000 m) — mirrors
// GeolocationInterop.DistanceMeters byte-for-byte.
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
