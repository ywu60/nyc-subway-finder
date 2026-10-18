// Great-circle distance helpers. Pure functions, no DOM access.

export const EARTH_RADIUS_KM = 6371;
export const KM_TO_MILES = 0.621371;

const toRadians = (deg) => (deg * Math.PI) / 180;

/** Haversine distance between two lat/lon points, in kilometres. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function kmToMiles(km) {
  return km * KM_TO_MILES;
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
  return kmToMiles(haversineKm(lat1, lon1, lat2, lon2));
}

/** "0.42 mi" — always two decimals. */
export function formatMiles(miles) {
  return `${miles.toFixed(2)} mi`;
}

/** True when lat/lon are finite numbers within valid WGS84 ranges. */
export function isValidCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Parse "40.7580, -73.9855" (comma and/or whitespace separated).
 * Returns { lat, lon } or null.
 */
export function parseLatLon(text) {
  const match = String(text)
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  return isValidCoordinate(lat, lon) ? { lat, lon } : null;
}
