import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatMiles, haversineKm, haversineMiles, isValidCoordinate, parseLatLon } from "../src/geo.js";
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

test("closest station matches independently computed distance", () => {
  const [lat, lon] = [40.7515, -73.99];
  const [first] = findNearestStations(sample, lat, lon, "D");
  assert.equal(first.station.name, "Alpha");
  assert.ok(Math.abs(first.distanceMiles - referenceMiles(lat, lon, 40.75, -73.99)) < 1e-6);
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
