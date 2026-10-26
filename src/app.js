// UI controller: location, route selection, results and map.
// Coordinates live only in the `state` object below; nothing is persisted.

import { badge, el } from "./dom.js?v=14";
import { formatMiles, isValidCoordinate, parseLatLon } from "./geo.js?v=14";
import { ROUTES, getRoute } from "./routes.js?v=14";
import { walkingMiles, walkingRoute } from "./routing.js?v=14";
import { initCompare } from "./compare.js?v=14";
import {
  BOROUGHS,
  availableServices,
  findNearestStations,
  rerankByWalking,
  validateStationData,
} from "./stations.js?v=14";

const NYC_CENTER = [40.7359, -73.9911];
const FAR_FROM_NYC_MILES = 20;
// Fresh fixes only (a cached one is often a coarse Wi-Fi/IP guess). We keep
// watching for a while because the first fix is usually the least accurate.
const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 };
const GOOD_ACCURACY_M = 30; // stop refining once a fix is this good
const REFINE_MS = 20000; // ...or after this long
const ROUGH_ACCURACY_M = 100;
const POOR_ACCURACY_M = 500;

const state = {
  stations: [],
  services: new Set(),
  complexServices: new Map(), // complexId -> every service in that complex
  routeId: null,
  location: null, // { lat, lon, source: "gps" | "manual", accuracy? }
  dataError: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  locateBtn: $("locate-btn"),
  refreshBtn: $("refresh-btn"),
  locStatus: $("loc-status"),
  manual: $("manual"),
  manualForm: $("manual-form"),
  manualInput: $("manual-input"),
  routes: $("routes"),
  routeName: $("route-name"),
  results: $("results"),
  mapStatus: $("map-status"),
  dataDate: $("data-date"),
};

// ---------- Status helpers ----------

function setStatus(message, kind = "") {
  els.locStatus.textContent = message;
  els.locStatus.className = `status ${kind}`.trim();
}

// ---------- Map (optional: results still work if Leaflet fails) ----------

