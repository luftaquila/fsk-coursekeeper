import L from "leaflet";
import { buildSideRanks } from "../../cone-index.mjs";
import { courseDisplayState } from "../lib/course-display.mjs";
import { SIDE_COLORS, coneIcon, highlightIcon, multiSelectIcon } from "../lib/cone-render.mjs";

// The cones of every visible course. Cones draw as canvas dots — one redraw for
// hundreds of cones instead of hundreds of DOM transforms — except under the
// Move tool, where the active course needs draggable DOM markers. Taps on canvas
// dots are resolved by the map (nearest cone), so selection works either way.
export function createConeLayer({ getMap, getRenderer, course, editor, notifyError }) {
  const { courses, conesMap, activeCourseId, visibility, activeConeSideRanks } = course;
  const { selectedConeId, multiSelectedIds } = editor;
  let markers = {};
  // Held while a gesture moves markers locally, so an echo cannot redraw them mid-move.
  let suppressed = false;
  let multiDrag = null; // { origin: L.LatLng, starts: Map<id, L.LatLng> }

  const designing = () => editor.mode.value === "design";
  const dragging = () => designing() && editor.tool.value === "move" && !editor.rotating.value;

  // Canvas dot: the selection shows as the ring colour — amber for the single
  // selection, sky for the multi-selection. Only Design shows a selection.
  function coneCircle(cone, num, isActive) {
    let ringColor = "#fff", ringRatio = 0.1;
    if (isActive && designing()) {
      if (selectedConeId.value === cone.id) { ringColor = "#fbbf24"; ringRatio = 0.16; }
      else if (multiSelectedIds.value.has(cone.id)) { ringColor = "#38bdf8"; ringRatio = 0.16; }
    }
    return L.circleMarker([cone.lat, cone.lng], {
      renderer: getRenderer(),
      radius: 9,
      color: "#fff",
      weight: 2,
      fillColor: SIDE_COLORS[cone.side],
      fillOpacity: isActive ? 1 : 0.45,
      opacity: isActive ? 1 : 0.45,
      interactive: false,
      label: num,
      ringColor,
      ringRatio,
    });
  }

  function iconFor(cone, num, isActive) {
    if (isActive && selectedConeId.value === cone.id) return highlightIcon(cone.side, num);
    if (isActive && multiSelectedIds.value.has(cone.id)) return multiSelectIcon(cone.side, num);
    return coneIcon(cone.side, num, isActive);
  }

  function attachDrag(marker, cone) {
    marker.on("click", (e) => {
      if (e.originalEvent?.shiftKey) editor.toggleInSelection(cone.id);
      else editor.selectCone(cone.id);
    });
    marker.on("dragstart", () => {
      if (multiSelectedIds.value.has(cone.id) && multiSelectedIds.value.size > 1) {
        suppressed = true;
        const starts = new Map();
        for (const id of multiSelectedIds.value) {
          if (id === cone.id) continue;
          const c = (conesMap.value[activeCourseId.value] || []).find((cc) => cc.id === id);
          if (c) starts.set(id, L.latLng(c.lat, c.lng));
        }
        multiDrag = { origin: L.latLng(cone.lat, cone.lng), starts };
      }
    });
    marker.on("drag", () => {
      if (!multiDrag) return;
      const pos = marker.getLatLng();
      const dLat = pos.lat - multiDrag.origin.lat;
      const dLng = pos.lng - multiDrag.origin.lng;
      for (const [id, start] of multiDrag.starts) {
        markerOf(id)?.setLatLng([start.lat + dLat, start.lng + dLng]);
      }
    });
    marker.on("dragend", async () => {
      const { lat, lng } = marker.getLatLng();
      if (multiDrag) {
        const { origin, starts } = multiDrag;
        multiDrag = null;
        const dLat = lat - origin.lat;
        const dLng = lng - origin.lng;
        const updates = [{ id: cone.id, lat, lng }];
        const before = [{ id: cone.id, lat: origin.lat, lng: origin.lng }];
        for (const [id, start] of starts) {
          updates.push({ id, lat: start.lat + dLat, lng: start.lng + dLng });
          before.push({ id, lat: start.lat, lng: start.lng });
        }
        try {
          await course.moveCones(updates, before, `Move ${before.length} cones`);
        } catch (err) {
          notifyError(`Failed to save cone position: ${err.message}`);
          marker.setLatLng([cone.lat, cone.lng]);
          for (const [id, start] of starts) markerOf(id)?.setLatLng([start.lat, start.lng]);
        }
        suppressed = false;
        rebuild();
        return;
      }
      try {
        await course.moveCones([{ id: cone.id, lat, lng }], [{ id: cone.id, lat: cone.lat, lng: cone.lng }], "Move cone");
      } catch (err) {
        notifyError(`Failed to save cone position: ${err.message}`);
        marker.setLatLng([cone.lat, cone.lng]);
      }
    });
  }

  // Redraws every course, or only `onlyCourseId` when one course changed.
  function rebuild(onlyCourseId = null) {
    const map = getMap();
    if (!map) return;
    if (onlyCourseId != null) {
      for (const key of Object.keys(markers)) {
        if (key.startsWith(`${onlyCourseId}-`)) { map.removeLayer(markers[key]); delete markers[key]; }
      }
    } else {
      clear();
    }
    const dom = dragging();
    for (const c of courses.value) {
      if (onlyCourseId != null && c.id !== onlyCourseId) continue;
      if (courseDisplayState(c.id, activeCourseId.value, visibility.value) === "hidden") continue;
      const cones = conesMap.value[c.id] || [];
      const isActive = c.id === activeCourseId.value;
      const ranks = buildSideRanks(cones);
      for (const cone of cones) {
        const num = ranks.get(cone.id) || 0;
        let marker;
        if (dom) {
          // Non-active cones opt out of hit-testing so Leaflet doesn't probe
          // every marker on every touchmove.
          marker = L.marker([cone.lat, cone.lng], { icon: iconFor(cone, num, isActive), draggable: isActive, interactive: isActive });
          if (isActive) attachDrag(marker, cone);
        } else {
          marker = coneCircle(cone, num, isActive);
        }
        markers[`${c.id}-${cone.id}`] = marker.addTo(map);
      }
    }
  }

  // Repaints the selection highlight: DOM markers re-icon in place, canvas dots redraw.
  function refreshSelection() {
    if (!getMap()) return;
    if (!dragging()) { rebuild(); return; }
    const aid = activeCourseId.value;
    const ranks = activeConeSideRanks.value;
    for (const cone of conesMap.value[aid] || []) {
      const m = markers[`${aid}-${cone.id}`];
      if (m?.setIcon) m.setIcon(iconFor(cone, ranks.get(cone.id) || 0, true));
    }
  }

  function clear() {
    const map = getMap();
    if (map) for (const m of Object.values(markers)) { try { map.removeLayer(m); } catch {} }
    markers = {};
  }

  function markerOf(coneId) {
    return markers[`${activeCourseId.value}-${coneId}`] || null;
  }

  return {
    rebuild, refreshSelection, clear, markerOf,
    isSuppressed: () => suppressed,
    suppress(value) { suppressed = value; },
  };
}
