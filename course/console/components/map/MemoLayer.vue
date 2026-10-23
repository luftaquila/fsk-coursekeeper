<script setup>
import L from "leaflet";
import { useConsoleState } from "../../state/console.mjs";

// Geo-anchored text labels over the map. A memo is stored by its centre
// (lat/lng) and its real size (width/height in metres), so it pans, zooms and
// rotates with the course. Move / delete / rotate / resize appear on hover or
// focus. `frame` changes on every map move so positions recompute.
const props = defineProps({
  getMap: { type: Function, required: true },
  frame: { type: Number, required: true },
});

const state = useConsoleState();
const { course } = state;
const { error: notifyError } = state.notify;
const { activeMemos, findMemo } = course;

let memoDrag = null;   // { id, startLat, startLng, origLat, origLng, wasDragging }
let memoResize = null; // { id, startX, startY, origW, origH, mpp, wasDragging }
let memoRotate = null; // { id, cx, cy, startAngle, orig, wasDragging, sx, sy, dragged }
let memoEditOrig = null; // content when typing started (undo, change detection)

// Web Mercator metres per pixel at a latitude; a scalar, so it holds under rotation.
function metersPerPixel(map, lat) {
  return (40075016.686 * Math.abs(Math.cos((lat * Math.PI) / 180))) / Math.pow(2, map.getZoom() + 8);
}

function memoStyle(m) {
  void props.frame;
  const map = props.getMap();
  if (!map) return { display: "none" };
  const pt = map.latLngToContainerPoint([m.lat, m.lng]);
  const mpp = metersPerPixel(map, m.lat);
  const wpx = m.width / mpp;
  const hpx = m.height / mpp;
  // Text scales with the label (zoom) so it never clips; bounded both ways.
  const fontPx = Math.max(8, Math.min(hpx * 0.5, wpx * 0.6, 40));
  return {
    left: `${pt.x}px`,
    top: `${pt.y}px`,
    width: `${wpx}px`,
    height: `${hpx}px`,
    fontSize: `${fontPx}px`,
    transform: `translate(-50%, -50%) rotate(${m.rotation || 0}deg)`,
  };
}

// Content: echoes are held while typing; saved on blur only when it changed.
function onFocus(m) { memoEditOrig = m.content; course.setMemoBusy(true); }
async function onBlur(m) {
  course.setMemoBusy(false);
  const before = memoEditOrig;
  memoEditOrig = null;
  if (before === null || m.content === before) return;
  try {
    await course.patchMemo(m.id, { content: m.content }, { content: before }, "Edit memo");
  } catch (err) { m.content = before; notifyError(err.message); }
}

function containerPoint(map, e) {
  const rect = map.getContainer().getBoundingClientRect();
  return L.point(e.clientX - rect.left, e.clientY - rect.top);
}

// Move: the grabbed point's lat/lng delta moves the centre, so the grab never jumps.
// Each gesture restores the map's own drag state when it ends (the area tool pins the map).
function onDragStart(m, e) {
  const map = props.getMap();
  if (!map) return;
  e.preventDefault(); e.stopPropagation();
  course.setMemoBusy(true);
  const ll = map.containerPointToLatLng(containerPoint(map, e));
  memoDrag = { id: m.id, startLat: ll.lat, startLng: ll.lng, origLat: m.lat, origLng: m.lng, wasDragging: map.dragging.enabled() };
  map.dragging.disable();
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
}
function onDragMove(e) {
  const map = props.getMap();
  if (!memoDrag || !map) return;
  const ll = map.containerPointToLatLng(containerPoint(map, e));
  const m = findMemo(memoDrag.id);
  if (!m) return;
  m.lat = memoDrag.origLat + (ll.lat - memoDrag.startLat);
  m.lng = memoDrag.origLng + (ll.lng - memoDrag.startLng);
}
async function onDragEnd() {
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  const map = props.getMap();
  if (map && memoDrag?.wasDragging) map.dragging.enable();
  const d = memoDrag; memoDrag = null; course.setMemoBusy(false);
  if (!d) return;
  const m = findMemo(d.id);
  if (!m || (m.lat === d.origLat && m.lng === d.origLng)) return;
  try {
    await course.patchMemo(d.id, { lat: m.lat, lng: m.lng }, { lat: d.origLat, lng: d.origLng }, "Move memo");
  } catch (err) { notifyError(err.message); }
}

// Resize from the corner around the fixed centre: a dx-pixel drag widens by 2·dx.
function onResizeStart(m, e) {
  const map = props.getMap();
  if (!map) return;
  e.preventDefault(); e.stopPropagation();
  course.setMemoBusy(true);
  memoResize = { id: m.id, startX: e.clientX, startY: e.clientY, origW: m.width, origH: m.height, mpp: metersPerPixel(map, m.lat), wasDragging: map.dragging.enabled() };
  map.dragging.disable();
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", onResizeEnd);
}
function onResizeMove(e) {
  if (!memoResize) return;
  const m = findMemo(memoResize.id);
  if (!m) return;
  const min = memoResize.mpp * 30; // about 30 px at least
  m.width = Math.max(min, memoResize.origW + (e.clientX - memoResize.startX) * memoResize.mpp * 2);
  m.height = Math.max(min, memoResize.origH + (e.clientY - memoResize.startY) * memoResize.mpp * 2);
}
async function onResizeEnd() {
  window.removeEventListener("pointermove", onResizeMove);
  window.removeEventListener("pointerup", onResizeEnd);
  const map = props.getMap();
  if (map && memoResize?.wasDragging) map.dragging.enable();
  const r = memoResize; memoResize = null; course.setMemoBusy(false);
  if (!r) return;
  const m = findMemo(r.id);
  if (!m || (m.width === r.origW && m.height === r.origH)) return;
  try {
    await course.patchMemo(r.id, { width: m.width, height: m.height }, { width: r.origW, height: r.origH }, "Resize memo");
  } catch (err) { notifyError(err.message); }
}

