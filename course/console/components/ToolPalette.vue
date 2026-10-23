<script setup>
import { computed, ref } from "vue";
import { MODE_TOOLS, SIDES, TOOLS } from "../state/editor-store.mjs";
import { useConsoleState } from "../state/console.mjs";
import ConsoleIcon from "./ConsoleIcon.vue";

// The current mode's map tools: a vertical rail on desktop; on the mobile sheet,
// a row of tools that always fits the width, with the Design actions under it.
defineProps({ horizontal: { type: Boolean, default: false } });

const state = useConsoleState();
const { course, gps, editor, edits, access, mapActions } = state;
const { error: notifyError } = state.notify;
const { mode, tool, side } = editor;

const hasCourse = computed(() => course.activeCourseId.value != null);
const groups = computed(() => {
  const tools = MODE_TOOLS[mode.value];
  const pick = (keys) => keys.filter((k) => tools.includes(k));
  return [pick(["select", "add", "move", "area"]), pick(["marker", "memo"]), pick(["ruler", "angle"])].filter((g) => g.length);
});
function disabled(key) {
  return TOOLS[key].edit && !hasCourse.value;
}
function title(key) {
  const t = TOOLS[key];
  if (disabled(key)) return `${t.label} (${t.key.toUpperCase()}) — create or select a course first`;
  return `${t.label} (${t.key.toUpperCase()})${t.tip ? ` — ${t.tip}` : ""}`;
}

/* ── Cone capture ─────────────────────────────────── */
// The GPS unit is preferred while it holds a fresh fix in capture mode; the rover
// is the fallback.
const capturing = ref(false);
const source = gps.positionSource;
const captureTitle = computed(() => {
  if (!hasCourse.value) return "Capture a cone — create or select a course first";
  if (source.value === "receiver") return "Capture a cone at the GPS unit (G)";
  if (source.value === "rover") return "Capture a cone at the rover (G)";
  return "Capture a cone — connect a GPS unit or the rover";
});
async function capture() {
  const from = source.value;
  if (!from || !hasCourse.value || capturing.value) return;
  capturing.value = true;
  try {
    const { lat, lng, alt } = await gps.capturePosition(from);
    mapActions.showDeviceAt?.(from, lat, lng);
    await course.addCone(lat, lng, side.value, alt);
  } catch (err) {
    notifyError(err.message || "Failed to get the device position.");
  } finally { capturing.value = false; }
}
mapActions.capture = capture;

const canUndo = computed(() => edits.stack.value.length > 0);
const undoTitle = computed(() => (canUndo.value ? `Undo ${edits.stack.value.at(-1).label.toLowerCase()} (Ctrl+Z)` : "Nothing to undo"));
</script>

