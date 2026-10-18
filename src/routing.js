// Real walking distances and routes along streets, from the public OSRM
// foot-routing service run by FOSSGIS on OpenStreetMap data (no API key).
// https://routing.openstreetmap.de — CORS-enabled; light, non-commercial use.

const BASE = "https://routing.openstreetmap.de/routed-foot";
const TIMEOUT_MS = 8000;
const METERS_PER_MILE = 1609.344;

const routeCache = new Map();

const coord = (lat, lon) => `${lon.toFixed(6)},${lat.toFixed(6)}`;

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Routing HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== "Ok") throw new Error(`Routing error: ${data.code}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walking distance in miles from (lat, lon) to each station, in one request.
 * Returns an array aligned with `stations`; entries are null when no route exists.
 */
export async function walkingMiles(lat, lon, stations) {
  const coords = [coord(lat, lon), ...stations.map((s) => coord(s.latitude, s.longitude))].join(";");
  const data = await getJson(`${BASE}/table/v1/foot/${coords}?sources=0&annotations=distance`);
  return data.distances[0].slice(1).map((m) => (Number.isFinite(m) ? m / METERS_PER_MILE : null));
}

/** Street-following walking route as [[lat, lon], ...], plus its length in miles. */
export async function walkingRoute(lat, lon, station) {
  const key = `${coord(lat, lon)};${coord(station.latitude, station.longitude)}`;
  if (!routeCache.has(key)) {
    const promise = getJson(`${BASE}/route/v1/foot/${key}?overview=full&geometries=geojson`).then((data) => {
      const route = data.routes[0];
      return {
        path: route.geometry.coordinates.map(([lng, lt]) => [lt, lng]),
        miles: route.distance / METERS_PER_MILE,
      };
    });
    promise.catch(() => routeCache.delete(key)); // allow a retry after failures
    routeCache.set(key, promise);
  }
  return routeCache.get(key);
}
