<script setup>
import { useConsoleState } from "../../state/console.mjs";
import ConsoleIcon from "../ConsoleIcon.vue";

// The rover E-stop, reachable from every screen: it sits above every dialog,
// drawer and toast. It turns into the release button while the rover is
// latched in EMERGENCY_STOP. A phone header has room only for short labels.
const { rover, editor } = useConsoleState();
const { roverStatus, stopping, inEmergency, missionActive, emergencyStop } = rover;
const { isMobile } = editor;
</script>

<template>
  <button
    v-if="roverStatus.connected"
    :class="['estop', { active: missionActive, release: inEmergency }]"
    :disabled="stopping" data-testid="estop"
    :aria-label="inEmergency ? 'Release the E-stop' : 'Emergency stop'"
    :title="inEmergency ? 'Release the E-stop' : 'Emergency stop'"
    @click="emergencyStop"
  >
    <ConsoleIcon :name="inEmergency ? 'play' : 'stop'" :size="16" />
    <span v-if="stopping">{{ inEmergency ? "Releasing…" : "Stopping…" }}</span>
    <span v-else-if="inEmergency">{{ isMobile ? "Release" : "Release E-stop" }}</span>
    <span v-else>{{ isMobile ? "E-stop" : "Emergency stop" }}</span>
  </button>
</template>

<style scoped>
/* The header creates no stacking context, so this z-index lifts the button over
   every dialog backdrop (max 3000). */
.estop {
  position: relative; z-index: 4000; flex: none;
  display: flex; align-items: center; gap: 0.45rem;
  height: 40px; padding: 0 1rem;
  border: none; border-radius: 10px;
  background: #dc2626; color: #fff;
  font: inherit; font-size: 0.9rem; font-weight: 800; letter-spacing: 0.01em; white-space: nowrap;
  box-shadow: 0 4px 14px rgba(220, 38, 38, 0.35);
  cursor: pointer;
}
.estop:hover:not(:disabled) { background: #b91c1c; }
.estop:disabled { opacity: 0.65; cursor: not-allowed; }
.estop.active { animation: estop-pulse 1.6s ease-in-out infinite; }
.estop.release { background: #16a34a; box-shadow: 0 4px 14px rgba(22, 163, 74, 0.35); animation: none; }
.estop.release:hover:not(:disabled) { background: #15803d; }
@keyframes estop-pulse {
  0%, 100% { box-shadow: 0 4px 14px rgba(220, 38, 38, 0.35), 0 0 0 0 rgba(220, 38, 38, 0.7); }
  50% { box-shadow: 0 4px 14px rgba(220, 38, 38, 0.5), 0 0 0 10px rgba(220, 38, 38, 0); }
}
@media (max-width: 768px) {
  .estop { padding: 0 0.75rem; font-size: 0.82rem; }
}
</style>
