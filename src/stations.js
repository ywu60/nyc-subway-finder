// Station search: filter by exact service ID, rank by street-grid walking
// distance, and collapse platforms of the same station complex. No DOM access.

import { MANHATTAN_GRID_DEG, haversineMiles, isValidCoordinate, streetGridMiles } from "./geo.js";

/**
 * Validate the parsed contents of data/stations.json.
 * Returns the station array, or throws with a readable message.
 */
export function validateStationData(data) {
  const list = Array.isArray(data) ? data : data && data.stations;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("Station data is missing or empty.");
  }
  return list.filter(
    (s) =>
      s &&
      typeof s.id === "string" &&
      typeof s.name === "string" &&
      Array.isArray(s.services) &&
      isValidCoordinate(s.latitude, s.longitude),
  );
}

/** Set of every service ID present in the data. */
export function availableServices(stations) {
  const set = new Set();
  for (const s of stations) for (const r of s.services) set.add(r);
  return set;
}

/** Street-grid angle to use for walking to `station`. */
export function gridAngleFor(station) {
  return station.borough === "M" ? MANHATTAN_GRID_DEG : 0;
}

/**
 * Nearest stations serving `routeId` to (lat, lon).
 *
 * - Ranked by street-grid (Manhattan) distance in miles (`distanceMiles`);
 *   straight-line distance is also returned as `straightMiles`.
 * - Matches service IDs exactly (`"S"` never matches `"SI"`).
 * - When several platforms of one complex serve the route, only the closest
 *   platform is kept, so a complex never appears twice.
 * - Results are sorted ascending by `distanceMiles`.
 */
export function findNearestStations(stations, lat, lon, routeId, limit = 3) {
  if (!isValidCoordinate(lat, lon)) throw new Error("Invalid coordinates.");

  const bestByComplex = new Map();
  for (const station of stations) {
    if (!station.services.includes(routeId)) continue;
    const distanceMiles = streetGridMiles(lat, lon, station.latitude, station.longitude, gridAngleFor(station));
    const key = station.complexId || station.id;
    const current = bestByComplex.get(key);
    if (!current || distanceMiles < current.distanceMiles) {
      const straightMiles = haversineMiles(lat, lon, station.latitude, station.longitude);
      bestByComplex.set(key, { station, distanceMiles, straightMiles });
    }
  }

  return [...bestByComplex.values()]
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, limit);
}
