// Station search: filter by exact service ID, rank by street-grid walking
// distance, and collapse platforms of the same station complex. No DOM access.

import { MANHATTAN_GRID_DEG, haversineMiles, isValidCoordinate, streetGridMiles } from "./geo.js?v=13";

export const BOROUGHS = { M: "Manhattan", Bk: "Brooklyn", Bx: "Bronx", Q: "Queens", SI: "Staten Island" };

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

/**
 * Station complexes where you can change between all of `routeIds`.
 *
 * - Services are pooled across a complex's platforms, so connected stations
 *   (e.g. Times Sq-42 St and 42 St-Port Authority) count as one transfer.
 * - Each result has the complex's `names` joined as `name`, its `services`,
 *   and a position averaged over the platforms of the chosen lines.
 * - Sorted by name. Empty when fewer than two lines are given.
 */
export function sharedStations(stations, routeIds) {
  if (routeIds.length < 2) return [];
  const complexes = new Map();
  for (const s of stations) {
    const key = s.complexId || s.id;
    let c = complexes.get(key);
    if (!c) complexes.set(key, (c = { complexId: key, names: [], borough: s.borough, services: [], platforms: [] }));
    if (!c.names.includes(s.name)) c.names.push(s.name);
    for (const r of s.services) if (!c.services.includes(r)) c.services.push(r);
    c.platforms.push(s);
  }

  const result = [];
  for (const c of complexes.values()) {
    if (!routeIds.every((r) => c.services.includes(r))) continue;
    const used = c.platforms.filter((p) => p.services.some((r) => routeIds.includes(r)));
    result.push({
      complexId: c.complexId,
      name: c.names.join(" / "),
      borough: c.borough,
      services: c.services,
      latitude: used.reduce((sum, p) => sum + p.latitude, 0) / used.length,
      longitude: used.reduce((sum, p) => sum + p.longitude, 0) / used.length,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Re-rank `candidates` (from findNearestStations) using real walking
 * distances in miles (aligned array; null = no route found). Results with a
 * route get `distanceMiles` replaced and `routed: true`; the rest keep their
 * street-grid estimate. Sorted ascending and trimmed to `limit`.
 */
export function rerankByWalking(candidates, walkingMiles, limit = 3) {
  return candidates
    .map((c, i) =>
      walkingMiles[i] == null ? { ...c, routed: false } : { ...c, distanceMiles: walkingMiles[i], routed: true },
    )
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, limit);
}