// Rotate around the label centre; a click without a drag resets to 0°.
function onRotateStart(m, e) {
  const map = props.getMap();
  if (!map) return;
  e.preventDefault(); e.stopPropagation();
  course.setMemoBusy(true);
  const box = e.currentTarget.closest(".memo-label").getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const startAngle = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
  memoRotate = { id: m.id, cx, cy, startAngle, orig: m.rotation || 0, wasDragging: map.dragging.enabled(), sx: e.clientX, sy: e.clientY, dragged: false };
  map.dragging.disable();
  window.addEventListener("pointermove", onRotateMove);
  window.addEventListener("pointerup", onRotateEnd);
}
function onRotateMove(e) {
  if (!memoRotate) return;
  const m = findMemo(memoRotate.id);
  if (!m) return;
  if (!memoRotate.dragged) {
    const dx = e.clientX - memoRotate.sx, dy = e.clientY - memoRotate.sy;
    if (dx * dx + dy * dy > 9) memoRotate.dragged = true; // moved over 3 px → a drag
  }
  const a = (Math.atan2(e.clientY - memoRotate.cy, e.clientX - memoRotate.cx) * 180) / Math.PI;
  m.rotation = memoRotate.orig + (a - memoRotate.startAngle);
}
async function onRotateEnd() {
  window.removeEventListener("pointermove", onRotateMove);
  window.removeEventListener("pointerup", onRotateEnd);
  const map = props.getMap();
  if (map && memoRotate?.wasDragging) map.dragging.enable();
  const rr = memoRotate; memoRotate = null; course.setMemoBusy(false);
  if (!rr) return;
  const m = findMemo(rr.id);
  if (!m) return;
  if (!rr.dragged) {
    m.rotation = 0;
    if (rr.orig === 0) return;
    try {
      await course.patchMemo(rr.id, { rotation: 0 }, { rotation: rr.orig }, "Reset memo rotation");
    } catch (err) { notifyError(err.message); }
    return;
  }
  const norm = (((m.rotation || 0) % 360) + 360) % 360;
  m.rotation = norm;
  if (norm === rr.orig) return;
  try {
    await course.patchMemo(rr.id, { rotation: norm }, { rotation: rr.orig }, "Rotate memo");
  } catch (err) { notifyError(err.message); }
}
</script>

<template>
  <div class="memo-layer">
    <div v-for="m in activeMemos" :key="m.id" class="memo-label" :data-id="m.id" :style="memoStyle(m)">
      <input
        class="memo-text" type="text" v-model="m.content" placeholder="Label" aria-label="Memo text"
        @focus="onFocus(m)" @blur="onBlur(m)" @pointerdown.stop
      />
      <span class="memo-move" title="Drag to move" @pointerdown="onDragStart(m, $event)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>
      </span>
      <button class="memo-del" title="Delete memo" aria-label="Delete memo" @pointerdown.stop @click="course.deleteMemo(m.id)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <span class="memo-rotate" title="Drag to rotate · click to reset" @pointerdown="onRotateStart(m, $event)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      </span>
      <span class="memo-resize" title="Drag to resize" @pointerdown="onResizeStart(m, $event)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      </span>
    </div>
  </div>
</template>

<style scoped>
.memo-layer { position: absolute; inset: 0; z-index: 450; overflow: hidden; pointer-events: none; }
.memo-label {
  position: absolute; transform: translate(-50%, -50%);
  display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  min-width: 32px; min-height: 20px;
  background: rgba(17, 24, 39, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 999px;
  -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.45);
  pointer-events: auto;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.memo-label:hover, .memo-label:focus-within {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 1px var(--accent-primary), 0 2px 8px rgba(0, 0, 0, 0.5);
}
/* Hover bridge: the corner controls sit outside the pill, so this transparent
   halo keeps the label hovered on the way to them. It takes pointer events only
   while hovered or focused, so at rest it never blocks the map. */
.memo-label::after {
  content: ""; position: absolute; inset: -18px; z-index: -1; pointer-events: none;
}
.memo-label:hover::after, .memo-label:focus-within::after { pointer-events: auto; }
.memo-text {
  flex: 1; width: 100%; min-width: 0; box-sizing: border-box;
  border: none; outline: none; background: transparent;
  color: #fff; font-family: inherit; font-weight: 600; line-height: 1.1;
  padding: 4px 12px; cursor: text; text-align: center;
  text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
}
.memo-text::placeholder { color: rgba(255, 255, 255, 0.6); font-weight: 400; }
.memo-move, .memo-del, .memo-rotate, .memo-resize {
  position: absolute; width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  opacity: 0; pointer-events: none; transition: opacity 0.12s ease; z-index: 1;
}
.memo-label:hover :is(.memo-move, .memo-del, .memo-rotate, .memo-resize),
.memo-label:focus-within :is(.memo-move, .memo-del, .memo-rotate, .memo-resize) {
  opacity: 1; pointer-events: auto;
}
.memo-move { top: -11px; left: -11px; background: var(--accent-primary); cursor: move; touch-action: none; user-select: none; }
.memo-del { top: -11px; right: -11px; padding: 0; border: none; background: #ef4444; cursor: pointer; }
.memo-rotate { bottom: -11px; left: -11px; background: var(--accent-primary); cursor: grab; touch-action: none; user-select: none; }
.memo-resize { right: -11px; bottom: -11px; background: var(--accent-primary); cursor: nwse-resize; touch-action: none; }
.memo-move svg, .memo-del svg, .memo-rotate svg, .memo-resize svg { display: block; width: 13px; height: 13px; }
</style>
