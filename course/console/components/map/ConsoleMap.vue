<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import L from "leaflet";
import { createCourseBaseMap } from "../../lib/course-map.mjs";
import { renderMapBearing } from "../../lib/course-view-preferences.mjs";
import { coneDiameterForZoom, LabeledConeCanvas } from "../../lib/cone-render.mjs";
import { isValidRoverPos } from "../../lib/rover-ui.mjs";
import { formatLatLng } from "../../../geo.mjs";
import { useMeasureTools } from "../../composables/useMeasureTools.js";
import { createConeLayer } from "../../map/cone-layer.mjs";
import { createDeviceLayer } from "../../map/device-layer.mjs";
import { createMissionLayer } from "../../map/mission-layer.mjs";
import { createRotateSelection } from "../../map/rotate-selection.mjs";
import { createRouteLayer } from "../../map/route-layer.mjs";
import { TOOLS } from "../../state/editor-store.mjs";
import { useConsoleState } from "../../state/console.mjs";
import ConsoleIcon from "../ConsoleIcon.vue";
import MemoLayer from "./MemoLayer.vue";
import ReplayTimeline from "./ReplayTimeline.vue";
import ToolBar from "./ToolBar.vue";

const state = useConsoleState();
const { course, rover, gps, mission, review, editor, edits, mapActions } = state;
const { error: notifyError } = state.notify;
const { courses, conesMap, activeCourseId, activeCones, activeRoute, visibility } = course;
const { mode, tool, multiSelectedIds } = editor;

const mapEl = ref(null);
// Bumped on every map move/zoom/rotate so geo-anchored overlays reposition.
const mapFrame = ref(0);
let map = null;
let coneRenderer = null;
const getMap = () => map;
const getRenderer = () => coneRenderer;

const designing = computed(() => mode.value === "design");
const reviewing = computed(() => mode.value === "review");
// Live layers (cones, devices, the mission route) give way to the replay in Review.
const isLive = () => !reviewing.value;

/* ── Visible centre ───────────────────────────────── */
// On mobile the bottom sheet covers the lower map; centre targets in what is left.
function visibleCenter() {
  if (!map) return null;
  const size = map.getSize();
  const cover = Math.min(editor.mapCover.value, size.y);
  return L.point(size.x / 2, (size.y - cover) / 2);
}

// Places the target at the visible centre by setting the view — never panBy:
// under a map bearing (leaflet-rotate) panBy's screen-space shortcut for a far
// target lands kilometres off. containerPointToLatLng applies the rotation.
function panToVisibleCenter(lat, lng, opts = {}) {
  if (!map) return;
  const animate = opts.animate ?? true;
  const zoom = opts.zoom ?? map.getZoom();
  const visible = visibleCenter();
  if (!visible) {
    map.setView([lat, lng], zoom, { animate });
    return;
  }
  const targetPt = map.latLngToContainerPoint([lat, lng]);
  const centerPt = targetPt.add(map.getSize().divideBy(2)).subtract(visible);
  map.setView(map.containerPointToLatLng(centerPt), zoom, { animate });
}

// Keep what sits at the visible centre in place when the inspector or the sheet
// resizes: read the old centre before the DOM patch, re-apply after.
watch([editor.inspectorWidth, editor.mapCover, editor.isMobile], () => {
  if (!map) return;
  const before = visibleCenter();
  if (!before) return;
  const anchor = map.containerPointToLatLng(before);
  nextTick(() => {
    if (!map) return;
    map.invalidateSize({ pan: false });
    const after = visibleCenter();
    if (!after) return;
    const cur = map.latLngToContainerPoint(anchor);
    const dx = cur.x - after.x;
    const dy = cur.y - after.y;
    if (dx !== 0 || dy !== 0) map.panBy([dx, dy], { animate: false });
  });
}, { flush: "pre" });

/* ── Layers ───────────────────────────────────────── */
const cones = createConeLayer({ getMap, getRenderer, course, editor, notifyError });
const route = createRouteLayer({ getMap, course, editor });
const devices = createDeviceLayer({ getMap, panToVisibleCenter, gps, editor, isLive });
const missionLayer = createMissionLayer({ getMap, getRenderer, mission, review });
const rotation = createRotateSelection({ getMap, course, editor, cones, notifyError });
const { toolMode, measureResult, enterToolMode, exitToolMode, resetMeasure, handleMeasureClick } = useMeasureTools({
  getMap,
  clearOtherModes: () => { editor.rotating.value = false; },
});

