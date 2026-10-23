<script setup>
import ConsoleIcon from "../ConsoleIcon.vue";

// A measuring tool's live readout. It floats at the top of the map on desktop
// and sits in the bottom sheet on phones, where it would hide too much map.
defineProps({
  bar: { type: Object, required: true }, // { icon, label, value, reset? }
  docked: { type: Boolean, default: false },
});
const emit = defineEmits(["reset"]);
</script>

<template>
  <div :class="['tool-bar', { docked, 'has-btn': bar.reset }]" role="status" :aria-label="bar.label" data-testid="tool-bar">
    <ConsoleIcon :name="bar.icon" :size="15" class="tool-bar-icon" />
    <span class="tool-bar-value">{{ bar.value }}</span>
    <button v-if="bar.reset" class="tool-bar-btn" @click="emit('reset')">Reset</button>
  </div>
</template>

<style scoped>
.tool-bar {
  position: absolute; top: 0.75rem; left: 50%; transform: translateX(-50%); z-index: 600;
  display: flex; align-items: center; gap: 0.5rem;
  max-width: calc(100% - 1.5rem); min-height: 34px;
  padding: 0.25rem 0.7rem;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.86); color: #f8fafc;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  font-size: 0.85rem;
}
.tool-bar.has-btn { padding-right: 0.3rem; }
.tool-bar-icon { color: #94a3b8; }
.tool-bar-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; color: #22d3ee; font-variant-numeric: tabular-nums; }
.tool-bar-btn {
  flex: none; padding: 0.2rem 0.6rem; border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 7px;
  background: transparent; color: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer;
}
.tool-bar-btn:hover { background: rgba(255, 255, 255, 0.12); }

/* In the sheet: one quiet line under the tools. */
.tool-bar.docked {
  position: static; transform: none; z-index: auto; max-width: none;
  margin: 0 0.75rem 0.5rem;
  border: 1px solid var(--border-color);
  background: var(--bg-primary); color: var(--text-primary); box-shadow: none;
}
.docked .tool-bar-icon { color: var(--text-secondary); }
.docked .tool-bar-value { color: var(--accent-primary); }
.docked .tool-bar-btn { margin-left: auto; border-color: var(--border-color); }
.docked .tool-bar-btn:hover { background: var(--bg-hover); }
</style>