const map = (() => {
  if (!window.L) {
    els.mapStatus.hidden = false;
    els.mapStatus.textContent = "The map could not be loaded. Station results still work.";
    return null;
  }
  const L = window.L;
  const m = L.map("map", { zoomControl: true }).setView(NYC_CENTER, 11);
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · ' +
      'Routes: <a href="https://routing.openstreetmap.de/about.html">FOSSGIS OSRM</a>',
  }).addTo(m);
  let tileErrors = 0;
  tiles.on("tileerror", () => {
    if (++tileErrors === 3) {
      els.mapStatus.hidden = false;
      els.mapStatus.textContent = "Map tiles are not loading (offline?). Station results still work.";
    }
  });
  tiles.on("tileload", () => {
    tileErrors = 0;
    els.mapStatus.hidden = true;
  });

  const stopsLayer = L.layerGroup().addTo(m); // every stop on the selected line
  const layer = L.layerGroup().addTo(m);
  m.createPane("userPane").style.zIndex = 700; // above station labels
  const pathLayer = L.layerGroup().addTo(m);
  const userIcon = L.divIcon({
    className: "",
    html: '<div class="user-pin"><span class="user-pulse"></span><span class="user-dot"></span></div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  // Legend instead of a permanent label, so nothing covers the location dot.
  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = () => {
    const div = L.DomUtil.create("div", "map-legend");
    div.innerHTML =
      '<span><i class="legend-user"></i>You</span>' +
      '<span><i class="legend-selected"></i>Selected station</span>' +
      '<span><i class="legend-stop"></i>Other stops on line</span>' +
      '<span><i class="legend-path"></i>Walking route</span>';
    return div;
  };
  legend.addTo(m);

  // ---- Ridership heatmap (toggle; data loads on first use) ----
  m.createPane("ridershipPane").style.zIndex = 390; // hover targets, below station markers
  const HEAT_GRADIENT = { 0.2: "#2c7bb6", 0.45: "#00a6ca", 0.65: "#f9d057", 0.85: "#f29e2e", 1: "#d7191c" };
  let heat = null; // { layer, targets } once loaded
  let heatOn = false;
  const heatControl = L.control({ position: "topright" });
  heatControl.onAdd = () => {
    const div = L.DomUtil.create("div", "heat-control");
    L.DomEvent.disableClickPropagation(div); // not a "drop a pin" click
    div.innerHTML =
      '<button type="button" class="heat-btn" aria-pressed="false">Ridership heatmap</button>' +
      '<div class="heat-legend" hidden><span class="heat-scale"></span>' +
      '<span class="heat-labels"><span>Fewer riders</span><span>More</span></span>' +
      '<span class="heat-period"></span></div>';
    // Sort: the integer-like key "1" would otherwise come first.
    const gradient = Object.entries(HEAT_GRADIENT)
      .sort(([a], [b]) => a - b)
      .map(([stop, c]) => `${c} ${stop * 100}%`)
      .join(", ");
    div.querySelector(".heat-scale").style.background = `linear-gradient(to right, ${gradient})`;
    div.querySelector(".heat-btn").addEventListener("click", () => toggleHeat(div));
    return div;
  };
  heatControl.addTo(m);

  async function loadHeat() {
    if (!L.heatLayer) throw new Error("heatmap plugin not loaded");
    const res = await fetch("data/ridership.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const stations = data.stations.filter((s) => isValidCoordinate(s.latitude, s.longitude) && s.avgDaily > 0);
    const max = Math.max(...stations.map((s) => s.avgDaily));
    // Square root so mid-size stations still show next to Times Sq.
    const points = stations.map((s) => [s.latitude, s.longitude, Math.sqrt(s.avgDaily / max)]);
    const layer = L.heatLayer(points, { radius: 22, blur: 18, maxZoom: 13, max: 1, minOpacity: 0.25, gradient: HEAT_GRADIENT });
    const targets = L.layerGroup(
      stations.map((s) =>
        L.circleMarker([s.latitude, s.longitude], { pane: "ridershipPane", radius: 9, stroke: false, fillOpacity: 0 })
          .bindTooltip(`${s.name}<br>${s.avgDaily.toLocaleString("en-US")} riders/day`, {
            direction: "top",
            className: "station-label",
          })
          .on("click", (e) => L.DomEvent.stopPropagation(e)),
      ),
    );
    const fmt = (d, opts) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...opts });
    const period = `${fmt(data.periodStart)} – ${fmt(data.periodEnd, { year: "numeric" })}`;
    return { layer, targets, period: `Avg daily entries, ${period}` };
  }

  async function toggleHeat(div) {
    const btn = div.querySelector(".heat-btn");
    const legendBox = div.querySelector(".heat-legend");
    heatOn = !heatOn;
    btn.setAttribute("aria-pressed", String(heatOn));
    if (!heatOn) {
      if (heat) {
        heat.layer.remove();
        heat.targets.remove();
      }
      legendBox.hidden = true;
      return;
    }
    if (!heat) {
      btn.disabled = true;
      btn.textContent = "Loading…";
      try {
        heat = await loadHeat();
      } catch (err) {
        console.error(err);
        heatOn = false;
        btn.setAttribute("aria-pressed", "false");
        els.mapStatus.hidden = false;
        els.mapStatus.textContent = "The ridership heatmap couldn't be loaded. Check your connection and try again.";
        return;
      } finally {
        btn.disabled = false;
        btn.textContent = "Ridership heatmap";
      }
      div.querySelector(".heat-period").textContent = heat.period;
    }
    heat.layer.addTo(m);
    heat.targets.addTo(m);
    legendBox.hidden = false;
  }

  m.on("click", (e) => {
    setLocation({ lat: e.latlng.lat, lon: e.latlng.lng, source: "manual", label: "Dropped pin" });
    setStatus("Using the pin you placed on the map.");
  });

  let current = { location: null, results: [], route: null, markers: [] };

  const styleFor = (selected, route) => ({
    radius: selected ? 14 : 8,
    color: selected ? "#111" : "#fff",
    weight: selected ? 4 : 2,
    fillColor: route.color,
    fillOpacity: selected ? 1 : 0.85,
  });

  let selectToken = 0;

  function select(index, { fit = true } = {}) {
    const { location, results, route, markers } = current;
    pathLayer.clearLayers();
    els.mapStatus.hidden = true;
    markers.forEach((marker, i) => {
      const selected = i === index;
      marker.setStyle(styleFor(selected, route));
      marker.unbindTooltip().bindTooltip(marker.labelText, {
        permanent: selected,
        direction: "top",
        offset: [0, -14],
        className: selected ? "station-label selected" : "station-label",
      });
      if (selected) marker.bringToFront().openTooltip();
    });
    const hit = results[index];
    if (!hit || !location) return;
    const { station } = hit;
    const to = [station.latitude, station.longitude];
    if (fit) m.fitBounds([[location.lat, location.lon], to], { padding: [60, 60], maxZoom: 17 });

    // Draw the real street-following route once it arrives. Ignore stale
    // responses if the user has picked another station meanwhile.
    const token = ++selectToken;
    walkingRoute(location.lat, location.lon, station)
      .then(({ path }) => {
        if (token !== selectToken) return;
        L.polyline(path, { color: "#fff", weight: 9, opacity: 0.9, interactive: false }).addTo(pathLayer);
        L.polyline(path, { color: "#1a73e8", weight: 5, opacity: 0.95, interactive: false }).addTo(pathLayer);
        if (fit) m.fitBounds(L.latLngBounds(path).extend(to), { padding: [50, 50], maxZoom: 17 });
      })
      .catch(() => {
        if (token !== selectToken) return;
        els.mapStatus.hidden = false;
        els.mapStatus.textContent =
          "The walking route couldn't be loaded. Use “Walking directions (Google Maps)” for the exact route.";
      });
  }

  return {
    render(location, results, route, lineStops = []) {
      stopsLayer.clearLayers();
      layer.clearLayers();
      // Small dots for every stop on the line; results get bigger markers on top.
      const shown = new Set(results.map((r) => r.station.complexId));
      for (const stop of lineStops) {
        if (shown.has(stop.complexId)) continue;
        L.circleMarker([stop.latitude, stop.longitude], {
          radius: 4,
          color: "#fff",
          weight: 1.5,
          fillColor: route.color,
          fillOpacity: 1,
        })
          .bindTooltip(stop.name, { direction: "top", offset: [0, -4], className: "station-label" })
          .on("click", (e) => L.DomEvent.stopPropagation(e)) // not a "drop a pin" click
          .addTo(stopsLayer);
      }
      pathLayer.clearLayers();
      const points = [];
      const markers = [];
      if (location) {
        const ll = [location.lat, location.lon];
        // True uncertainty radius, so a coarse fix looks coarse.
        L.circle(ll, {
          radius: Math.min(Math.max(location.accuracy || 40, 40), 5000),
          color: "#1a73e8",
          weight: 1,
          opacity: 0.5,
          fillColor: "#1a73e8",
          fillOpacity: 0.08,
          interactive: false,
        }).addTo(layer);
        // Draggable so the user can correct a fix that is off.
        L.marker(ll, { icon: userIcon, title: "Your location (drag to adjust)", keyboard: false, pane: "userPane", draggable: true })
          .bindTooltip(location.source === "gps" ? "You are here · drag to adjust" : location.label || "Your location", {
            direction: "bottom",
            offset: [0, 10],
            className: "user-label",
          })
          .on("dragend", (e) => {
            const p = e.target.getLatLng();
            setLocation({ lat: p.lat, lon: p.lng, source: "manual", label: "Adjusted location" });
            setStatus("Using the location you adjusted on the map.");
          })
          .addTo(layer);
        points.push(ll);
      }
      results.forEach(({ station, distanceMiles }, i) => {
        const ll = [station.latitude, station.longitude];
        const marker = L.circleMarker(ll, styleFor(false, route));
        marker.labelText = `${i === 0 ? "Nearest: " : ""}${station.name} · ${formatMiles(distanceMiles)}`;
        marker
          .on("click", (e) => {
            L.DomEvent.stopPropagation(e); // don't treat as "drop a pin"
            selectResult(i);
          })
          .addTo(layer);
        markers.push(marker);
        points.push(ll);
      });
      current = { location, results, route, markers };
      if (points.length > 1) m.fitBounds(points, { padding: [50, 50], maxZoom: 16 });
      else if (points.length === 1) m.setView(points[0], 15);
      else if (lineStops.length) {
        // Line chosen but no location yet: show the whole line.
        m.fitBounds(lineStops.map((s) => [s.latitude, s.longitude]), { padding: [30, 30] });
      }
    },
    select,
    element: m.getContainer(),
    refresh: () => m.invalidateSize(), // after its tab was hidden

  };
})();

