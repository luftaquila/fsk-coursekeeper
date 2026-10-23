<script setup>
import MapView from "./views/MapView.vue";
import { useHost } from "./host.mjs";
import { createConsoleState, provideConsoleState } from "./state/console.mjs";

// The console root owns every store, so the views and the global E-stop share
// one rover status.
const state = createConsoleState(useHost());
provideConsoleState(state);
const { roverStatus, stopping, inEmergency, missionActive, emergencyStop } = state.rover;
const sseReconnecting = state.reconnecting;
</script>

<template>
  <MapView>
    <template #status-actions><slot name="status-actions" /></template>
  </MapView>

  <!-- SSE 재연결 진행 중 표시: 무음 freeze 방지용. 자동 화해는 onopen 에서
       일어나므로 이 배지는 시각적 신호만 담당. -->
  <div v-if="sseReconnecting" class="sse-reconnecting" role="status">
    <span class="sse-spinner"></span> Reconnecting…
  </div>

  <!-- Global emergency stop: visible only when rover is connected.
       Stronger visual emphasis when a mission is actively running.
       Morphs to a release button when the rover is latched in
       EMERGENCY_STOP so the operator can clear without a tab change. -->
  <button
    v-if="roverStatus.connected"
    :class="['global-estop', { active: missionActive, release: inEmergency }]"
    :disabled="stopping"
    @click="emergencyStop"
    :title="inEmergency ? 'Release E-stop' : 'Emergency stop (available on every screen)'"
  >
    <template v-if="stopping">{{ inEmergency ? 'Releasing...' : 'Stopping...' }}</template>
    <template v-else-if="inEmergency">▶ Release E-stop</template>
    <template v-else>⏹ Emergency stop</template>
  </button>
</template>

<style scoped>
/* z-index 999: sits above Leaflet panes (max 700) and level with the status strip. */
.global-estop {
  position: fixed;
  bottom: 1.25rem;
  right: 1.25rem;
  z-index: 999;
  padding: 0.85rem 1.25rem;
  border: none;
  border-radius: 999px;
  background: #ef4444;
  color: #fff;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 8px 20px rgba(239, 68, 68, 0.35), 0 2px 6px rgba(0, 0, 0, 0.25);
  transition: transform 0.1s, box-shadow 0.15s;
}
.global-estop:hover:not(:disabled) { transform: translateY(-1px); }
.global-estop:active:not(:disabled) { transform: translateY(0); }
.global-estop:disabled { opacity: 0.6; cursor: not-allowed; }

.global-estop.active {
  background: #dc2626;
  animation: estop-pulse 1.6s ease-in-out infinite;
}

/* Morph into a release button when the rover is latched in EMERGENCY_STOP. */
.global-estop.release {
  background: #16a34a;
  box-shadow: 0 8px 20px rgba(22, 163, 74, 0.35), 0 2px 6px rgba(0,0,0,0.25);
  animation: none;
}
.global-estop.release:hover:not(:disabled) {
  background: #15803d;
}

@keyframes estop-pulse {
  0%, 100% { box-shadow: 0 8px 20px rgba(220, 38, 38, 0.35), 0 0 0 0 rgba(220, 38, 38, 0.7); }
  50% { box-shadow: 0 8px 20px rgba(220, 38, 38, 0.5), 0 0 0 12px rgba(220, 38, 38, 0); }
}

.sse-reconnecting {
  position: fixed;
  top: 0.75rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 998;
  padding: 0.4rem 0.85rem;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.95);
  color: #1f2937;
  font-size: 0.8rem;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}
.sse-spinner {
  width: 0.7rem;
  height: 0.7rem;
  border: 2px solid rgba(31, 41, 55, 0.3);
  border-top-color: #1f2937;
  border-radius: 50%;
  display: inline-block;
  animation: sse-spin 0.8s linear infinite;
}
@keyframes sse-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  /* Sit above the map view's bottom rail (~56px) plus the iOS
     home-indicator safe-area, so the button never overlaps tabs. */
  .global-estop {
    bottom: calc(64px + env(safe-area-inset-bottom));
    right: 0.75rem;
    padding: 0.7rem 1rem;
    font-size: 0.85rem;
  }
}
</style>