const courseGraphicsVisible = () => designing.value;

function redrawCourse() {
  cones.rebuild();
  route.rebuildMarkers(courseGraphicsVisible());
  route.drawCenterline(courseGraphicsVisible());
}

function showLive() {
  redrawCourse();
  devices.setMarker("rover", rover.livePosition.value?.lat, rover.livePosition.value?.lng);
  devices.syncReceiver();
  renderSurveyPoints();
  missionLayer.renderPath();
  missionLayer.renderSpray();
}

function hideLive() {
  cones.clear();
  route.clearMarkers();
  route.drawCenterline(false);
  devices.hide();
  missionLayer.hideLive();
}

function renderSurveyPoints() {
  devices.renderSurveyPoints(mode.value === "operate" || editor.drawer.value === "gps");
}

/* ── Map setup ────────────────────────────────────── */
async function initMap() {
  map = await createCourseBaseMap(mapEl.value, { bearing: renderMapBearing(editor.mapBearing.value) });
  coneRenderer = new LabeledConeCanvas({ padding: 0.5 });
  // DOM cone icons (Move tool) scale with zoom like the canvas dots.
  const applyConeScale = () => map.getContainer().style.setProperty("--cone-px", coneDiameterForZoom(map.getZoom()).toFixed(1) + "px");
  applyConeScale();
  map.on("zoomend", applyConeScale);
  map.on("click", onMapClick);
  // Coordinates on long-press (500 ms touch hold) or right-click, so a tap can't
  // drop a popup mid-pan.
  map.on("contextmenu", (e) => {
    L.DomEvent.preventDefault(e.originalEvent);
    L.popup({ closeOnClick: true, autoClose: true, className: "coord-popup" })
      .setLatLng(e.latlng)
      .setContent(`<div class="coord-popover-body">${formatLatLng(e.latlng.lat, e.latlng.lng)}</div>`)
      .openOn(map);
  });
  // A hand pan stops following so the operator isn't fighting the recentre.
  map.on("dragstart", () => {
    editor.followRover.value = false;
    editor.followReceiver.value = false;
  });
  for (const ev of ["move", "zoom", "moveend", "zoomend", "viewreset", "resize", "rotate"]) {
    map.on(ev, () => { mapFrame.value++; });
  }
  map.getContainer().addEventListener("pointerdown", onSelectionStart);
  applyAreaTool(tool.value === "area");
}

// The needle's angle is kept unwrapped: going 0° → 270° in CSS would spin it
// three quarters the wrong way instead of the quarter turn the map makes.
const needleAngle = ref(editor.mapBearing.value);
function rotateMap() {
  if (!map) return;
  editor.mapBearing.value = (((editor.mapBearing.value - 90) % 360) + 360) % 360;
  needleAngle.value -= 90;
  map.setBearing(renderMapBearing(editor.mapBearing.value));
  mapFrame.value++;
}

/* ── Taps ─────────────────────────────────────────── */
// The nearest active-course cone within `maxPx` screen pixels of a tap.
function nearestCone(latlng, maxPx = 24) {
  const list = activeCones.value;
  if (!list.length || !map) return null;
  const p = map.latLngToContainerPoint(latlng);
  let best = null, bestD = maxPx;
  for (const c of list) {
    const d = p.distanceTo(map.latLngToContainerPoint([c.lat, c.lng]));
    if (d <= bestD) { bestD = d; best = c; }
  }
  return best;
}

let justFinishedBoxSelect = false;

function onMapClick(e) {
  if (justFinishedBoxSelect) return;
  const t = tool.value;
  // Measurements snap to a nearby cone.
  if (t === "ruler" || t === "angle") {
    const c = nearestCone(e.latlng);
    handleMeasureClick(c ? L.latLng(c.lat, c.lng) : e.latlng);
    return;
  }
  if (!designing.value || !activeCourseId.value || editor.rotating.value) return;
  if (t === "marker") { course.addRouteMarker(e.latlng.lat, e.latlng.lng); return; }
  if (t === "memo") { addMemoAt(e.latlng); return; }
  const hit = nearestCone(e.latlng);
  if (t === "area") {
    if (hit) editor.toggleInSelection(hit.id);
    return;
  }
  if (hit) {
    if (e.originalEvent?.shiftKey) editor.toggleInSelection(hit.id);
    else editor.selectCone(hit.id);
    return;
  }
  if (t === "add") {
    editor.clearSelection();
    course.addCone(e.latlng.lat, e.latlng.lng, editor.side.value);
    return;
  }
  editor.clearSelection();
}