// ---------- Route picker ----------

function renderRoutes() {
  els.routes.replaceChildren();
  const enabled = ROUTES.filter((r) => state.services.has(r.id));
  for (const route of ROUTES) {
    const supported = state.services.has(route.id);
    const btn = el(
      "button",
      {
        type: "button",
        role: "radio",
        class: `route-btn${route.label.length > 1 ? " small-label" : ""}`,
        "aria-checked": "false",
        "aria-label": `${route.label} train, ${route.name}${supported ? "" : " (no data)"}`,
        title: route.name,
        "data-route": route.id,
        tabindex: "-1",
      },
      route.label,
      route.sub ? el("span", { class: "route-sub" }, route.sub) : null,
    );
    btn.style.setProperty("--route-color", route.color);
    btn.style.setProperty("--route-text", route.text);
    btn.disabled = !supported;
    btn.addEventListener("click", () => selectRoute(route.id));
    els.routes.append(btn);
  }
  // Roving tabindex: the selected (or first enabled) button is tabbable.
  const first = els.routes.querySelector(`[data-route="${(enabled[0] || {}).id}"]`);
  if (first) first.tabIndex = 0;
}

els.routes.addEventListener("keydown", (e) => {
  const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const buttons = [...els.routes.querySelectorAll(".route-btn:not(:disabled)")];
  const idx = buttons.indexOf(document.activeElement);
  const next = buttons[(idx + keys[e.key] + buttons.length) % buttons.length];
  next.focus();
  selectRoute(next.dataset.route);
});

