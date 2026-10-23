import L from "leaflet";
import { isValidRoverPos } from "../lib/rover-ui.mjs";

// Live-marker colours/labels per device. The GPS unit (teal) is the preferred
// cone-capture source; the rover (purple) is the fallback.
const MARKER_COLORS = { rover: "#a855f7", receiver: "#14b8a6" };
const MARKER_LABELS = { rover: "Rover", receiver: "GPS unit" };
const FOLLOW_MIN_MS = 150; // cap follow-pans to ~6-7/s — each pan redraws the cone canvas

function deviceIcon(kind) {
  const color = MARKER_COLORS[kind] || MARKER_COLORS.rover;
  return L.divIcon({
    className: "",
    html: `<div style="width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid ${color};"></div>`,
    iconSize: [12, 12], iconAnchor: [6, 6],
  });
}

// Fixed magenta diamond for a surveyed base-station point: amber ring for the
// active base, sky-blue ring for the point selected in the list. Shape and
// colour differ from cones and device markers so a base point never reads as one.
function surveyPointIcon(isBase, isSelected) {
  const size = isBase ? 18 : 14;
  const cls = ["survey-marker", isBase && "is-base", isSelected && "selected"].filter(Boolean).join(" ");
  return L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

// One live marker per device (both show when both report a position), the
// surveyed base-station points, and map follow.
export function createDeviceLayer({ getMap, panToVisibleCenter, gps, editor, isLive }) {
  const markers = { rover: null, receiver: null };
  let surveyLayer = null;
  let followTimer = null;
  let followTarget = null;
  let followLastPan = 0;

  // Follow-pan, throttled and not animated: each pan redraws the cone canvas,
  // and the rover's position events can arrive >10×/s.
  function scheduleFollow(lat, lng) {
    if (!isValidRoverPos(lat, lng) || !isLive()) return;
    followTarget = { lat, lng };
    if (followTimer != null) return;
    const wait = Math.max(0, FOLLOW_MIN_MS - (performance.now() - followLastPan));
    followTimer = setTimeout(() => {
      followTimer = null;
      followLastPan = performance.now();
      if (!getMap() || !followTarget) return;
      const t = followTarget;
      followTarget = null;
      panToVisibleCenter(t.lat, t.lng, { animate: false });
    }, wait);
  }

  // Creates, moves, or (for an invalid position) removes one device's marker.
  // Live layers stay off the map while a replay owns it.
  function setMarker(kind, lat, lng) {
    const map = getMap();
    if (!map || !isLive()) return;
    const existing = markers[kind];
    if (!isValidRoverPos(lat, lng)) {
      if (existing) { try { map.removeLayer(existing); } catch {} markers[kind] = null; }
      return;
    }
    if (kind === "receiver" && editor.followReceiver.value) scheduleFollow(lat, lng);
    if (existing) { existing.setLatLng([lat, lng]); return; }
    const m = L.marker([lat, lng], { icon: deviceIcon(kind), zIndexOffset: 1000, interactive: false }).addTo(map);
    m.bindTooltip(MARKER_LABELS[kind], { direction: "top", offset: [0, -8], permanent: true, className: `device-tooltip ${kind}` });
    markers[kind] = m;
  }

  // The unit is a moving position source only in capture mode; as a base station
  // it is a fixed correction source, so its marker hides.
  function syncReceiver() {
    const rc = gps.receiver.value;
    const pos = rc && rc.mode === "capture" ? rc.last_position : null;
    setMarker("receiver", pos?.lat, pos?.lng);
  }

  function renderSurveyPoints(visible) {
    const map = getMap();
    if (!map) return;
    if (surveyLayer) {
      surveyLayer.clearLayers();
      try { map.removeLayer(surveyLayer); } catch {}
      surveyLayer = null;
    }
    if (!visible || !isLive()) return;
    const layer = L.layerGroup();
    for (const p of gps.surveyedPoints.value) {
      if (!isValidRoverPos(p.lat, p.lng)) continue;
      const isBase = gps.gpsConfig.value.active_base_point_id === p.id;
      const m = L.marker([p.lat, p.lng], {
        icon: surveyPointIcon(isBase, editor.selectedSurveyPointId.value === p.id),
        zIndexOffset: 900, interactive: true, keyboard: false,
      });
      m.on("click", () => { editor.selectedSurveyPointId.value = p.id; });
      // Point names are operator input; a text node keeps them out of innerHTML.
      const tip = document.createElement("span");
      tip.textContent = p.name;
      m.bindTooltip(tip, { direction: "top", offset: [0, -12], permanent: true, className: "survey-tooltip" });
      layer.addLayer(m);
    }
    surveyLayer = layer.addTo(map);
  }

  // Detaches the device markers (a replay takes the map). Nulling the refs lets
  // setMarker add them again afterwards.
  function hide() {
    const map = getMap();
    for (const k of ["rover", "receiver"]) {
      if (markers[k]) { try { map?.removeLayer(markers[k]); } catch {} markers[k] = null; }
    }
    renderSurveyPoints(false);
  }

  function dispose() {
    if (followTimer != null) clearTimeout(followTimer);
  }

  return { setMarker, syncReceiver, scheduleFollow, renderSurveyPoints, hide, dispose };
}
