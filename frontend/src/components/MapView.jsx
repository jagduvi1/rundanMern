// Reusable Leaflet map (raw `leaflet`, no react-leaflet). OpenStreetMap tiles,
// no API key. Imperatively builds the map once, then diffs markers/pins/center on
// every render and tears the map down on unmount.
//
// Default-marker-icon fix: Leaflet's default icon resolves its PNGs relative to
// the CSS, which breaks under a bundler. Rather than wire up the image assets we
// render markers as lightweight coloured divIcons (teardrop pins) — no external
// images, crisp on retina, and they carry the per-marker colour.
import { useEffect, useRef } from 'react';
import L from 'leaflet';

const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const DEFAULT_COLOR = '#2563eb'; // --accent

// A small teardrop pin as an HTML divIcon — avoids the missing-image default-icon
// problem entirely (no L.Icon.Default image path needed).
function pinIcon(color = DEFAULT_COLOR) {
  const c = color || DEFAULT_COLOR;
  const html =
    `<div style="width:18px;height:18px;border-radius:50% 50% 50% 0;` +
    `background:${c};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);` +
    `transform:rotate(-45deg)"></div>`;
  return L.divIcon({
    html,
    className: 'rundan-pin',
    iconSize: [18, 18],
    iconAnchor: [9, 18],
    popupAnchor: [0, -16],
  });
}

export default function MapView({
  center = [57.7089, 11.9746], // Gothenburg fallback
  zoom = 13,
  markers = [],
  pins = [],
  onMapClick,
  height = '320px',
  interactive = true,
  fitToMarkers = false,
}) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null); // marker/pin overlay layer group
  const clickRef = useRef(onMapClick); // latest handler without re-binding the map
  clickRef.current = onMapClick;

  // ── Create the map once ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!elRef.current || mapRef.current) return undefined;
    const map = L.map(elRef.current, {
      zoomControl: interactive,
      dragging: interactive,
      scrollWheelZoom: interactive,
      doubleClickZoom: interactive,
      boxZoom: interactive,
      keyboard: interactive,
      touchZoom: interactive,
      tap: interactive,
    }).setView(center, zoom);

    L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);

    map.on('click', (e) => {
      clickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng });
    });

    // The container is often still being sized when we mount; measure now and on
    // the next frame so setView/fitBounds use the real viewport.
    map.invalidateSize();
    requestAnimationFrame(() => map.invalidateSize());
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
    // Map is created once; subsequent prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Keep the view in sync when center/zoom change ────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (map && !fitToMarkers && Array.isArray(center) && center.length === 2) {
      map.setView(center, zoom);
    }
  }, [center, zoom, fitToMarkers]);

  // ── Redraw markers + pins on every relevant change ───────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    for (const m of markers) {
      if (m == null || m.lat == null || m.lng == null) continue;
      const mk = L.marker([m.lat, m.lng], {
        title: m.label || '',
        icon: pinIcon(m.color),
      }).addTo(layer);
      if (m.label) mk.bindPopup(`<b>${escapeHtml(m.label)}</b>`);
    }

    for (const p of pins) {
      if (p == null || p.lat == null || p.lng == null) continue;
      L.circleMarker([p.lat, p.lng], {
        radius: 7,
        color: '#dc2626', // --danger
        fillColor: '#dc2626',
        fillOpacity: 0.9,
        weight: 2,
      }).addTo(layer);
    }

    if (fitToMarkers) {
      const pts = [...markers, ...pins]
        .filter((q) => q && q.lat != null && q.lng != null)
        .map((q) => [q.lat, q.lng]);
      if (pts.length > 0) {
        map.invalidateSize();
        map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 17 });
      }
    }
  }, [markers, pins, fitToMarkers]);

  return (
    <div
      ref={elRef}
      style={{ height, width: '100%', borderRadius: '14px', overflow: 'hidden' }}
    />
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