function selectRoute(routeId) {
  state.routeId = routeId;
  for (const btn of els.routes.querySelectorAll(".route-btn")) {
    const selected = btn.dataset.route === routeId;
    btn.setAttribute("aria-checked", String(selected));
    btn.tabIndex = selected ? 0 : -1;
  }
  const route = getRoute(routeId);
  els.routeName.textContent = route ? `Selected: ${route.label} — ${route.name}` : "";
  update();
}

// ---------- Results ----------

// Google Maps picks the shortest walking route between the two points.
// The origin is the location used in the app (GPS, typed place or pin).
function directionsUrl(location, station) {
  const params = new URLSearchParams({
    api: "1",
    origin: `${location.lat},${location.lon}`,
    destination: `${station.latitude},${station.longitude}`,
    travelmode: "walking",
  });
  return `https://www.google.com/maps/dir/?${params}`;
}

function resultItem({ station, distanceMiles, routed }, route, index) {
  const primary = index === 0;
  const meta = [BOROUGHS[station.borough] || station.borough];
  if (station.ada === 1) meta.push("ADA accessible");
  else if (station.ada === 2) meta.push("Partially accessible");
  const all = state.complexServices.get(station.complexId) || station.services;
  const others = all.filter((s) => s !== route.id).map((s) => getRoute(s)?.label || s);
  if (others.length) meta.push(`Also: ${[...new Set(others)].join(" ")}`);

  const item = el(
    "li",
    { class: `result${primary ? " primary" : ""}`, "data-index": String(index) },
    badge(route),
    el(
      "div",
      { class: "result-body" },
      primary ? el("span", { class: "result-label" }, "Nearest station") : null,
      el("p", { class: "result-name" }, station.name),
      el("p", { class: "result-meta" }, meta.join(" · ")),
      el(
        "div",
        { class: "result-actions" },
        el(
          "button",
          { type: "button", class: "link-btn show-on-map", "aria-pressed": "false" },
          "Show on map",
        ),
        el(
          "a",
          {
            class: "directions",
            href: directionsUrl(state.location, station),
            target: "_blank",
            rel: "noopener",
          },
          "Walking directions (Google Maps) ↗",
        ),
      ),
    ),
    el(
      "div",
      { class: "result-dist" },
      formatMiles(distanceMiles),
      el("small", {}, routed ? "walking route" : "estimate"),
    ),
  );
  // Whole card is a click target (mouse/touch); the button covers keyboard use.
  item.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    selectResult(index, { scroll: true });
  });
  return item;
}

