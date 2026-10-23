<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import ConsoleIcon from "./components/ConsoleIcon.vue";
import DeviceDrawer from "./components/DeviceDrawer.vue";
import InspectorPane from "./components/InspectorPane.vue";
import MissionBuilder from "./components/MissionBuilder.vue";
import ToolPalette from "./components/ToolPalette.vue";
import PreflightDialog from "./components/dialogs/PreflightDialog.vue";
import ConsoleHeader from "./components/header/ConsoleHeader.vue";
import ConsoleMap from "./components/map/ConsoleMap.vue";
import { useHost } from "./host.mjs";
import { createConsoleState, provideConsoleState } from "./state/console.mjs";
import { MODE_TOOLS, SIDES, TOOLS } from "./state/editor-store.mjs";

// The operator console: header, tool palette, map, and the mode's panel. The
// root owns every store, so all of them share one course and one rover status.
const host = useHost();
const state = createConsoleState(host);
provideConsoleState(state);
const { course, rover, gps, mission, editor, edits, access, mapActions } = state;
const { mode, modes, isMobile } = editor;
const { activeMission, missionBuilderItems, missionPresets, missionFinishBehavior, missionBuilderEditing, missionBuilderBusy, missionPresetBusy } = mission;

const ready = ref(false);
const MODE_BAR_PX = 56;
const modeBar = computed(() => isMobile.value && modes.value.length > 1);
const completedCount = computed(() => activeMission.value
  ? activeMission.value.waypoints.filter((waypoint) => waypoint.state === "completed").length : 0);

function checkMobile() {
  editor.isMobile.value = window.innerWidth <= 768;
}

/* ── Keyboard ─────────────────────────────────────── */
async function deleteSelection() {
  const many = [...editor.multiSelectedIds.value];
  if (many.length > 0) {
    if (!confirm(`Delete ${many.length} selected cones?`)) return;
    editor.rotating.value = false;
    await course.deleteCones(many);
    editor.clearSelection();
    return;
  }
  const id = editor.selectedConeId.value;
  if (id != null && await course.deleteCone(id)) editor.clearSelection();
}

function onKeydown(e) {
  if (e.defaultPrevented) return;
  if (e.key === "Escape" && mission.showMissionBuilder.value) {
    mission.showMissionBuilder.value = false;
    e.preventDefault();
    return;
  }
  // Open dialogs (the host's settings included) own the keyboard.
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  const t = e.target;
  const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  const designing = mode.value === "design";

  if (e.key === "Escape") {
    if (inField) { t.blur(); return; }
    if (editor.rotating.value) editor.rotating.value = false;
    else if (editor.tool.value !== "select") editor.setTool("select");
    else if (editor.hasSelection.value) editor.clearSelection();
    else if (editor.drawer.value) editor.drawer.value = null;
    else return;
    e.preventDefault();
    return;
  }
  if (inField) return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
    if (designing && edits.stack.value.length > 0) { e.preventDefault(); edits.undo(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.key === "Delete" || e.key === "Backspace") && designing && editor.hasSelection.value) {
    e.preventDefault();
    deleteSelection();
    return;
  }
  const key = e.key.toLowerCase();
  const toolKey = MODE_TOOLS[mode.value].find((k) => TOOLS[k].key === key);
  if (toolKey) {
    if (TOOLS[toolKey].edit && course.activeCourseId.value == null) return;
    e.preventDefault();
    editor.setTool(toolKey);
    return;
  }
  if (!designing) return;
  const side = SIDES.find((s) => s.hotkey === e.key);
  if (side) { editor.side.value = side.key; e.preventDefault(); return; }
  if (key === "g") { e.preventDefault(); mapActions.capture?.(); }
}

onMounted(async () => {
  checkMobile();
  window.addEventListener("resize", checkMobile);
  window.addEventListener("keydown", onKeydown);
  await host.devices.refresh().catch((error) => state.notify.error(`Could not load devices: ${error.message}`));
  await course.fetchAll();
  course.recomputeCenterline();
  ready.value = true;
  state.connect();
  if (access.canOperateRover.value) {
    mission.fetchRoverStatus();
    gps.fetchStatus();
  }
});

onUnmounted(() => {
  window.removeEventListener("resize", checkMobile);
  window.removeEventListener("keydown", onKeydown);
  state.disconnect();
});
</script>

<template>
  <div :class="['console', { mobile: isMobile }]">
    <ConsoleHeader>
      <template #actions><slot name="status-actions" /></template>
    </ConsoleHeader>

    <div v-if="ready" class="console-body">
      <ToolPalette v-if="!isMobile" />
      <div class="map-column"><ConsoleMap /></div>
      <InspectorPane :bottom-inset="modeBar ? MODE_BAR_PX : 0" />
      <DeviceDrawer />
    </div>
    <div v-else class="console-loading" role="status">Loading courses…</div>

    <nav v-if="modeBar" class="mode-bar" aria-label="Mode">
      <button
        v-for="m in modes" :key="m.key" :class="['mode-tab', { active: mode === m.key }]"
        :aria-pressed="mode === m.key" :data-testid="`mode-${m.key}`" @click="mode = m.key"
      ><ConsoleIcon :name="m.icon" /><span>{{ m.label }}</span></button>
    </nav>

    <MissionBuilder
      v-if="mission.showMissionBuilder.value"
      :cones="course.activeCones.value"
      :initial-items="missionBuilderItems"
      :presets="missionPresets"
      :current-position="rover.roverStatus.value.last_position"
      :initial-finish-behavior="missionFinishBehavior"
      :mission-start="activeMission && activeMission.start_position"
      :editing="missionBuilderEditing"
      :completed-count="completedCount"
      :busy="missionBuilderBusy"
      :preset-busy="missionPresetBusy"
      :map-bearing="editor.mapBearing.value"
      @close="mission.showMissionBuilder.value = false"
      @apply="mission.applyMissionBuilder"
      @run="mission.runMissionBuilder"
      @save-preset="mission.saveMissionPreset"
      @delete-preset="mission.deleteMissionPreset"
    />
    <PreflightDialog v-if="mission.showPreflight.value" />
  </div>
</template>

<style scoped>
/* No z-index, transform or filter on the console's own boxes: the header's
   E-stop has to stay in the root stacking context, above every dialog. */
.console { height: 100%; display: flex; flex-direction: column; background: var(--bg-primary); color: var(--text-primary); }
.console-body { position: relative; flex: 1; min-height: 0; display: flex; }
.map-column { flex: 1; min-width: 0; min-height: 0; position: relative; }
.console-loading { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); }
.mode-bar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 660;
  height: 56px; display: flex; padding-bottom: env(safe-area-inset-bottom);
  background: var(--bg-secondary); border-top: 1px solid var(--border-color);
}
.mode-tab {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  border: none; background: transparent; color: var(--text-secondary);
  font: inherit; font-size: 0.7rem; font-weight: 600; cursor: pointer;
}
.mode-tab.active { color: var(--accent-primary); }
</style>
