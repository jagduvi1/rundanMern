// Geolocation hook + haversine helper — the React port of rundan's GeolocationInterop
// + wwwroot/js/geo.js.
//
// Battery: we do NOT keep a continuous high-accuracy watch (navigator.geolocation
// .watchPosition keeps the GPS radio on and drains the phone). Instead start()
// takes one fix immediately and then re-checks on a slow interval (default 5 min),
// and refresh() does an on-demand fresh fix (the Tipspromenad "update my position"
// button) so a player can get an instant, accurate reading the moment they arrive.
//
// The browser Geolocation API requires a secure context (HTTPS); localhost is
// treated as secure by browsers. The authoritative geofence check is server-side
// (reportArrival); distanceMeters() is for client-side proximity hints only.
import { useCallback, useEffect, useRef, useState } from 'react';

// Interval fixes can be a little stale (saves power); a manual refresh forces a
// fresh, high-accuracy reading.
const POLL_MS = 5 * 60 * 1000; // re-check position every 5 minutes
const PERIODIC_OPTS = { enableHighAccuracy: true, maximumAge: 120000, timeout: 20000 };
const FRESH_OPTS = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 };

export function useGeolocation() {
  const [coords, setCoords] = useState(null); // { lat, lng, accuracy } | null
  const [error, setError] = useState(null);
  const [watching, setWatching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const timerRef = useRef(null);
  const aliveRef = useRef(true);

  const supported = () => typeof navigator !== 'undefined' && 'geolocation' in navigator;

  // One position read; resolves to the coords (or null on failure).
  const readOnce = useCallback((opts) => new Promise((resolve) => {
    if (!supported()) {
      setError('Den här enheten saknar platsåtkomst.');
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        if (aliveRef.current) { setError(null); setCoords(c); }
        resolve(c);
      },
      (err) => {
        if (aliveRef.current) setError(err?.message || 'Kunde inte hämta din position.');
        resolve(null);
      },
      opts || PERIODIC_OPTS,
    );
  }), []);

  const stop = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setWatching(false);
  }, []);

  // Start low-power periodic updates: an immediate fix, then one every POLL_MS.
  const start = useCallback(() => {
    if (!supported()) { setError('Den här enheten saknar platsåtkomst.'); return; }
    if (timerRef.current) return; // already polling
    setWatching(true);
    setError(null);
    readOnce(PERIODIC_OPTS);
    timerRef.current = setInterval(() => readOnce(PERIODIC_OPTS), POLL_MS);
  }, [readOnce]);

  // On-demand fresh fix (the manual "update my position" button).
  const refresh = useCallback(async () => {
    setRefreshing(true);
    const c = await readOnce(FRESH_OPTS);
    if (aliveRef.current) setRefreshing(false);
    return c;
  }, [readOnce]);

  // Stop the interval when the consumer unmounts.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  return { coords, error, watching, refreshing, start, stop, refresh };
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