function selectResult(index, { scroll = false, fit = true } = {}) {
  for (const card of els.results.querySelectorAll(".result")) {
    const selected = Number(card.dataset.index) === index;
    card.classList.toggle("selected", selected);
    const btn = card.querySelector(".show-on-map");
    btn.setAttribute("aria-pressed", String(selected));
    btn.textContent = selected ? "Shown on map ✓" : "Show on map";
  }
  if (!map) return;
  map.select(index, { fit });
  if (scroll) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    map.element.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }
}

function renderEmpty(message) {
  els.results.replaceChildren(el("p", { class: "empty" }, message));
}

function update() {
  const route = state.routeId ? getRoute(state.routeId) : null;

  if (state.dataError) {
    renderEmpty(state.dataError);
    return;
  }
  if (!state.location && !route) {
    renderEmpty("Set your location and choose a line to see results.");
    map?.render(null, [], null);
    return;
  }
  if (!state.location) {
    renderEmpty("Set your location to see the nearest stations.");
    map?.render(null, [], route, stopsOnLine(route));
    return;
  }
  if (!route) {
    renderEmpty("Choose a line above.");
    map?.render(state.location, [], null);
    return;
  }

  // Quick street-grid estimate first; then real walking distances for the
  // closest few candidates, which may re-order them.
  const { lat, lon } = state.location;
  const candidates = findNearestStations(state.stations, lat, lon, route.id, ROUTING_CANDIDATES);
  if (candidates.length === 0) {
    renderEmpty(`No stations in the data serve the ${route.label} (${route.name}).`);
    map?.render(state.location, [], route, stopsOnLine(route));
    return;
  }
  const estimate = candidates.slice(0, 3).map((c) => ({ ...c, routed: false }));
  const token = ++updateToken;
  if (estimate[0].distanceMiles > FAR_FROM_NYC_MILES) {
    showResults(estimate, route, "far");
    return;
  }
  showResults(estimate, route, "pending");
  walkingMiles(lat, lon, candidates.map((c) => c.station))
    .then((miles) => {
      if (token === updateToken) showResults(rerankByWalking(candidates, miles, 3), route, "routed");
    })
    .catch(() => {
      if (token === updateToken) showResults(estimate, route, "failed");
    });
}

const ROUTING_CANDIDATES = 8;
const ROUTING_NOTES = {
  pending: "Calculating walking routes along streets…",
  routed:
    "Distances are walking routes along streets (OpenStreetMap). Tap a station to see its route on the map.",
  failed:
    "Walking routes are unavailable right now, so distances are street-grid estimates. " +
    "Use “Walking directions (Google Maps)” for the exact route.",
  far: "This location looks far from New York City, so distances are rough estimates.",
};
let updateToken = 0;

function stopsOnLine(route) {
  return state.stations.filter((s) => s.services.includes(route.id));
}

function showResults(results, route, mode) {
  const [nearest, ...alts] = results;
  const children = [el("ul", { class: "results-list" }, resultItem(nearest, route, 0))];
  if (alts.length) {
    children.push(
      el("p", { class: "alt-heading" }, "Other nearby options"),
      el("ul", { class: "results-list" }, ...alts.map((r, i) => resultItem(r, route, i + 1))),
    );
  }
  children.push(el("p", { class: mode === "routed" || mode === "pending" ? "hint" : "notice" }, ROUTING_NOTES[mode]));
  els.results.replaceChildren(...children);
  els.results.setAttribute("aria-busy", String(mode === "pending"));
  map?.render(state.location, results, route, stopsOnLine(route));
  selectResult(0, { fit: false });
}

