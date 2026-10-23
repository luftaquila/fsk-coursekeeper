import L from "leaflet";
import { SPRAY_OUTCOME_COLOR, SPRAY_OUTCOME_SYMBOL } from "../lib/rover-ui.mjs";

function pathLabel(text, latlng, color) {
  return L.marker(latlng, {
    icon: L.divIcon({
      className: "",
      html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:11px;font-weight:800;line-height:1;">${text}</span></div>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    }),
    interactive: false, zIndexOffset: 900,
  });
}

// The planned or running mission route with its dispense outcomes, and a
// recorded mission's planned and driven paths for replay.
export function createMissionLayer({ getMap, getRenderer, mission, review }) {
  let pathLine = null;
  let startMarker = null;
  let endMarker = null;
  let sprayMarkers = {};
  let replay = { planned: [], plannedPath: null, actualPath: null, marker: null };

  function clearPath() {
    const map = getMap();
    for (const layer of [pathLine, startMarker, endMarker]) {
      if (layer && map) { try { map.removeLayer(layer); } catch {} }
    }
    pathLine = startMarker = endMarker = null;
  }

  // Coloured green → red along the route so the travel order reads at a glance.
  function renderPath() {
    const map = getMap();
    if (!map) return;
    clearPath();
    const geometry = mission.pathGeometry.value;
    if (!geometry) return;
    const fullPath = geometry.points;
    const stops = [[34,197,94],[234,179,8],[249,115,22],[239,68,68]];
    const group = L.layerGroup();
    for (let i = 0; i < fullPath.length - 1; i++) {
      const t = fullPath.length <= 2 ? 0 : i / (fullPath.length - 2);
      const seg = t * (stops.length - 1);
      const idx = Math.min(Math.floor(seg), stops.length - 2);
      const lt = seg - idx;
      const r = Math.round(stops[idx][0] + (stops[idx + 1][0] - stops[idx][0]) * lt);
      const g = Math.round(stops[idx][1] + (stops[idx + 1][1] - stops[idx][1]) * lt);
      const b = Math.round(stops[idx][2] + (stops[idx + 1][2] - stops[idx][2]) * lt);
      L.polyline([[fullPath[i].lat, fullPath[i].lng], [fullPath[i + 1].lat, fullPath[i + 1].lng]], {
        color: `rgb(${r},${g},${b})`, weight: 4, opacity: 1,
      }).addTo(group);
    }
    pathLine = group.addTo(map);
    const origin = fullPath[0];
    startMarker = pathLabel(geometry.returnOnly ? "R" : "S", [origin.lat, origin.lng], "#22c55e").addTo(map);
    const end = fullPath[fullPath.length - 1];
    endMarker = pathLabel("E", [end.lat, end.lng], "#ef4444").addTo(map);
  }

  function renderSpray() {
    const map = getMap();
    if (!map) return;
    const results = mission.sprayResults.value;
    const waypoints = mission.pathWaypoints.value;
    for (const [idx, marker] of Object.entries(sprayMarkers)) {
      if (!results.has(Number(idx))) {
        map.removeLayer(marker);
        delete sprayMarkers[idx];
      }
    }
    for (const [idx, result] of results.entries()) {
      if (idx >= waypoints.length) continue;
      const wp = waypoints[idx];
      const color = SPRAY_OUTCOME_COLOR[result.outcome] || "#888";
      const symbol = SPRAY_OUTCOME_SYMBOL[result.outcome] || "?";
      if (sprayMarkers[idx]) map.removeLayer(sprayMarkers[idx]);
      sprayMarkers[idx] = L.marker([wp.lat, wp.lng], {
        icon: L.divIcon({
          className: "",
          // White halo + dark drop shadow so the marker stays legible over green
          // satellite terrain or the planned-path polyline.
          html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:3px solid #fff;outline:1px solid rgba(0,0,0,0.55);box-shadow:0 2px 6px rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,0.6);">${symbol}</div>`,
          iconSize: [22, 22], iconAnchor: [11, 26], // above the waypoint
        }),
        interactive: false, zIndexOffset: 950,
      }).addTo(map);
    }
  }

  function hideLive() {
    const map = getMap();
    clearPath();
    if (map) for (const m of Object.values(sprayMarkers)) { try { map.removeLayer(m); } catch {} }
    sprayMarkers = {};
  }

  /* ── Replay ───────────────────────────────────────── */
  function clearReplay() {
    const map = getMap();
    if (map) {
      for (const m of replay.planned) { try { map.removeLayer(m); } catch {} }
      for (const layer of [replay.plannedPath, replay.actualPath, replay.marker]) {
        if (layer) { try { map.removeLayer(layer); } catch {} }
      }
    }
    replay = { planned: [], plannedPath: null, actualPath: null, marker: null };
  }

  // Planned waypoints draw on the shared cone canvas so a long route stays smooth.
  function renderReplay() {
    const map = getMap();
    const detail = review.missionDetail.value;
    if (!map || !detail) return;
    clearReplay();
    const waypoints = detail.waypoints || [];
    waypoints.forEach((wp, i) => {
      replay.planned.push(L.circleMarker([wp.lat, wp.lng], {
        renderer: getRenderer(), radius: 9, color: "#fff", weight: 2,
        fillColor: "#8b5cf6", interactive: false, label: i + 1,
      }).addTo(map));
    });
    if (waypoints.length > 0) {
      replay.plannedPath = L.polyline(waypoints.map((w) => [w.lat, w.lng]), {
        color: "#8b5cf6", weight: 2, dashArray: "6 4", opacity: 0.75,
      }).addTo(map);
    }
    const samples = review.missionSamples.value.filter((s) => s.lat != null && s.lng != null);
    if (samples.length >= 2) {
      replay.actualPath = L.polyline(samples.map((s) => [s.lat, s.lng]), {
        color: "#ef4444", weight: 3, opacity: 0.9,
      }).addTo(map);
    }
    const all = [...waypoints.map((w) => [w.lat, w.lng]), ...samples.map((s) => [s.lat, s.lng])];
    if (all.length > 0) map.fitBounds(L.latLngBounds(all), { padding: [40, 40] });
    updateReplayMarker();
  }

  function updateReplayMarker() {
    const map = getMap();
    if (!map || review.missionSamples.value.length === 0) return;
    const s = review.currentSample.value;
    if (!s || s.lat == null) {
      if (replay.marker) { map.removeLayer(replay.marker); replay.marker = null; }
      return;
    }
    const color = s.nav_state === "ERROR" ? "#ef4444" : s.nav_state === "SPRAYING" ? "#f59e0b" : "#22c55e";
    if (replay.marker) {
      replay.marker.setLatLng([s.lat, s.lng]);
      return;
    }
    replay.marker = L.marker([s.lat, s.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 0 2px ${color};"></div>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
      }),
      interactive: false, zIndexOffset: 1000,
    }).addTo(map);
  }

  return { renderPath, renderSpray, hideLive, renderReplay, updateReplayMarker, clearReplay };
}
