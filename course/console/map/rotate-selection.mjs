import { ref } from "vue";
import L from "leaflet";

const ROTATE_RADIUS_PX = 72; // resting screen distance of the handle from the pivot

function normalizeDeg(d) {
  d = d % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// Spins the multi-selection rigidly around its centroid, with a draggable handle
// or by an exact angle. Rotation happens in container-pixel space (Web Mercator
// is locally conformal) so the on-screen shape is kept exactly; the rotated
// points become lat/lng again on commit.
export function createRotateSelection({ getMap, course, editor, cones, notifyError }) {
  const { conesMap, activeCourseId } = course;
  const { multiSelectedIds } = editor;
  const angle = ref(0); // live delta while dragging, degrees, clockwise positive
  let pivot = null;
  let pivotMarker = null;
  let handleMarker = null;
  let guide = null;
  let startVectors = null;   // Map<id, {x,y}> cone offset from the pivot at drag start
  let startPositions = null; // Map<id, {lat,lng}> for rollback on save failure
  let startBearing = 0;

  function selectedCones() {
    return (conesMap.value[activeCourseId.value] || []).filter((c) => multiSelectedIds.value.has(c.id));
  }

  function centroid() {
    const list = selectedCones();
    if (list.length === 0) return null;
    let lat = 0, lng = 0;
    for (const c of list) { lat += c.lat; lng += c.lng; }
    return L.latLng(lat / list.length, lng / list.length);
  }

  function teardown() {
    const map = getMap();
    for (const layer of [guide, pivotMarker, handleMarker]) {
      if (layer && map) { try { map.removeLayer(layer); } catch {} }
    }
    guide = pivotMarker = handleMarker = null;
    startVectors = null;
    startPositions = null;
  }

  // (Re)anchors the handle at the selection's centroid.
  function setup() {
    teardown();
    const map = getMap();
    if (!map) return;
    pivot = centroid();
    if (!pivot) return;
    const pivotPt = map.latLngToContainerPoint(pivot);
    const handleLatLng = map.containerPointToLatLng(L.point(pivotPt.x, pivotPt.y - ROTATE_RADIUS_PX));
    guide = L.polyline([pivot, handleLatLng], {
      color: "#38bdf8", weight: 2, dashArray: "4 4", interactive: false,
    }).addTo(map);
    pivotMarker = L.marker(pivot, {
      icon: L.divIcon({ className: "", html: `<div class="rotate-pivot"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
      interactive: false, zIndexOffset: 900,
    }).addTo(map);
    handleMarker = L.marker(handleLatLng, {
      icon: L.divIcon({ className: "", html: `<div class="rotate-handle">↻</div>`, iconSize: [32, 32], iconAnchor: [16, 16] }),
      draggable: true, zIndexOffset: 1100,
    }).addTo(map);
    handleMarker.on("dragstart", onDragStart);
    handleMarker.on("drag", onDrag);
    handleMarker.on("dragend", onDragEnd);
  }

  function onDragStart() {
    const map = getMap();
    if (!pivot || !map) return;
    const pivotPt = map.latLngToContainerPoint(pivot);
    const hPt = map.latLngToContainerPoint(handleMarker.getLatLng());
    startBearing = Math.atan2(hPt.y - pivotPt.y, hPt.x - pivotPt.x);
    startVectors = new Map();
    startPositions = new Map();
    for (const c of selectedCones()) {
      const pt = map.latLngToContainerPoint([c.lat, c.lng]);
      startVectors.set(c.id, { x: pt.x - pivotPt.x, y: pt.y - pivotPt.y });
      startPositions.set(c.id, { lat: c.lat, lng: c.lng });
    }
    cones.suppress(true); // hold off echo-driven redraws until the commit
  }

  function onDrag(e) {
    const map = getMap();
    if (!startVectors || !pivot || !map) return;
    const pivotPt = map.latLngToContainerPoint(pivot);
    const handleLatLng = handleMarker.getLatLng();
    const hPt = map.latLngToContainerPoint(handleLatLng);
    let delta = Math.atan2(hPt.y - pivotPt.y, hPt.x - pivotPt.x) - startBearing;
    let deg = delta * 180 / Math.PI;
    if (e?.originalEvent?.shiftKey) { deg = Math.round(deg / 5) * 5; delta = deg * Math.PI / 180; } // Shift → 5° steps
    angle.value = normalizeDeg(deg);
    const cos = Math.cos(delta), sin = Math.sin(delta);
    for (const [id, v] of startVectors) {
      const nx = v.x * cos - v.y * sin;
      const ny = v.x * sin + v.y * cos;
      cones.markerOf(id)?.setLatLng(map.containerPointToLatLng(L.point(pivotPt.x + nx, pivotPt.y + ny)));
    }
    if (guide) guide.setLatLngs([pivot, handleLatLng]);
  }

  async function onDragEnd() {
    if (!startVectors) return;
    const starts = startPositions;
    const updates = [];
    for (const [id] of startVectors) {
      const m = cones.markerOf(id);
      if (m) { const { lat, lng } = m.getLatLng(); updates.push({ id, lat, lng }); }
    }
    startVectors = null;
    startPositions = null;
    const before = starts ? [...starts].map(([id, p]) => ({ id, lat: p.lat, lng: p.lng })) : [];
    try {
      await course.moveCones(updates, before, "Rotate cones");
    } catch (err) {
      notifyError(`Failed to save cone rotation: ${err.message}`);
      for (const [id, p] of (starts || [])) cones.markerOf(id)?.setLatLng([p.lat, p.lng]);
    }
    cones.suppress(false);
    angle.value = 0;
    cones.rebuild();
    if (editor.rotating.value) setup();
  }

  // Rotates the selection by an exact angle (clockwise positive).
  async function rotateBy(deg) {
    const map = getMap();
    if (multiSelectedIds.value.size < 2 || !map) return;
    const center = centroid();
    if (!center) return;
    const pivotPt = map.latLngToContainerPoint(center);
    const delta = deg * Math.PI / 180;
    const cos = Math.cos(delta), sin = Math.sin(delta);
    const list = selectedCones();
    const starts = list.map((c) => ({ id: c.id, lat: c.lat, lng: c.lng }));
    const updates = list.map((c) => {
      const pt = map.latLngToContainerPoint([c.lat, c.lng]);
      const vx = pt.x - pivotPt.x, vy = pt.y - pivotPt.y;
      const ll = map.containerPointToLatLng(L.point(pivotPt.x + vx * cos - vy * sin, pivotPt.y + vx * sin + vy * cos));
      return { id: c.id, lat: ll.lat, lng: ll.lng };
    });
    cones.suppress(true);
    for (const u of updates) cones.markerOf(u.id)?.setLatLng([u.lat, u.lng]);
    try {
      await course.moveCones(updates, starts, "Rotate cones");
    } catch (err) {
      notifyError(`Failed to save cone rotation: ${err.message}`);
      for (const p of starts) cones.markerOf(p.id)?.setLatLng([p.lat, p.lng]);
    }
    cones.suppress(false);
    cones.rebuild();
    if (editor.rotating.value) setup();
  }

  function stop() {
    angle.value = 0;
    cones.suppress(false);
    teardown();
  }

  return { angle, setup, stop, rotateBy };
}