// ---------- Location ----------

function setLocation(location) {
  if (location.source !== "gps") stopWatching(); // a pin or address wins over GPS
  state.location = location;
  els.refreshBtn.hidden = location.source !== "gps";
  update();
}

function geoErrorMessage(err) {
  switch (err && err.code) {
    case 1:
      return "Location permission denied. Allow location for this site in your browser settings, or enter a location below.";
    case 2:
      return "Location unavailable. Your device couldn't determine a position — enter a location below or tap the map.";
    case 3:
      return "Finding your location timed out. Try “Refresh location”, or enter a location below.";
    default:
      return "Couldn't get your location. Enter a location below or tap the map.";
  }
}

function requestLocation() {
  if (!("geolocation" in navigator)) {
    setStatus("This browser doesn't support location. Enter a location below or tap the map.", "error");
    els.manual.open = true;
    return;
  }
  if (!window.isSecureContext) {
    setStatus("Location needs a secure (HTTPS) connection. Enter a location below instead.", "error");
    els.manual.open = true;
    return;
  }
  stopWatching();
  setStatus("Finding your location…");
  els.locateBtn.disabled = els.refreshBtn.disabled = true;
  const watch = { id: null, timer: null, best: null };
  geoWatch = watch;

  const finish = () => {
    stopWatching();
    if (watch.best) setStatus(...finalStatus(watch.best.accuracy));
  };

  watch.id = navigator.geolocation.watchPosition(
    (pos) => {
      if (geoWatch !== watch) return;
      const { latitude: lat, longitude: lon } = pos.coords;
      if (!isValidCoordinate(lat, lon)) return; // wait for a usable fix
      const accuracy = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : Infinity;
      // Only re-run the search on a clear improvement, so the routing server
      // isn't hit for every small jitter.
      if (!watch.best || accuracy < watch.best.accuracy * 0.75) {
        watch.best = { lat, lon, accuracy };
        setLocation({ lat, lon, accuracy, source: "gps" });
      }
      if (accuracy <= GOOD_ACCURACY_M) return finish();
      setStatus(`Improving accuracy… currently ±${Math.round(watch.best.accuracy)} m.`);
    },
    (err) => {
      if (geoWatch !== watch) return;
      if (watch.best && err.code !== 1) return finish(); // keep the best fix we got
      stopWatching();
      setStatus(geoErrorMessage(err), "error");
      els.manual.open = true;
    },
    GEO_OPTIONS,
  );
  // Stop after the refine window, but only once there's something to show;
  // otherwise the GEO_OPTIONS timeout usually reports the failure first.
  const started = Date.now();
  watch.timer = setTimeout(function check() {
    if (geoWatch !== watch) return;
    if (watch.best) return finish();
    if (Date.now() - started < REFINE_MS + GEO_OPTIONS.timeout) {
      watch.timer = setTimeout(check, 1000);
      return;
    }
    stopWatching();
    setStatus(geoErrorMessage({ code: 3 }), "error");
    els.manual.open = true;
  }, REFINE_MS);
}

let geoWatch = null; // the in-progress position watch, if any

function stopWatching() {
  if (!geoWatch) return;
  navigator.geolocation.clearWatch(geoWatch.id);
  clearTimeout(geoWatch.timer);
  geoWatch = null;
  els.locateBtn.disabled = els.refreshBtn.disabled = false;
}

function finalStatus(accuracy) {
  if (!Number.isFinite(accuracy)) return ["Using your current location."];
  const acc = `±${Math.round(accuracy)} m`;
  if (accuracy <= ROUGH_ACCURACY_M) return [`Using your current location (${acc}).`];
  if (accuracy <= POOR_ACCURACY_M) {
    return [`Using your current location (${acc}, approximate). If the blue dot is off, drag it to where you are.`, "warn"];
  }
  return [
    `Your device only gave an approximate location (${acc}), so the nearest station may be wrong. ` +
      "This usually means precise location is off: on iPhone, Settings → Privacy & Security → Location Services → " +
      "Safari Websites → turn on Precise Location; on a computer, turn on Wi-Fi and allow Location Services for your browser. " +
      "Or drag the blue dot, tap the map, or enter an address below.",
    "warn",
  ];
}

