// Server-side geography helpers — the MERN port of rundan's `GeoMath.cs` +
// `SwedishCities.cs`.
//
// The MapPin game scores a pin's distance to the real city SERVER-SIDE so the
// real coordinates never reach the client before the player has pinned. Keep the
// earth radius (6371.0 km) and the haversine formula byte-for-byte identical to
// the C# so scores match the original app exactly.

const EARTH_RADIUS_KM = 6371.0; // Earth radius, km (matches GeoMath.cs)

// Degrees → radians (GeoMath.ToRad).
const toRad = (deg) => (deg * Math.PI) / 180.0;

/**
 * Haversine great-circle distance between two lat/lng points, in KILOMETRES.
 * Direct port of GeoMath.DistanceKm — same operations, same radius.
 *
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} distance in km
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Same great-circle distance expressed in METRES (convenience for radius checks).
 *
 * @returns {number} distance in metres
 */
function distanceMeters(lat1, lng1, lat2, lng2) {
  return haversineKm(lat1, lng1, lat2, lng2) * 1000;
}

/**
 * True when (lat,lng) is within `radiusMeters` of the target point. Used for
 * Tipspromenad / geofenced auto-start checks (player has "arrived").
 *
 * @returns {boolean}
 */
function withinRadius(lat, lng, targetLat, targetLng, radiusMeters) {
  return distanceMeters(lat, lng, targetLat, targetLng) <= radiusMeters;
}

// Built-in pool of Swedish cities (name + approximate coordinates) for the MapPin
// game — exact port of SwedishCities.All (44 entries, UTF-8 preserved). The draw
// at activity-open shuffles this list and persists N as MapCity rows; coordinates
// only need to be good enough that relative pin distances are fair.
const SWEDISH_CITIES = [
  { name: 'Stockholm', lat: 59.3293, lng: 18.0686 },
  { name: 'Göteborg', lat: 57.7089, lng: 11.9746 },
  { name: 'Malmö', lat: 55.6050, lng: 13.0038 },
  { name: 'Uppsala', lat: 59.8586, lng: 17.6389 },
  { name: 'Västerås', lat: 59.6099, lng: 16.5448 },
  { name: 'Örebro', lat: 59.2741, lng: 15.2066 },
  { name: 'Linköping', lat: 58.4109, lng: 15.6216 },
  { name: 'Helsingborg', lat: 56.0465, lng: 12.6945 },
  { name: 'Jönköping', lat: 57.7826, lng: 14.1618 },
  { name: 'Norrköping', lat: 58.5877, lng: 16.1924 },
  { name: 'Lund', lat: 55.7047, lng: 13.1910 },
  { name: 'Umeå', lat: 63.8258, lng: 20.2630 },
  { name: 'Gävle', lat: 60.6749, lng: 17.1413 },
  { name: 'Borås', lat: 57.7210, lng: 12.9401 },
  { name: 'Eskilstuna', lat: 59.3666, lng: 16.5077 },
  { name: 'Karlstad', lat: 59.4022, lng: 13.5115 },
  { name: 'Växjö', lat: 56.8777, lng: 14.8091 },
  { name: 'Halmstad', lat: 56.6745, lng: 12.8568 },
  { name: 'Sundsvall', lat: 62.3908, lng: 17.3069 },
  { name: 'Luleå', lat: 65.5848, lng: 22.1567 },
  { name: 'Trollhättan', lat: 58.2837, lng: 12.2886 },
  { name: 'Östersund', lat: 63.1792, lng: 14.6357 },
  { name: 'Borlänge', lat: 60.4858, lng: 15.4371 },
  { name: 'Falun', lat: 60.6065, lng: 15.6355 },
  { name: 'Kalmar', lat: 56.6634, lng: 16.3566 },
  { name: 'Kristianstad', lat: 56.0294, lng: 14.1567 },
  { name: 'Skövde', lat: 58.3912, lng: 13.8451 },
  { name: 'Karlskrona', lat: 56.1612, lng: 15.5869 },
  { name: 'Visby', lat: 57.6348, lng: 18.2948 },
  { name: 'Kiruna', lat: 67.8558, lng: 20.2253 },
  { name: 'Skellefteå', lat: 64.7507, lng: 20.9528 },
  { name: 'Örnsköldsvik', lat: 63.2909, lng: 18.7152 },
  { name: 'Nyköping', lat: 58.7528, lng: 17.0086 },
  { name: 'Varberg', lat: 57.1057, lng: 12.2502 },
  { name: 'Uddevalla', lat: 58.3498, lng: 11.9424 },
  { name: 'Motala', lat: 58.5371, lng: 15.0364 },
  { name: 'Ängelholm', lat: 56.2428, lng: 12.8620 },
  { name: 'Härnösand', lat: 62.6323, lng: 17.9379 },
  { name: 'Piteå', lat: 65.3172, lng: 21.4794 },
  { name: 'Ystad', lat: 55.4297, lng: 13.8204 },
  { name: 'Lidköping', lat: 58.5052, lng: 13.1576 },
  { name: 'Sandviken', lat: 60.6175, lng: 16.7763 },
  { name: 'Hudiksvall', lat: 61.7274, lng: 17.1059 },
  { name: 'Mora', lat: 61.0050, lng: 14.5380 },
];

/**
 * The full Swedish-city pool used to draw MapPin cities. Returns a fresh copy so
 * callers can shuffle/slice without mutating the shared dataset.
 *
 * @returns {Array<{ name: string, lat: number, lng: number }>}
 */
function swedishCities() {
  return SWEDISH_CITIES.map((c) => ({ ...c }));
}

module.exports = {
  EARTH_RADIUS_KM,
  haversineKm,
  distanceMeters,
  withinRadius,
  swedishCities,
};
