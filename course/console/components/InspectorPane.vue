<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useConsoleState } from "../state/console.mjs";
import ToolPalette from "./ToolPalette.vue";
import DesignPanel from "./inspector/DesignPanel.vue";
import OperatePanel from "./inspector/OperatePanel.vue";
import ReviewPanel from "./inspector/ReviewPanel.vue";

// The current mode's panel: a resizable column on desktop, a bottom sheet with
// the tool palette on mobile. The sheet rests at one of three heights.
const props = defineProps({ bottomInset: { type: Number, default: 0 } });
const { course, editor } = useConsoleState();
const { mode, isMobile, inspectorWidth } = editor;

/* ── Desktop resize ───────────────────────────────── */
let resizeId = null;
let resizeX = 0;
let resizeW = 0;
const resizing = ref(false);
function onResizeStart(e) {
  resizeId = e.pointerId;
  resizeX = e.clientX;
  resizeW = inspectorWidth.value;
  resizing.value = true;
  e.target.setPointerCapture(e.pointerId);
  e.preventDefault();
}
function onResizeMove(e) {
  if (e.pointerId !== resizeId) return;
  inspectorWidth.value = Math.max(300, Math.min(600, resizeW + resizeX - e.clientX));
}
function onResizeEnd(e) {
  if (e.pointerId !== resizeId) return;
  resizeId = null;
  resizing.value = false;
}

/* ── Mobile sheet ─────────────────────────────────── */
// Peeking shows the sheet's head: the handle, the tools and the active tool's
// bar, so the peek height follows the head.
const HEADER_PX = 52;
const sheetHead = ref(null);
const headHeight = ref(96);
const headObserver = new ResizeObserver(() => {
  if (sheetHead.value) headHeight.value = Math.ceil(sheetHead.value.getBoundingClientRect().height);
});
const viewport = ref(window.innerHeight);
const snaps = computed(() => ({
  peek: headHeight.value,
  half: Math.round((viewport.value - HEADER_PX - props.bottomInset) * 0.5),
  full: viewport.value - HEADER_PX - props.bottomInset - 8,
}));
const snap = ref(course.activeCourseId.value == null ? "half" : "peek");
const dragHeight = ref(null);
const sheetHeight = computed(() => dragHeight.value ?? snaps.value[snap.value]);
watch([sheetHeight, isMobile, () => props.bottomInset], () => {
  editor.mapCover.value = isMobile.value ? sheetHeight.value + props.bottomInset : 0;
}, { immediate: true });

let startY = 0;
let startH = 0;
let moved = false;
// Cancelling the touch keeps the browser from firing a compatibility click at
// the start point after the sheet grows, which would land on a list row.
function onTouchStart(e) {
  if (e.cancelable) e.preventDefault();
  startY = e.touches[0].clientY;
  startH = sheetHeight.value;
  moved = false;
}
function onTouchMove(e) {
  const dy = startY - e.touches[0].clientY;
  if (!moved && Math.abs(dy) > 5) moved = true;
  if (!moved) return;
  e.preventDefault();
  dragHeight.value = Math.min(Math.max(snaps.value.peek, startH + dy), snaps.value.full);
}
function onTouchEnd() {
  if (!moved) {
    snap.value = snap.value === "peek" ? "half" : "peek";
    return;
  }
  const h = dragHeight.value;
  dragHeight.value = null;
  const nearest = Object.entries(snaps.value).reduce((best, [k, v]) => (Math.abs(v - h) < Math.abs(snaps.value[best] - h) ? k : best), "peek");
  snap.value = nearest;
}
function onHandleClick() {
  // Mouse users on a narrow window: a click toggles like a tap.
  snap.value = snap.value === "peek" ? "half" : "peek";
}

function onResize() { viewport.value = window.innerHeight; }
onMounted(() => window.addEventListener("resize", onResize));
watch(sheetHead, (el, old) => {
  if (old) headObserver.unobserve(old);
  if (el) headObserver.observe(el);
}, { flush: "post" });
onUnmounted(() => {
  window.removeEventListener("resize", onResize);
  headObserver.disconnect();
  editor.mapCover.value = 0;
});

// A map tool needs the map: picking one folds the sheet down to its head.
// Back on Select, a selection opens the panel that acts on it.
watch(editor.tool, (next) => {
  if (isMobile.value && next !== "select") snap.value = "peek";
});
watch([editor.selectedConeId, editor.multiSelectedIds, editor.tool], ([id, set, t]) => {
  if (isMobile.value && t === "select" && snap.value === "peek" && (id != null || set.size > 0)) snap.value = "half";
});
</script>

<template>
  <aside
    :class="['inspector', { mobile: isMobile, dragging: dragHeight != null }]"
    :style="isMobile ? { height: `${sheetHeight}px`, bottom: `${bottomInset}px` } : { width: `${inspectorWidth}px` }"
    data-testid="inspector"
  >
    <div
      v-if="!isMobile" :class="['resize-handle', { active: resizing }]" role="separator" aria-orientation="vertical" aria-label="Resize the panel"
      @pointerdown="onResizeStart" @pointermove="onResizeMove" @pointerup="onResizeEnd" @pointercancel="onResizeEnd"
    ></div>
    <div v-if="isMobile" ref="sheetHead" class="sheet-head">
      <div class="sheet-handle" role="button" :aria-expanded="snap !== 'peek'" aria-label="Resize the panel" data-testid="sheet-handle"
        @touchstart="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd" @click="onHandleClick">
        <span class="handle-bar"></span>
      </div>
      <ToolPalette horizontal />
      <!-- The map's tool bar docks here (ConsoleMap teleports it). -->
      <div id="ck-sheet-tool"></div>
    </div>
    <div class="inspector-body">
      <DesignPanel v-if="mode === 'design'" />
      <OperatePanel v-else-if="mode === 'operate'" />
      <ReviewPanel v-else />
    </div>
  </aside>
</template>

<style scoped>
.inspector {
  position: relative; flex: none;
  display: flex; flex-direction: column; min-height: 0;
  background: var(--bg-secondary); border-left: 1px solid var(--border-color);
}
.inspector-body { flex: 1; min-height: 0; overflow-y: auto; }
.resize-handle {
  position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; z-index: 5;
  cursor: col-resize; touch-action: none;
}
.resize-handle:hover, .resize-handle.active { background: color-mix(in srgb, var(--accent-primary) 30%, transparent); }

.inspector.mobile {
  position: fixed; left: 0; right: 0; z-index: 650;
  border-left: none; border-top: 1px solid var(--border-color);
  border-radius: 14px 14px 0 0;
  box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.2);
  transition: height 0.2s ease;
}
.inspector.mobile.dragging { transition: none; }
.sheet-head { flex: none; border-bottom: 1px solid var(--border-color); }
.sheet-handle { flex: none; display: flex; justify-content: center; padding: 0.55rem 0 0.35rem; cursor: pointer; touch-action: none; }
.handle-bar { width: 48px; height: 5px; border-radius: 3px; background: var(--text-secondary); opacity: 0.45; }
</style>
