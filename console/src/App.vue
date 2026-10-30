<script setup>
import { ref } from "vue";
import CourseConsole from "fsk-coursekeeper/console/CourseConsole.vue";
import ConsoleIcon from "fsk-coursekeeper/console/components/ConsoleIcon.vue";
import Toaster from "fsk-coursekeeper/console/Toaster.vue";
import { setBaseMapKey } from "fsk-coursekeeper/console/lib/course-map.mjs";
import SettingsDialog from "./SettingsDialog.vue";

const props = defineProps({
  persistent: { type: Boolean, required: true },
  storage: { type: Object, required: true },
  settings: { type: Object, required: true },
});

const showSettings = ref(false);
const currentSettings = ref(props.settings);
// Saved settings take effect by mounting the console again: it reloads the
// device list and reconnects, and its new map uses the basemap key.
const consoleKey = ref(0);
function applySettings(next) {
  currentSettings.value = next;
  setBaseMapKey(next.vworldKey);
  showSettings.value = false;
  consoleKey.value += 1;
}
</script>

<template>
  <div class="app-container app-fullheight">
    <Toaster />
    <div v-if="!persistent" class="volatile-banner" role="alert">
      This browser cannot save courses. Changes are lost when the page closes; export your courses to keep them.
    </div>
    <main class="main-fill">
      <CourseConsole :key="consoleKey">
        <template #status-actions>
          <button class="ck-header-btn" title="Settings" aria-label="Settings" @click="showSettings = true"><ConsoleIcon name="settings" /></button>
        </template>
      </CourseConsole>
    </main>
    <SettingsDialog v-if="showSettings" :settings="currentSettings" :storage="storage" :persistent="persistent" @close="showSettings = false" @saved="applySettings" />
  </div>
</template>

<style scoped>
.app-fullheight {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 100dvh;
  overflow: hidden;
  position: relative;
}
.main-fill {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.volatile-banner {
  padding: 0.4rem 0.75rem;
  background: var(--accent-warning);
  color: #1f2937;
  font-size: 0.85rem;
  font-weight: 600;
  text-align: center;
}
</style>
