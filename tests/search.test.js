import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MANHATTAN_GRID_DEG,
  formatMiles,
  gridCorner,
  haversineKm,
  haversineMiles,
  isValidCoordinate,
  parseLatLon,
  streetGridKm,
  streetGridMiles,
} from "../src/geo.js";
import { ROUTES } from "../src/routes.js";
import { availableServices, findNearestStations, validateStationData } from "../src/stations.js";

const data = JSON.parse(readFileSync(new URL("../data/stations.json", import.meta.url)));
const stations = validateStationData(data);

// Sample records with hand-checkable geometry.
const sample = [
  { id: "a", complexId: "1", name: "Alpha", latitude: 40.75, longitude: -73.99, services: ["D", "F"] },
  { id: "b", complexId: "2", name: "Bravo", latitude: 40.76, longitude: -73.99, services: ["D"] },
  { id: "c", complexId: "3", name: "Charlie", latitude: 40.70, longitude: -73.99, services: ["F"] },
  { id: "d", complexId: "4", name: "Delta", latitude: 40.80, longitude: -73.99, services: ["D"] },
  { id: "e", complexId: "5", name: "Echo", latitude: 40.74, longitude: -73.99, services: ["SI"] },
];

// Independent reference: spherical law of cosines.
function referenceMiles(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const c =
    Math.sin(lat1 * r) * Math.sin(lat2 * r) +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return 6371 * Math.acos(Math.min(1, c)) * 0.621371;
}

test("haversine matches known distances", () => {
  assert.equal(haversineKm(40.75, -73.99, 40.75, -73.99), 0);
  // 0.01° of latitude ≈ 1.11195 km on a 6371 km sphere.
  assert.ok(Math.abs(haversineKm(40.75, -73.99, 40.76, -73.99) - 1.11195) < 1e-4);
  // Times Sq (127) to Grand Central (631) — independently computed.
  const d = haversineMiles(40.75529, -73.987495, 40.751776, -73.976848);
  assert.ok(Math.abs(d - referenceMiles(40.75529, -73.987495, 40.751776, -73.976848)) < 1e-6);
  assert.ok(Math.abs(haversineMiles(0, 0, 1, 0) - 111.19493 * 0.621371) < 1e-3);
});

test("closest station matches independently computed distances", () => {
  const [lat, lon] = [40.7515, -73.99];
  const [first] = findNearestStations(sample, lat, lon, "D");
  assert.equal(first.station.name, "Alpha");
  assert.ok(Math.abs(first.straightMiles - referenceMiles(lat, lon, 40.75, -73.99)) < 1e-6);
  // Same meridian: walking the grid is just the north–south leg.
  assert.ok(Math.abs(first.distanceMiles - 0.0015 * KM_PER_DEG * 0.621371) < 1e-9);
});

// Independent planar helpers for the street-grid tests.
const KM_PER_DEG = (Math.PI / 180) * 6371;
function offsetFrom(lat, lon, eastKm, northKm) {
  return [lat + northKm / KM_PER_DEG, lon + eastKm / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180))];
}

test("street-grid distance on a north–south grid is |east| + |north|", () => {
  const [lat, lon] = offsetFrom(40.7, -73.95, 0.3, 0.4);
  assert.ok(Math.abs(streetGridKm(40.7, -73.95, lat, lon, 0) - 0.7) < 1e-3);
  assert.ok(Math.abs(haversineKm(40.7, -73.95, lat, lon) - 0.5) < 1e-3);
});

test("street-grid distance follows Manhattan's rotated grid", () => {
  const t = (MANHATTAN_GRID_DEG * Math.PI) / 180;
  // 1 km straight up an avenue: no crosstown leg, so grid = straight line.
  const [aLat, aLon] = offsetFrom(40.76, -73.98, Math.sin(t), Math.cos(t));
  assert.ok(Math.abs(streetGridKm(40.76, -73.98, aLat, aLon, MANHATTAN_GRID_DEG) - 1) < 1e-3);
  // 0.6 km uptown + 0.8 km crosstown = 1.4 km walked, 1.0 km as the crow flies.
  const [bLat, bLon] = offsetFrom(40.76, -73.98, 0.6 * Math.sin(t) + 0.8 * Math.cos(t), 0.6 * Math.cos(t) - 0.8 * Math.sin(t));
  assert.ok(Math.abs(streetGridKm(40.76, -73.98, bLat, bLon, MANHATTAN_GRID_DEG) - 1.4) < 1e-3);
  assert.ok(Math.abs(haversineKm(40.76, -73.98, bLat, bLon) - 1.0) < 1e-3);
});

test("street-grid distance is never shorter than straight-line", () => {
  for (let i = 0; i < 500; i++) {
    const lat2 = 40.6 + Math.random() * 0.3;
    const lon2 = -74.05 + Math.random() * 0.3;
    for (const deg of [0, MANHATTAN_GRID_DEG]) {
      assert.ok(streetGridMiles(40.75, -73.99, lat2, lon2, deg) >= haversineMiles(40.75, -73.99, lat2, lon2) - 1e-6);
    }
  }
});

