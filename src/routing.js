// Real walking distances and routes along streets, from the public OSRM
// foot-routing service run by FOSSGIS on OpenStreetMap data (no API key).
// https://routing.openstreetmap.de — CORS-enabled; light, non-commercial use.

const BASE = "https://routing.openstreetmap.de/routed-foot";
// The batch (table) request is occasionally slow on the free server, so it
// gets a longer timeout. Results are cached so repeated selections and
// route switches don't hit the server again.
const ROUTE_TIMEOUT_MS = 8000;
const TABLE_TIMEOUT_MS = 15000;
const METERS_PER_MILE = 1609.344;

const routeCache = new Map();
const tableCache = new Map();

const coord = (lat, lon) => `${lon.toFixed(6)},${lat.toFixed(6)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, timeoutMs, retries = 1) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 429 && retries > 0) {
      // Rate-limited by the shared server: back off once, then give up.
      clearTimeout(timer);
      await sleep(1500);
      return getJson(url, timeoutMs, retries - 1);
    }
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
export function walkingMiles(lat, lon, stations) {
  const coords = [coord(lat, lon), ...stations.map((s) => coord(s.latitude, s.longitude))].join(";");
  return cached(tableCache, coords, () =>
    getJson(`${BASE}/table/v1/foot/${coords}?sources=0&annotations=distance`, TABLE_TIMEOUT_MS).then((data) =>
      data.distances[0].slice(1).map((m) => (Number.isFinite(m) ? m / METERS_PER_MILE : null)),
    ),
  );
}

/** Street-following walking route as [[lat, lon], ...], plus its length in miles. */
export function walkingRoute(lat, lon, station) {
  const key = `${coord(lat, lon)};${coord(station.latitude, station.longitude)}`;
  return cached(routeCache, key, () =>
    getJson(`${BASE}/route/v1/foot/${key}?overview=full&geometries=geojson`, ROUTE_TIMEOUT_MS).then((data) => {
      const route = data.routes[0];
      return {
        path: route.geometry.coordinates.map(([lng, lt]) => [lt, lng]),
        miles: route.distance / METERS_PER_MILE,
      };
    }),
  );
}

/** Memoize a promise by key; failed lookups are dropped so they can be retried. */
function cached(cache, key, load) {
  if (!cache.has(key)) {
    const promise = load();
    promise.catch(() => cache.delete(key));
    cache.set(key, promise);
  }
  return cache.get(key);
}
