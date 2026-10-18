// UI controller: location, route selection, results and map.
// Coordinates live only in the `state` object below; nothing is persisted.

import { formatMiles, isValidCoordinate, parseLatLon } from "./geo.js?v=6";
import { ROUTES, getRoute } from "./routes.js?v=6";
import { walkingMiles, walkingRoute } from "./routing.js?v=6";
import { availableServices, findNearestStations, rerankByWalking, validateStationData } from "./stations.js?v=6";

const NYC_CENTER = [40.7359, -73.9911];
const FAR_FROM_NYC_MILES = 20;
const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 };
const BOROUGHS = { M: "Manhattan", Bk: "Brooklyn", Bx: "Bronx", Q: "Queens", SI: "Staten Island" };

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

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child != null) node.append(child);
  }
  return node;
}

function badge(route) {
  return el(
    "span",
    {
      class: "badge",
      style: { background: route.color, color: route.text },
      "aria-label": `${route.name} (${route.label})`,
    },
    route.label,
  );
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
      '<span><i class="legend-path"></i>Walking route</span>';
    return div;
  };
  legend.addTo(m);

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
    render(location, results, route) {
      layer.clearLayers();
      pathLayer.clearLayers();
      const points = [];
      const markers = [];
      if (location) {
        const ll = [location.lat, location.lon];
        L.circle(ll, {
          radius: Math.min(Math.max(location.accuracy || 40, 40), 300),
          color: "#1a73e8",
          weight: 1,
          opacity: 0.5,
          fillColor: "#1a73e8",
          fillOpacity: 0.08,
          interactive: false,
        }).addTo(layer);
        L.marker(ll, { icon: userIcon, title: "Your location", keyboard: false, pane: "userPane" })
          .bindTooltip(location.source === "gps" ? "You are here" : location.label || "Your location", {
            direction: "bottom",
            offset: [0, 10],
            className: "user-label",
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
    },
    select,
    element: m.getContainer(),
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
    map?.render(null, [], null);
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
    map?.render(state.location, [], route);
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
  map?.render(state.location, results, route);
  selectResult(0, { fit: false });
}

// ---------- Location ----------

function setLocation(location) {
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
  setStatus("Finding your location…");
  els.locateBtn.disabled = els.refreshBtn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      els.locateBtn.disabled = els.refreshBtn.disabled = false;
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      if (!isValidCoordinate(lat, lon)) {
        setStatus("Your device reported an invalid position. Enter a location below.", "error");
        els.manual.open = true;
        return;
      }
      const acc = Number.isFinite(accuracy) ? ` (±${Math.round(accuracy)} m)` : "";
      setStatus(`Using your current location${acc}.`, accuracy > 500 ? "warn" : "");
      setLocation({ lat, lon, accuracy, source: "gps" });
    },
    (err) => {
      els.locateBtn.disabled = els.refreshBtn.disabled = false;
      setStatus(geoErrorMessage(err), "error");
      els.manual.open = true;
    },
    GEO_OPTIONS,
  );
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
}

loadStations();
