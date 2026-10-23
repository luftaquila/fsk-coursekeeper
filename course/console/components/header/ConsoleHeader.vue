<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useConsoleState } from "../../state/console.mjs";
import ConsoleIcon from "../ConsoleIcon.vue";
import CourseSwitcher from "./CourseSwitcher.vue";
import DeviceBadge from "./DeviceBadge.vue";
import EmergencyStop from "./EmergencyStop.vue";

const { host, access, editor, droppedLinks, notify } = useConsoleState();
const { mode, modes, isMobile } = editor;

// A device badge appears once the host lists that device for this operator.
const showRover = computed(() => access.canOperateRover.value && host.devices.selected("rover") != null);
const showGps = computed(() => access.canOperateRover.value && host.devices.selected("gps") != null);
const LINK_NAMES = { course: "courses", rover: "rover", gps: "GPS unit" };
const reconnecting = computed(() => droppedLinks.value.map((link) => LINK_NAMES[link]).join(", "));

// The only way a normal tab can hide the mobile browser chrome; absent where
// the API is (iOS Safari has none for non-video elements).
const fullscreenSupported = typeof document !== "undefined" && !!document.documentElement.requestFullscreen;
const isFullscreen = ref(false);
function onFullscreenChange() { isFullscreen.value = !!document.fullscreenElement; }
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (e) {
    notify.warning(`Failed to toggle fullscreen: ${e?.message || e}`);
  }
}
onMounted(() => document.addEventListener("fullscreenchange", onFullscreenChange));
onUnmounted(() => document.removeEventListener("fullscreenchange", onFullscreenChange));
</script>

<template>
  <header class="console-header">
    <CourseSwitcher />
    <nav v-if="!isMobile && modes.length > 1" class="ck-seg modes" aria-label="Mode">
      <button
        v-for="m in modes" :key="m.key"
        :class="['ck-seg-btn', 'mode-btn', { active: mode === m.key }]" :aria-pressed="mode === m.key"
        :data-testid="`mode-${m.key}`" @click="mode = m.key"
      ><ConsoleIcon :name="m.icon" :size="15" />{{ m.label }}</button>
    </nav>
    <div class="spacer"></div>
    <span v-if="reconnecting" class="ck-badge warn reconnecting" role="status" :title="`Reconnecting to: ${reconnecting}`">
      <ConsoleIcon name="link" :size="13" />{{ isMobile ? "Reconnecting" : `Reconnecting: ${reconnecting}` }}
    </span>
    <DeviceBadge v-if="showRover" kind="rover" :compact="isMobile" />
    <DeviceBadge v-if="showGps" kind="gps" :compact="isMobile" />
    <slot name="actions" />
    <button
      v-if="fullscreenSupported" class="ck-header-btn"
      :title="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'" :aria-label="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'"
      @click="toggleFullscreen"
    ><ConsoleIcon :name="isFullscreen ? 'fullscreen-exit' : 'fullscreen'" /></button>
    <EmergencyStop />
  </header>
</template>

<style scoped>
/* No z-index, transform or filter here: the E-stop must stay in the root
   stacking context to rise above dialogs. */
.console-header {
  position: relative; flex: none;
  display: flex; align-items: center; gap: 0.5rem;
  height: var(--ck-header-h, 56px); padding: 0 0.75rem;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}
.spacer { flex: 1; min-width: 0; }
.modes { margin-left: 0.5rem; }
.mode-btn { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 32px; padding: 0 0.85rem; }
.reconnecting { flex: none; }
@media (max-width: 768px) {
  .console-header { gap: 0.3rem; padding: 0 0.5rem; }
}
</style>