async function geocode(query) {
  // Bounded to the NYC area. Only the typed text is sent; no device location.
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "1",
    viewbox: "-74.30,40.95,-73.68,40.45",
    bounded: "1",
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
  const [hit] = await res.json();
  if (!hit) return null;
  return { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name, short: hit.name || hit.display_name.split(",")[0] };
}

els.manualForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.manualInput.value.trim();
  if (!text) {
    setStatus("Type an address, place, or coordinates.", "error");
    return;
  }
  const coords = parseLatLon(text);
  if (coords) {
    setStatus(`Using ${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}.`);
    setLocation({ ...coords, source: "manual", label: "Your location" });
    return;
  }
  if (/^[-\d.,\s]+$/.test(text)) {
    setStatus("Those coordinates aren't valid. Use “latitude, longitude”, e.g. 40.7359, -73.9911.", "error");
    return;
  }
  setStatus("Looking up that place…");
  try {
    const hit = await geocode(text);
    if (!hit || !isValidCoordinate(hit.lat, hit.lon)) {
      setStatus("No match found in New York City. Try a more specific address, or tap the map.", "error");
      return;
    }
    setStatus(`Using: ${hit.label}`);
    setLocation({ lat: hit.lat, lon: hit.lon, source: "manual", label: hit.short });
  } catch {
    setStatus("Place lookup is unavailable right now. Enter “lat, lon” or tap the map instead.", "error");
  }
});

// ---------- Page tabs (#find, #compare) ----------

let compare = null; // set once station data is in

function currentView() {
  return location.hash === "#compare" ? "compare" : "find";
}

function showView() {
  const view = currentView();
  for (const main of document.querySelectorAll("main[data-view]")) main.hidden = main.dataset.view !== view;
  for (const tab of document.querySelectorAll(".nav-tab")) {
    if (tab.dataset.view === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (view === "compare") compare?.show();
  else map?.refresh();
}

window.addEventListener("hashchange", () => {
  showView();
  window.scrollTo(0, 0);
});
showView();

// ---------- Header maps menu ----------

const mapsMenu = $("maps-menu");
const closeMapsMenu = () => mapsMenu.removeAttribute("open");
document.addEventListener("click", (e) => {
  if (!mapsMenu.contains(e.target)) closeMapsMenu();
});
mapsMenu.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && mapsMenu.open) {
    closeMapsMenu();
    mapsMenu.querySelector("summary").focus();
  }
});
mapsMenu.querySelector(".maps-list").addEventListener("click", (e) => {
  if (e.target.closest("a")) closeMapsMenu(); // the PDF opens in a new tab
});

els.locateBtn.addEventListener("click", requestLocation);
els.refreshBtn.addEventListener("click", requestLocation);

// ---------- Boot ----------

async function loadStations() {
  try {
    const res = await fetch("data/stations.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.stations = validateStationData(data);
    state.services = availableServices(state.stations);
    for (const s of state.stations) {
      const list = state.complexServices.get(s.complexId) || [];
      for (const r of s.services) if (!list.includes(r)) list.push(r);
      state.complexServices.set(s.complexId, list);
    }
    if (data.sourceDownloaded) els.dataDate.textContent = `, downloaded ${data.sourceDownloaded}`;
  } catch (err) {
    console.error(err);
    state.dataError = "Station data couldn't be loaded. Check your connection and reload the page.";
  }
  renderRoutes();
  update();
  if (state.dataError) {
    $("compare-results").replaceChildren(el("p", { class: "empty" }, state.dataError));
    return;
  }
  compare = initCompare(state.stations, state.services);
  if (currentView() === "compare") compare.show();
}

loadStations();
