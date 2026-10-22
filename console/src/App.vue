<script setup>
import { ref } from "vue";
import CourseConsole from "fsk-coursekeeper/console/CourseConsole.vue";
import Toaster from "fsk-coursekeeper/console/Toaster.vue";
import SettingsDialog from "./SettingsDialog.vue";

defineProps({
  persistent: { type: Boolean, required: true },
  storage: { type: Object, required: true },
  settings: { type: Object, required: true },
});

const showSettings = ref(false);
</script>

<template>
  <div class="app-container app-fullheight">
    <Toaster />
    <div v-if="!persistent" class="volatile-banner" role="alert">
      This browser cannot save courses. Changes are lost when the page closes; export your courses to keep them.
    </div>
    <main class="main-fill">
      <CourseConsole>
        <template #status-actions>
          <button class="settings-btn" title="Settings" aria-label="Settings" @click="showSettings = true">⚙︎</button>
        </template>
      </CourseConsole>
    </main>
    <SettingsDialog v-if="showSettings" :settings="settings" :storage="storage" :persistent="persistent" @close="showSettings = false" />
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
.settings-btn {
  flex: none;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 1.05rem;
  cursor: pointer;
}
</style>