// A new memo of about 150 × 48 px at the tap, focused for typing; the tool
// returns to Select.
async function addMemoAt(latlng) {
  const mpp = (40075016.686 * Math.abs(Math.cos((latlng.lat * Math.PI) / 180))) / Math.pow(2, map.getZoom() + 8);
  editor.setTool("select");
  const created = await course.addMemo({ lat: latlng.lat, lng: latlng.lng, width: 150 * mpp, height: 48 * mpp });
  if (created) {
    nextTick(() => document.querySelector(`.memo-label[data-id="${created.id}"] .memo-text`)?.focus());
  }
}

/* ── Box selection (area tool, or Shift+drag) ─────── */
let selectionActive = false;
function onSelectionStart(e) {
  if (!designing.value || !activeCourseId.value || selectionActive || editor.rotating.value) return;
  if (!["select", "add", "move", "area"].includes(tool.value)) return;
  const isMouse = (e.pointerType || "mouse") === "mouse";
  const viaShift = isMouse && e.shiftKey && e.button === 0;
  const areaTool = tool.value === "area";
  if (!areaTool && !viaShift) return;
  if (isMouse && e.button !== 0) return;

  selectionActive = true;
  const pointerId = e.pointerId;
  // The area tool pins the map already; Shift+drag pins it for this gesture.
  if (!areaTool) map.dragging.disable();
  const container = map.getContainer();
  const rect = container.getBoundingClientRect();
  const startPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  let endPx = { ...startPx };
  const boxEl = document.createElement("div");
  boxEl.className = "selection-box";
  container.appendChild(boxEl);

  function draw() {
    boxEl.style.left = Math.min(startPx.x, endPx.x) + "px";
    boxEl.style.top = Math.min(startPx.y, endPx.y) + "px";
    boxEl.style.width = Math.abs(endPx.x - startPx.x) + "px";
    boxEl.style.height = Math.abs(endPx.y - startPx.y) + "px";
  }
  function onMove(ev) {
    if (ev.pointerId !== pointerId) return;
    endPx = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    draw();
  }
  function finish(apply) {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    if (apply && (Math.abs(endPx.x - startPx.x) > 5 || Math.abs(endPx.y - startPx.y) > 5)) {
      const box = {
        left: Math.min(startPx.x, endPx.x), top: Math.min(startPx.y, endPx.y),
        right: Math.max(startPx.x, endPx.x), bottom: Math.max(startPx.y, endPx.y),
      };
      const next = new Set(multiSelectedIds.value);
      if (editor.selectedConeId.value != null) next.add(editor.selectedConeId.value);
      for (const cone of activeCones.value) {
        const pt = map.latLngToContainerPoint([cone.lat, cone.lng]);
        if (pt.x >= box.left && pt.x <= box.right && pt.y >= box.top && pt.y <= box.bottom) next.add(cone.id);
      }
      editor.selectedConeId.value = null;
      multiSelectedIds.value = next;
    }
    boxEl.remove();
    if (!areaTool) map.dragging.enable();
    selectionActive = false;
    justFinishedBoxSelect = true;
    setTimeout(() => { justFinishedBoxSelect = false; }, 100);
  }
  function onUp(ev) { if (ev.pointerId === pointerId) finish(true); }
  function onCancel(ev) { if (ev.pointerId === pointerId) finish(false); }
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

// The area tool pins the map so a drag draws a box; touch-action stops the page scroll.
function applyAreaTool(on) {
  if (!map) return;
  if (on) map.dragging.disable(); else map.dragging.enable();
  map.getContainer().classList.toggle("select-mode-active", on);
}

/* ── Reactions ────────────────────────────────────── */
watch(tool, (next, prev) => {
  const measure = { ruler: "ruler", angle: "protractor" };
  if (measure[prev] && !measure[next]) exitToolMode();
  if (measure[next] && toolMode.value !== measure[next]) enterToolMode(measure[next]);
  applyAreaTool(next === "area");
  if (!map || !isLive()) return;
  cones.rebuild();
  route.rebuildMarkers(courseGraphicsVisible());
});

watch(mode, (next, prev) => {
  if (!map) return;
  map.closePopup();
  if (prev === "review") {
    review.clearSelection();
    missionLayer.clearReplay();
  }
  if (next === "review") {
    hideLive();
    review.loadMissions();
    return;
  }
  if (prev === "review") showLive();
  else redrawCourse();
  renderSurveyPoints();
});

watch([editor.selectedConeId, multiSelectedIds], () => {
  if (map && isLive()) cones.refreshSelection();
});
watch(visibility, () => { if (map && isLive()) cones.rebuild(); }, { deep: true });

watch(editor.rotating, (on) => {
  if (!map) return;
  if (on) {
    if (multiSelectedIds.value.size < 2) { editor.rotating.value = false; return; }
    cones.rebuild();
    rotation.setup();
  } else {
    rotation.stop();
    if (isLive()) cones.rebuild();
  }
});
// The handle stays on the selection's centroid; under two cones there is nothing to rotate.
watch(multiSelectedIds, (set) => {
  if (!editor.rotating.value) return;
  if (set.size < 2) editor.rotating.value = false;
  else rotation.setup();
});

watch(editor.showCenterline, () => {
  route.drawCenterline(courseGraphicsVisible());
  route.rebuildMarkers(courseGraphicsVisible());
});
watch(course.centerline, () => route.drawCenterline(courseGraphicsVisible()));
watch(activeRoute, () => route.rebuildMarkers(courseGraphicsVisible()), { deep: true });

course.onConesReplaced((courseId) => {
  if (map && !cones.isSuppressed() && isLive()) cones.rebuild(courseId ?? null);
});

// A course switch the mission store accepted: drop the old course's editing
// state and pan to the new course (its start cone, else its first cone).
mission.onCourseSwitch((v) => {
  editor.rotating.value = false;
  editor.setTool("select");
  editor.clearSelection();
  edits.clear(); // undo entries reference cone ids of the old course
  if (map && isLive()) {
    cones.rebuild();
    route.rebuildMarkers(courseGraphicsVisible());
  }
  if (v != null) {
    const list = conesMap.value[v] || [];
    if (list.length > 0 && map) {
      const startId = courses.value.find((c) => c.id === v)?.start_cone_id;
      const startCone = list.find((c) => c.id === startId) || list[0];
      panToVisibleCenter(startCone.lat, startCone.lng);
    }
  }
});

// The rover marker and follow track the rover's latest position.
watch(rover.livePosition, (p) => {
  devices.setMarker("rover", p?.lat, p?.lng);
  if (editor.followRover.value && p) devices.scheduleFollow(p.lat, p.lng);
});
watch(gps.receiver, () => devices.syncReceiver());
watch([gps.surveyedPoints, gps.gpsConfig, editor.selectedSurveyPointId, editor.drawer], renderSurveyPoints);

function centerOnRover() {
  const lp = rover.roverStatus.value.last_position;
  if (!lp || !map || !isValidRoverPos(lp.lat, lp.lng)) return;
  panToVisibleCenter(lp.lat, lp.lng);
}
function centerOnReceiver() {
  const lp = gps.receiver.value?.last_position;
  if (!lp || !map || !isValidRoverPos(lp.lat, lp.lng)) return;
  panToVisibleCenter(lp.lat, lp.lng);
}
watch(editor.followRover, (on) => { if (on) centerOnRover(); });
watch(editor.followReceiver, (on) => { if (on) centerOnReceiver(); });

watch(mission.pathGeometry, () => { if (isLive()) missionLayer.renderPath(); });
watch(mission.sprayResults, () => { if (isLive()) missionLayer.renderSpray(); });
watch([review.missionDetail, review.missionSamples], () => { if (reviewing.value) missionLayer.renderReplay(); });
watch(review.replayIdx, () => missionLayer.updateReplayMarker());

// The mission builder covers the map with its own; stop painting this one meanwhile.
watch(mission.showMissionBuilder, (open) => {
  if (!map) return;
  if (open) { map.stop(); return; }
  nextTick(() => { if (map) map.invalidateSize({ pan: false, animate: false }); });
});

/* ── Tool bar ─────────────────────────────────────── */
// Only a live reading earns a bar: the rotation angle and a measurement. The
// other tools show their result on the map, and a tool is left by tapping it
// again, picking Select, or Esc.
const toolBar = computed(() => {
  if (editor.rotating.value) {
    return { icon: "rotate", label: "Rotation", value: `${Math.abs(rotation.angle.value).toFixed(1)}°` };
  }
  if ((tool.value === "ruler" || tool.value === "angle") && measureResult.value) {
    return { icon: TOOLS[tool.value].icon, label: TOOLS[tool.value].label, value: measureResult.value, reset: true };
  }
  return null;
});

/* ── Actions for the panels ───────────────────────── */
Object.assign(mapActions, {
  panToCone(cone) {
    if (!map) return;
    editor.selectCone(cone.id);
    map.setView([cone.lat, cone.lng], Math.max(map.getZoom(), 17));
  },
  panToPoint(lat, lng, zoom) {
    if (!map || !isValidRoverPos(lat, lng)) return;
    panToVisibleCenter(lat, lng, { zoom: Math.max(map.getZoom(), zoom ?? 0) });
  },
  rotateSelectionBy: (deg) => rotation.rotateBy(deg),
  showDeviceAt: (kind, lat, lng) => devices.setMarker(kind, lat, lng),
});

onMounted(async () => {
  await initMap();
  map.invalidateSize({ pan: false, animate: false });
  if (isLive()) showLive();
  else review.loadMissions();
  // The restored course: pan to its start cone (or first cone).
  const list = activeCones.value;
  if (list.length > 0) {
    const startId = course.activeCourse.value?.start_cone_id;
    const startCone = list.find((c) => c.id === startId) || list[0];
    panToVisibleCenter(startCone.lat, startCone.lng, { animate: false });
  }
});

onUnmounted(() => {
  devices.dispose();
  if (map) {
    rotation.stop();
    map.getContainer().removeEventListener("pointerdown", onSelectionStart);
    map.remove();
    map = null;
  }
});
</script>

<template>
  <div :class="['console-map', { suspended: mission.showMissionBuilder.value }]">
    <div ref="mapEl" class="console-map-canvas" data-testid="map"></div>
    <MemoLayer v-if="designing && activeCourseId" :get-map="getMap" :frame="mapFrame" />

    <template v-if="toolBar">
      <!-- The sheet renders its slot after the map: wait for it. -->
      <Teleport v-if="editor.isMobile.value" to="#ck-sheet-tool" defer>
        <ToolBar :bar="toolBar" docked @reset="resetMeasure" />
      </Teleport>
      <ToolBar v-else :bar="toolBar" @reset="resetMeasure" />
    </template>

    <div class="map-controls" :style="{ bottom: `calc(${editor.mapCover.value}px + 1rem)` }">
      <button
        v-if="designing && activeCourseId"
        :class="['map-control', { active: editor.showCenterline.value }]"
        :aria-pressed="editor.showCenterline.value"
        title="Show the centerline" aria-label="Show the centerline"
        @click="editor.showCenterline.value = !editor.showCenterline.value"
      ><ConsoleIcon name="centerline" /></button>
      <button class="map-control" title="Rotate the map 90°" aria-label="Rotate the map 90°" @click="rotateMap">
        <span class="north" :style="{ transform: `rotate(${needleAngle}deg)` }"><ConsoleIcon name="north" :size="16" /></span>
      </button>
    </div>

    <ReplayTimeline v-if="reviewing && review.missionDetail.value" :style="{ bottom: `calc(${editor.mapCover.value}px + 1rem)` }" />
  </div>
</template>

<style scoped>
.console-map { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; }
.console-map-canvas { width: 100%; height: 100%; z-index: 0; }
/* Leaflet focuses the map on every press; a ring around the whole map after a
   hotkey would only be noise. */
.console-map-canvas:focus-visible { outline: none; }
.console-map.suspended .console-map-canvas { visibility: hidden; }

.map-controls {
  position: absolute; right: 0.75rem; z-index: 500;
  display: flex; flex-direction: column; gap: 0.4rem;
}
.map-control {
  width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-color); border-radius: 10px;
  background: var(--bg-secondary); color: var(--text-primary);
  box-shadow: var(--shadow-hover); cursor: pointer;
}
.map-control:hover { background: var(--bg-hover); }
.map-control.active { color: var(--accent-primary); border-color: color-mix(in srgb, var(--accent-primary) 50%, var(--border-color)); }
.north { display: flex; transition: transform 0.2s ease; }

@media (any-pointer: coarse) {
  .map-control { width: 44px; height: 44px; }
}
</style>
