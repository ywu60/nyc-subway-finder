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

// ---------- Street-grid ("Manhattan") distance ----------

// Manhattan's avenues run ~29° east of true north. Elsewhere we assume a
// north–south / east–west grid, which is a reasonable approximation for
// most of Brooklyn, Queens, the Bronx and Staten Island.
export const MANHATTAN_GRID_DEG = 29;

const KM_PER_DEG_LAT = (Math.PI / 180) * EARTH_RADIUS_KM;

/** Local planar offset (km east, km north) from point 1 to point 2. */
function offsetKm(lat1, lon1, lat2, lon2) {
  const meanLat = toRadians((lat1 + lat2) / 2);
  return {
    east: (lon2 - lon1) * KM_PER_DEG_LAT * Math.cos(meanLat),
    north: (lat2 - lat1) * KM_PER_DEG_LAT,
  };
}

/** Unit vectors (east, north) of the street grid's two axes. */
function gridAxes(gridDeg) {
  const t = toRadians(gridDeg);
  return {
    avenue: { east: Math.sin(t), north: Math.cos(t) }, // "uptown"
    street: { east: Math.cos(t), north: -Math.sin(t) }, // "crosstown"
  };
}

/**
 * Manhattan (L1) distance measured along a street grid rotated `gridDeg`
 * clockwise from true north, in kilometres. Always ≥ the straight-line
 * distance; equal when both points share an avenue or a street.
 */
export function streetGridKm(lat1, lon1, lat2, lon2, gridDeg = 0) {
  const d = offsetKm(lat1, lon1, lat2, lon2);
  const { avenue, street } = gridAxes(gridDeg);
  return (
    Math.abs(d.east * avenue.east + d.north * avenue.north) +
    Math.abs(d.east * street.east + d.north * street.north)
  );
}

export function streetGridMiles(lat1, lon1, lat2, lon2, gridDeg = 0) {
  return kmToMiles(streetGridKm(lat1, lon1, lat2, lon2, gridDeg));
}

/**
 * Corner of the L-shaped grid path: walk along the avenue axis first, then
 * along the street axis. Returns [lat, lon]. Used to draw the path on the map.
 */
export function gridCorner(lat1, lon1, lat2, lon2, gridDeg = 0) {
  const d = offsetKm(lat1, lon1, lat2, lon2);
  const { avenue } = gridAxes(gridDeg);
  const along = d.east * avenue.east + d.north * avenue.north;
  const meanLat = toRadians((lat1 + lat2) / 2);
  return [
    lat1 + (along * avenue.north) / KM_PER_DEG_LAT,
    lon1 + (along * avenue.east) / (KM_PER_DEG_LAT * Math.cos(meanLat)),
  ];
}
