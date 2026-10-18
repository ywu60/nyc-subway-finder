// UI controller: location, route selection, results and map.
// Coordinates live only in the `state` object below; nothing is persisted.

import { formatMiles, isValidCoordinate, parseLatLon } from "./geo.js";
import { ROUTES, getRoute } from "./routes.js";
import { availableServices, findNearestStations, validateStationData } from "./stations.js";

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
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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
  const userIcon = L.divIcon({ className: "", html: '<div class="user-dot"></div>', iconSize: [18, 18] });

  m.on("click", (e) => {
    setLocation({ lat: e.latlng.lat, lon: e.latlng.lng, source: "manual" });
    setStatus("Using the pin you placed on the map.");
  });

  return {
    render(location, results, route) {
      layer.clearLayers();
      const points = [];
      if (location) {
        const ll = [location.lat, location.lon];
        L.marker(ll, { icon: userIcon, title: "Your location", keyboard: false, zIndexOffset: 1000 })
          .bindTooltip(location.source === "gps" ? "You are here" : "Selected location")
          .addTo(layer);
        points.push(ll);
      }
      results.forEach(({ station, distanceMiles }, i) => {
        const ll = [station.latitude, station.longitude];
        const primary = i === 0;
        L.circleMarker(ll, {
          radius: primary ? 12 : 8,
          color: primary ? "#111" : "#fff",
          weight: primary ? 4 : 2,
          fillColor: route.color,
          fillOpacity: 1,
        })
          .bindTooltip(`${primary ? "Nearest: " : ""}${station.name} · ${formatMiles(distanceMiles)}`, {
            permanent: primary,
            direction: "top",
            offset: [0, -10],
          })
          .addTo(layer);
        points.push(ll);
      });
      if (points.length > 1) m.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
      else if (points.length === 1) m.setView(points[0], 15);
    },
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

function directionsUrl(station) {
  return `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${station.latitude},${station.longitude}`;
}

function resultItem({ station, distanceMiles }, route, primary) {
  const meta = [BOROUGHS[station.borough] || station.borough];
  if (station.ada === 1) meta.push("ADA accessible");
  else if (station.ada === 2) meta.push("Partially accessible");
  const all = state.complexServices.get(station.complexId) || station.services;
  const others = all.filter((s) => s !== route.id).map((s) => getRoute(s)?.label || s);
  if (others.length) meta.push(`Also: ${[...new Set(others)].join(" ")}`);

  return el(
    "li",
    { class: `result${primary ? " primary" : ""}` },
    badge(route),
    el(
      "div",
      { class: "result-body" },
      primary ? el("span", { class: "result-label" }, "Nearest station") : null,
      el("p", { class: "result-name" }, station.name),
      el("p", { class: "result-meta" }, meta.join(" · ")),
      primary
        ? el(
            "a",
            { class: "directions", href: directionsUrl(station), target: "_blank", rel: "noopener" },
            "Walking directions (Google Maps) ↗",
          )
        : null,
    ),
    el(
      "div",
      { class: "result-dist" },
      formatMiles(distanceMiles),
      el("small", {}, "straight-line"),
    ),
  );
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

  const results = findNearestStations(state.stations, state.location.lat, state.location.lon, route.id, 3);
  if (results.length === 0) {
    renderEmpty(`No stations in the data serve the ${route.label} (${route.name}).`);
    map?.render(state.location, [], route);
    return;
  }

  const [nearest, ...alts] = results;
  const children = [el("ul", { class: "results-list" }, resultItem(nearest, route, true))];
  if (alts.length) {
    children.push(
      el("p", { class: "alt-heading" }, "Other nearby options"),
      el("ul", { class: "results-list" }, ...alts.map((r) => resultItem(r, route, false))),
    );
  }
  if (nearest.distanceMiles > FAR_FROM_NYC_MILES) {
    children.push(
      el("p", { class: "notice" }, "This location looks far from New York City, so these distances are large."),
    );
  }
  els.results.replaceChildren(...children);
  map?.render(state.location, results, route);
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
  return { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name };
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
    setLocation({ ...coords, source: "manual" });
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
    setLocation({ lat: hit.lat, lon: hit.lon, source: "manual" });
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
