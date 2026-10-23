<script setup>
import { computed } from "vue";
import { FIX_STATUS_META } from "../../lib/rover-ui.mjs";
import { useConsoleState } from "../../state/console.mjs";
import ConsoleIcon from "../ConsoleIcon.vue";

// One device's state at a glance; opens its panel in the device drawer.
const props = defineProps({
  kind: { type: String, required: true }, // "rover" | "gps"
  compact: { type: Boolean, default: false },
});

const { rover, gps, status, editor } = useConsoleState();

function fixLabel(fixStatus) {
  if (!fixStatus) return "No GPS";
  return FIX_STATUS_META[fixStatus]?.label || fixStatus.replace(/_/g, " ");
}

const badge = computed(() => {
  if (props.kind === "rover") {
    const s = rover.roverStatus.value;
    if (!s.connected) return { label: "Rover", detail: "Offline", tone: "bad" };
    if (s.nav_state === "EMERGENCY_STOP") return { label: "Rover", detail: "E-stop", tone: "bad" };
    const progress = status.missionProgress.value;
    if (progress) {
      const detail = progress.returnOnly ? `Returning · ${progress.percent}%` : `Mission ${progress.current}/${progress.total} · ${progress.percent}%`;
      return { label: "Rover", detail, tone: status.fix.value?.tone || "neutral" };
    }
    const fix = status.fix.value;
    const battery = status.battery.value;
    const tones = [fix?.tone, battery?.tone, status.nav.value?.tone];
    const tone = tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : "ok";
    const parts = [fixLabel(s.fix_status)];
    if (battery) parts.push(`${battery.percent}%`);
    return { label: "Rover", detail: parts.filter(Boolean).join(" · "), tone };
  }
  const r = gps.receiver.value;
  if (!r?.online) return { label: "GPS unit", detail: "Offline", tone: "bad" };
  if (!r.connected) return { label: "GPS unit", detail: "No receiver", tone: "bad" };
  if (r.mode === "base") return { label: "GPS unit", detail: "Base station", tone: "ok" };
  const fixRow = status.receiver.value.find((row) => row[0] === "MODE");
  return { label: "GPS unit", detail: fixLabel(r.fix_status), tone: fixRow?.[2] || "bad" };
});

const pressed = computed(() => editor.drawer.value === props.kind);
function toggle() {
  editor.drawer.value = pressed.value ? null : props.kind;
}
</script>

<template>
  <button
    :class="['badge', `tone-${badge.tone}`, { compact, pressed }]" :aria-pressed="pressed"
    :aria-label="`${badge.label}: ${badge.detail}`" :title="`${badge.label}: ${badge.detail}`"
    :data-testid="`device-${kind}`" @click="toggle"
  >
    <span class="badge-icon"><ConsoleIcon :name="kind === 'rover' ? 'rover' : 'gps'" :size="16" /><span :class="['ck-dot', badge.tone]"></span></span>
    <span v-if="!compact" class="badge-text">
      <span class="badge-label">{{ badge.label }}</span>
      <span class="badge-detail">{{ badge.detail }}</span>
    </span>
  </button>
</template>

<style scoped>
.badge {
  display: flex; align-items: center; gap: 0.45rem; height: 40px; padding: 0 0.65rem 0 0.55rem;
  border: 1px solid var(--border-color); border-radius: 10px;
  background: var(--bg-secondary); color: var(--text-primary); font: inherit; cursor: pointer;
}
.badge:hover, .badge.pressed { background: var(--bg-hover); }
.badge.compact { padding: 0 0.5rem; }
.badge-icon { position: relative; display: flex; color: var(--text-secondary); }
.badge-icon .ck-dot { position: absolute; right: -3px; bottom: -2px; box-shadow: 0 0 0 2px var(--bg-secondary); }
.badge-text { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; }
.badge-label { font-size: 0.72rem; color: var(--text-secondary); font-weight: 600; }
.badge-detail { font-size: 0.82rem; font-weight: 700; white-space: nowrap; }
.tone-bad .badge-detail { color: #dc2626; }
.tone-warn .badge-detail { color: #d97706; }
[data-theme="dark"] .tone-bad .badge-detail { color: #f87171; }
[data-theme="dark"] .tone-warn .badge-detail { color: #fbbf24; }
</style>