<template>
  <nav :class="['palette', { horizontal }]" aria-label="Map tools" data-testid="palette">
    <div class="palette-tools">
      <template v-for="(group, gi) in groups" :key="gi">
        <div v-if="gi > 0" class="palette-divider"></div>
        <button
          v-for="key in group" :key="key"
          :class="['palette-btn', { active: tool === key }]"
          :aria-pressed="tool === key" :aria-label="TOOLS[key].label" :title="title(key)"
          :disabled="disabled(key)" :data-tool="key"
          @click="editor.setTool(key)"
        ><ConsoleIcon :name="TOOLS[key].icon" /></button>
      </template>
      <template v-if="mode === 'operate' && access.canOperateRover.value">
        <div class="palette-divider"></div>
        <button
          :class="['palette-btn', { active: editor.followRover.value }]" :aria-pressed="editor.followRover.value"
          title="Follow the rover" aria-label="Follow the rover" data-tool="follow-rover"
          @click="editor.followRover.value = !editor.followRover.value"
        ><ConsoleIcon name="follow" /></button>
        <button
          :class="['palette-btn', { active: editor.followReceiver.value }]" :aria-pressed="editor.followReceiver.value"
          :disabled="!gps.receiverCanTrack.value" title="Follow the GPS unit" aria-label="Follow the GPS unit" data-tool="follow-gps"
          @click="editor.followReceiver.value = !editor.followReceiver.value"
        ><ConsoleIcon name="gps" /></button>
      </template>
    </div>

    <!-- Design actions: under the tools on the rail, a second row on the sheet. -->
    <div v-if="mode === 'design'" class="palette-actions">
      <div class="palette-divider"></div>
      <button
        :class="['palette-btn', 'capture', source && `src-${source}`]"
        :disabled="!source || !hasCourse || capturing"
        :title="captureTitle" aria-label="Capture a cone at the device position" data-tool="capture"
        @click="capture"
      ><ConsoleIcon :name="capturing ? 'review' : 'capture'" /></button>
      <div class="side-picker" role="radiogroup" aria-label="Cone side">
        <button
          v-for="s in SIDES" :key="s.key" role="radio"
          :class="['side', s.key, { active: side === s.key }]" :aria-checked="side === s.key"
          :title="`${s.label} side (${s.hotkey})`" :aria-label="`${s.label} side`"
          @click="side = s.key"
        >{{ s.short }}</button>
      </div>
      <div class="palette-spacer"></div>
      <button class="palette-btn" :disabled="!canUndo" :title="undoTitle" aria-label="Undo" data-tool="undo" @click="edits.undo()">
        <ConsoleIcon name="undo" />
      </button>
    </div>
  </nav>
</template>

<style scoped>
.palette {
  display: flex; flex-direction: column; align-items: center; gap: 0.3rem;
  padding: 0.6rem 0.4rem;
  width: 56px; flex: none;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
}
.palette-tools, .palette-actions { display: flex; flex-direction: column; align-items: center; gap: 0.3rem; }
.palette-actions { flex: 1; }
/* One grid column for both rows: the action row spans exactly the tool row's
   width, which shrinks to the sheet on a narrow phone. */
.palette.horizontal {
  display: grid; grid-template-columns: minmax(0, max-content); justify-content: center; row-gap: 0.45rem;
  width: auto; padding: 0.15rem 0.75rem 0.5rem;
  border-right: none; overflow: visible;
}
.horizontal .palette-tools { flex-direction: row; gap: 0.3rem; }
.horizontal .palette-actions { flex-direction: row; gap: 0.4rem; }
.horizontal .palette-actions > .palette-divider { display: none; }
.palette-divider { flex: none; width: 28px; height: 1px; margin: 0.2rem 0; background: var(--border-color); }
.horizontal .palette-divider { width: 1px; height: 28px; margin: 0 0.15rem; }
.palette-spacer { flex: 1; min-height: 0.5rem; }
.horizontal .palette-spacer { min-height: 0; }
.palette-btn {
  flex: none; width: 40px; height: 40px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 10px;
  background: transparent; color: var(--text-secondary); cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.palette-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.palette-btn.active { background: color-mix(in srgb, var(--accent-primary) 14%, transparent); color: var(--accent-primary); border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent); }
.palette-btn:disabled { opacity: 0.35; cursor: default; }
.capture.src-receiver { color: #0d9488; }
.capture.src-rover { color: #9333ea; }
.side-picker { display: flex; flex-direction: column; gap: 0.2rem; }
.horizontal .side-picker { flex-direction: row; }
.side {
  width: 32px; height: 26px; border-radius: 7px;
  border: 1px solid var(--border-color); background: var(--bg-primary);
  color: var(--text-secondary); font-size: 0.75rem; font-weight: 700; cursor: pointer;
}
.side.active { color: #fff; border-color: transparent; }
.side.left.active { background: #f59e0b; }
.side.center.active { background: #ef4444; }
.side.right.active { background: #06b6d4; }
@media (any-pointer: coarse) {
  .palette-btn { width: 44px; height: 44px; }
  .side { width: 40px; height: 36px; }
}
/* Eight tools share the sheet's width; on narrow phones they shrink a little. */
.horizontal .palette-tools .palette-btn { flex: 0 1 44px; min-width: 36px; }
</style>