test("grid corner splits the walk into its two legs", () => {
  const [a, b, c, d] = [40.7527, -73.9772, 40.7681, -73.9819];
  const corner = gridCorner(a, b, c, d, MANHATTAN_GRID_DEG);
  const legs = haversineKm(a, b, ...corner) + haversineKm(...corner, c, d);
  assert.ok(Math.abs(legs - streetGridKm(a, b, c, d, MANHATTAN_GRID_DEG)) < 1e-3);
});

test("ranking uses walking distance, which can differ from straight-line", () => {
  const [pLat, pLon] = offsetFrom(40.7, -73.95, 0.5, 0.5); // diagonal: 0.71 km air, 1.0 km walk
  const [qLat, qLon] = offsetFrom(40.7, -73.95, 0, 0.8); //  due north: 0.8 km both
  const pts = [
    { id: "p", complexId: "p", name: "Diagonal", latitude: pLat, longitude: pLon, services: ["A"] },
    { id: "q", complexId: "q", name: "Straight", latitude: qLat, longitude: qLon, services: ["A"] },
  ];
  const res = findNearestStations(pts, 40.7, -73.95, "A");
  assert.deepEqual(res.map((r) => r.station.name), ["Straight", "Diagonal"]);
  assert.ok(res[1].straightMiles < res[0].straightMiles);
});

test("filters by exact service and sorts ascending", () => {
  const d = findNearestStations(sample, 40.75, -73.99, "D", 10);
  assert.deepEqual(d.map((r) => r.station.name), ["Alpha", "Bravo", "Delta"]);
  const f = findNearestStations(sample, 40.75, -73.99, "F", 10);
  assert.deepEqual(f.map((r) => r.station.name), ["Alpha", "Charlie"]);
  // "S" must not substring-match "SI".
  assert.equal(findNearestStations(sample, 40.75, -73.99, "S").length, 0);
  assert.equal(findNearestStations(sample, 40.75, -73.99, "SI").length, 1);
});

test("returns at most `limit` results (nearest + two alternatives)", () => {
  assert.equal(findNearestStations(sample, 40.75, -73.99, "D").length, 3);
  assert.equal(findNearestStations(stations, 40.75, -73.99, "A").length, 3);
});

test("deduplicates platforms within a complex, keeping the closest", () => {
  const dupes = [
    { id: "x1", complexId: "9", name: "Hub", latitude: 40.75, longitude: -73.99, services: ["D"] },
    { id: "x2", complexId: "9", name: "Hub", latitude: 40.7501, longitude: -73.99, services: ["D"] },
    { id: "y", complexId: "8", name: "Other", latitude: 40.76, longitude: -73.99, services: ["D"] },
  ];
  const res = findNearestStations(dupes, 40.7502, -73.99, "D");
  assert.deepEqual(res.map((r) => r.station.id), ["x2", "y"]);
});

test("unsupported route returns empty, invalid coordinates throw", () => {
  assert.deepEqual(findNearestStations(stations, 40.75, -73.99, "X"), []);
  assert.throws(() => findNearestStations(stations, NaN, -73.99, "D"));
  assert.throws(() => findNearestStations(stations, 95, -73.99, "D"));
});

test("formatting and coordinate parsing", () => {
  assert.equal(formatMiles(0.4249), "0.42 mi");
  assert.equal(formatMiles(1), "1.00 mi");
  assert.deepEqual(parseLatLon("40.7359, -73.9911"), { lat: 40.7359, lon: -73.9911 });
  assert.deepEqual(parseLatLon("40.7359 -73.9911"), { lat: 40.7359, lon: -73.9911 });
  assert.equal(parseLatLon("Union Square"), null);
  assert.equal(parseLatLon("140, -73"), null);
  assert.equal(isValidCoordinate(40.7, Infinity), false);
});

test("real data: valid, inside NYC, every route in the picker has stations", () => {
  assert.equal(stations.length, data.stations.length, "no invalid records");
  const ids = new Set();
  for (const s of stations) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.latitude > 40.45 && s.latitude < 40.95, s.id);
    assert.ok(s.longitude > -74.3 && s.longitude < -73.68, s.id);
    assert.ok(s.services.length > 0, s.id);
  }
  const services = availableServices(stations);
  for (const r of ROUTES) assert.ok(services.has(r.id), `route ${r.id} has no stations`);
  for (const s of services) assert.ok(ROUTES.some((r) => r.id === s), `data route ${s} missing from picker`);
});

test("real data: D results only serve D; switching to F changes results", () => {
  // Herald Sq area.
  const d = findNearestStations(stations, 40.7497, -73.9877, "D");
  assert.ok(d.every((r) => r.station.services.includes("D")));
  assert.equal(d[0].station.name, "34 St-Herald Sq");
  const f = findNearestStations(stations, 40.7128, -73.9572, "F");
  assert.ok(f.every((r) => r.station.services.includes("F")));
  assert.notDeepEqual(f.map((r) => r.station.id), d.map((r) => r.station.id));
});

test("real data: shuttles are distinct", () => {
  const gs = findNearestStations(stations, 40.7527, -73.9772, "GS", 10).map((r) => r.station.name);
  assert.deepEqual(gs.sort(), ["Grand Central-42 St", "Times Sq-42 St"]);
  const fs = findNearestStations(stations, 40.68, -73.96, "FS", 10);
  assert.ok(fs.every((r) => !gs.includes(r.station.name)));
});
