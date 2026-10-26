// "Compare lines" tab: highlight up to three lines on their own map and
// list the stations where you can transfer between them.

import { badge, el } from "./dom.js?v=14";
import { ROUTES, getRoute } from "./routes.js?v=14";
import { BOROUGHS, sharedStations } from "./stations.js?v=14";

const MAX_LINES = 3;
// Used when a picked line's MTA color is already on the map (1, 2 and 3 are
// all red). None of these is close to an MTA line color.
const FALLBACK_COLORS = ["#111111", "#00B5E2", "#FF7EB6"];
// Decreasing widths, so lines that share track show as nested stripes.
const WEIGHTS = [11, 7, 3];
const NYC_BOUNDS = [[40.5, -74.26], [40.92, -73.7]];

export function initCompare(stations, services) {
  const $ = (id) => document.getElementById(id);
  const els = {
    routes: $("compare-routes"),
    picked: $("compare-picked"),
    clear: $("compare-clear"),
    status: $("compare-status"),
    results: $("compare-results"),
  };
  const picks = []; // [{ route, color }] in the order chosen
  let lines = null; // route id -> [[lat, lon], ...][] once loaded
  let linesPromise = null;

  // ---------- Map ----------

  const L = window.L;
  let map = null;
  let lineLayer, stopLayer, transferLayer;

  function ensureMap() {
    if (map) return true;
    if (!L) {
      showStatus("The map could not be loaded. Transfer stations are still listed below.");
      return false;
    }
    map = L.map("compare-map").fitBounds(NYC_BOUNDS);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · ' +
        "Lines: MTA GTFS",
    }).addTo(map);
    lineLayer = L.layerGroup().addTo(map);
    stopLayer = L.layerGroup().addTo(map);
    transferLayer = L.layerGroup().addTo(map);
    return true;
  }

  function showStatus(message) {
    els.status.hidden = !message;
    els.status.textContent = message || "";
  }

  function loadLines() {
    linesPromise ||= fetch("data/lines.json", { cache: "no-cache" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        lines = {};
        for (const [id, parts] of Object.entries(data.routes)) {
          lines[id] = parts.map((flat) => {
            const path = [];
            for (let i = 0; i < flat.length; i += 2) path.push([flat[i], flat[i + 1]]);
            return path;
          });
        }
      })
      .catch((err) => {
        console.error(err);
        linesPromise = null; // allow a retry on the next pick
        showStatus("Line paths couldn't be loaded, so only stations are shown.");
      });
    return linesPromise;
  }

  // ---------- Picker ----------

  for (const route of ROUTES) {
    const supported = services.has(route.id);
    const btn = el(
      "button",
      {
        type: "button",
        role: "checkbox",
        class: `route-btn${route.label.length > 1 ? " small-label" : ""}`,
        "aria-checked": "false",
        "aria-label": `${route.label} train, ${route.name}${supported ? "" : " (no data)"}`,
        title: route.name,
        "data-route": route.id,
      },
      route.label,
      route.sub ? el("span", { class: "route-sub" }, route.sub) : null,
    );
    btn.style.setProperty("--route-color", route.color);
    btn.style.setProperty("--route-text", route.text);
    btn.disabled = !supported;
    btn.addEventListener("click", () => toggle(route.id));
    els.routes.append(btn);
  }

  els.clear.addEventListener("click", () => {
    picks.length = 0;
    render();
  });

  function colorFor(route) {
    const used = new Set(picks.map((p) => p.color));
    if (!used.has(route.color)) return route.color;
    return FALLBACK_COLORS.find((c) => !used.has(c));
  }

  function toggle(routeId) {
    const i = picks.findIndex((p) => p.route.id === routeId);
    if (i >= 0) {
      picks.splice(i, 1);
    } else if (picks.length >= MAX_LINES) {
      showStatus(`You can compare up to ${MAX_LINES} lines. Tap a highlighted line to remove it.`);
      return;
    } else {
      const route = getRoute(routeId);
      picks.push({ route, color: colorFor(route) });
    }
    showStatus("");
    render();
    if (picks.length && !lines) loadLines().then(() => render({ fit: true }));
  }

  // ---------- Rendering ----------

  function render({ fit = true } = {}) {
    for (const btn of els.routes.querySelectorAll(".route-btn")) {
      const pick = picks.find((p) => p.route.id === btn.dataset.route);
      btn.setAttribute("aria-checked", String(Boolean(pick)));
      if (pick) btn.style.setProperty("--pick-color", pick.color);
      else btn.style.removeProperty("--pick-color");
    }
    els.clear.hidden = picks.length === 0;
    els.picked.replaceChildren(
      ...picks.map(({ route, color }) =>
        el(
          "span",
          { class: "compare-chip" },
          el("i", { class: "compare-swatch", style: { background: color }, "aria-hidden": "true" }),
          badge(route),
          route.name,
        ),
      ),
    );
    const transfers = renderResults();
    if (map) renderMap(transfers, fit);
  }

  function stationItem(s) {
    const others = s.services.filter((r) => !picks.some((p) => p.route.id === r));
    const meta = [BOROUGHS[s.borough] || s.borough];
    if (others.length) meta.push(`Also: ${others.map((r) => getRoute(r)?.label || r).join(" ")}`);
    const item = el(
      "li",
      { class: "result compare-result" },
      el(
        "div",
        { class: "result-body" },
        el("p", { class: "result-name" }, s.name),
        el("p", { class: "result-meta" }, meta.join(" · ")),
      ),
      el("span", { class: "compare-badges" }, ...picks.filter((p) => s.services.includes(p.route.id)).map((p) => badge(p.route))),
    );
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `Show ${s.name} on the map`);
    const focus = () => focusStation(s);
    item.addEventListener("click", focus);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        focus();
      }
    });
    return item;
  }

  function stationList(list, emptyText) {
    if (!list.length) return el("p", { class: "empty" }, emptyText);
    return el("ul", { class: "results-list" }, ...list.map(stationItem));
  }

  const labels = (ps) => ps.map((p) => p.route.label).join(" and ");

  function renderResults() {
    if (picks.length === 0) {
      els.results.replaceChildren(el("p", { class: "empty" }, "Pick two or three lines to see where they connect."));
      return [];
    }
    if (picks.length === 1) {
      els.results.replaceChildren(el("p", { class: "empty" }, "Pick another line to see the transfer stations."));
      return [];
    }
    const ids = picks.map((p) => p.route.id);
    const all = sharedStations(stations, ids);
    const children = [];
    const transfers = new Map(all.map((s) => [s.complexId, s]));

    if (picks.length === 2) {
      children.push(
        el("p", { class: "alt-heading" }, `Transfer stations between ${labels(picks)} (${all.length})`),
        stationList(all, "No intersection stations. These lines don't share a station."),
      );
    } else {
      children.push(
        el("p", { class: "alt-heading" }, `Served by all ${picks.length} lines (${all.length})`),
        stationList(all, "No intersection stations shared by all of these lines."),
      );
      // Pairwise transfers show how to connect when no station has all three.
      for (let i = 0; i < picks.length; i++) {
        for (let j = i + 1; j < picks.length; j++) {
          const pair = [picks[i], picks[j]];
          const shared = sharedStations(stations, pair.map((p) => p.route.id)).filter(
            (s) => !all.some((a) => a.complexId === s.complexId),
          );
          for (const s of shared) transfers.set(s.complexId, s);
          children.push(
            el("p", { class: "alt-heading" }, `Only ${labels(pair)} (${shared.length})`),
            stationList(shared, "No other intersection stations."),
          );
        }
      }
    }
    children.push(
      el(
        "p",
        { class: "hint" },
        "Transfers are stations or connected complexes where both lines stop during the day. " +
          "Nights, weekends and planned work can change this. Tap a station to see it on the map.",
      ),
    );
    els.results.replaceChildren(...children);
    return [...transfers.values()];
  }

  function renderMap(transfers, fit) {
    lineLayer.clearLayers();
    stopLayer.clearLayers();
    transferLayer.clearLayers();
    const bounds = L.latLngBounds([]);

    // All white casings first, then the colors: otherwise a later line's
    // casing would hide an earlier, wider line on shared track.
    picks.forEach(({ route }, i) => {
      for (const path of lines?.[route.id] || []) {
        L.polyline(path, { color: "#fff", weight: WEIGHTS[i] + 4, opacity: 0.9, interactive: false }).addTo(lineLayer);
        bounds.extend(path);
      }
    });
    picks.forEach(({ route, color }, i) => {
      for (const path of lines?.[route.id] || []) {
        L.polyline(path, { color, weight: WEIGHTS[i], opacity: 1, lineCap: "round", interactive: false }).addTo(lineLayer);
      }
    });
    picks.forEach(({ route, color }) => {
      for (const s of stations) {
        if (!s.services.includes(route.id)) continue;
        L.circleMarker([s.latitude, s.longitude], {
          radius: 3,
          color: "#fff",
          weight: 1,
          fillColor: color,
          fillOpacity: 1,
        })
          .bindTooltip(`${s.name} (${route.label})`, { direction: "top", offset: [0, -4], className: "station-label" })
          .addTo(stopLayer);
        bounds.extend([s.latitude, s.longitude]);
      }
    });

    for (const s of transfers) {
      const marker = L.circleMarker([s.latitude, s.longitude], {
        radius: 9,
        color: "#111",
        weight: 3,
        fillColor: "#fff",
        fillOpacity: 1,
      }).bindTooltip(`Transfer: ${s.name}`, { direction: "top", offset: [0, -10], className: "station-label selected" });
      marker.complexId = s.complexId;
      marker.addTo(transferLayer);
    }

    if (fit) {
      map.invalidateSize(); // the tab may have been resized while hidden
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
      else if (!picks.length) map.fitBounds(NYC_BOUNDS);
    }
  }

  function focusStation(s) {
    if (!map) return;
    map.setView([s.latitude, s.longitude], Math.max(map.getZoom(), 15));
    transferLayer.eachLayer((m) => {
      if (m.complexId === s.complexId) m.openTooltip();
    });
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    map.getContainer().scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }

  render();

  // The panel lives on its own tab. Leaflet can't measure a hidden container,
  // so the map is made, and resized, each time the tab is shown.
  return {
    show() {
      if (ensureMap()) render({ fit: true });
    },
  };
}
