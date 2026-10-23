<script setup>
import { computed, ref, watch } from "vue";
import { buildSideRanks } from "../../../cone-index.mjs";
import { missionConeDisplayName } from "../../lib/mission-route.mjs";
import { SPRAY_OUTCOME_SYMBOL } from "../../lib/rover-ui.mjs";
import { useConsoleState } from "../../state/console.mjs";
import ConsoleIcon from "../ConsoleIcon.vue";

// Operate: the rover at a glance, its mission (plan, run, follow, recover), and
// manual control.
const state = useConsoleState();
const { host, course, rover, mission, status, editor } = state;
const { roverStatus, stopping, emergencyStopLatched, pumpOn, pumpBusy } = rover;
const {
  roverMode, pathWaypoints, missionFinishBehavior, pathDistance, executedIndex, sprayResults,
  activeMission, activeMissionAuthority, missionHeld, missionEndBusy, missionEndAwaitingAckId,
  pathButtonDisabled, pathBtnLabel, PAUSABLE_NAV, pauseBusy, manualThrottle, manualSteering, manualAuthorityReleaseBusy,
} = mission;

const configured = computed(() => host.devices.selected("rover") != null);
const connected = computed(() => roverStatus.value.connected);
const gpsCells = computed(() => {
  const g = roverStatus.value.gps || {};
  return [
    ["Heading", g.heading != null ? `${g.heading.toFixed(0)}°` : "—"],
    ["Speed", g.speed != null ? `${g.speed.toFixed(2)} m/s` : "—"],
    ["Accuracy", g.h_acc != null ? `±${g.h_acc.toFixed(2)} m` : "—"],
    ["Satellites", g.num_sv ?? "—"],
  ];
});

/* ── Mission ──────────────────────────────────────── */
const MISSION_STATE = {
  none: { label: "No route", tone: "" },
  "path-ready": { label: "Planned", tone: "info" },
  executing: { label: "Running", tone: "ok" },
  stopped: { label: "Held", tone: "warn" },
  manual: { label: "Manual", tone: "info" },
};
const missionState = computed(() => {
  if (roverMode.value === "executing" && roverStatus.value.nav_state === "PAUSED") return { label: "Paused", tone: "warn" };
  return MISSION_STATE[roverMode.value] || MISSION_STATE.none;
});
const progress = status.missionProgress;
const distanceText = computed(() => {
  const d = pathDistance.value;
  if (!(d > 0)) return null;
  return d >= 1000 ? `${(d / 1000).toFixed(2)} km` : `${d.toFixed(1)} m`;
});
const remainingText = computed(() => {
  const d = progress.value?.remaining;
  if (d == null) return null;
  return d >= 1000 ? `${(d / 1000).toFixed(2)} km left` : `${d.toFixed(0)} m left`;
});
// Why "Plan a mission" is unavailable, if it is.
const planBlocked = computed(() => {
  if (!course.activeCourseId.value) return "Select a course with cones first.";
  if (course.activeCones.value.length === 0) return "The course has no cones yet.";
  if (emergencyStopLatched.value) return "Release the E-stop first.";
  return null;
});
const endAwaiting = computed(() => missionEndBusy.value || missionEndAwaitingAckId.value === activeMissionAuthority.value?.id);
function discardRoute() {
  if (confirm("Discard the planned route?")) mission.clearPath();
}

const sideRanks = computed(() => buildSideRanks(course.activeCones.value));
const waypointRows = computed(() => pathWaypoints.value.map((wp, i) => {
  const spray = sprayResults.value.get(i);
  const stateKey = wp.state === "completed" || i < executedIndex.value ? "done"
    : (roverMode.value === "executing" && i === executedIndex.value ? "active" : "pending");
  return {
    key: `${wp.waypoint_id ?? wp.cone_id}-${i}`,
    name: missionConeDisplayName({ side: wp.side, cone_id: wp.cone_id }, sideRanks.value),
    side: wp.side,
    state: stateKey,
    spray: spray ? SPRAY_OUTCOME_SYMBOL[spray.outcome] || "?" : null,
  };
}));
const showWaypoints = ref(false);

/* ── Manual control ───────────────────────────────── */
const manualActive = computed(() => roverMode.value === "manual");
const manualBlocked = computed(() => {
  if (manualAuthorityReleaseBusy.value) return "Handing control back to the mission…";
  if (manualActive.value) return null;
  if (!connected.value) return "The rover is offline.";
  if (roverStatus.value.nav_state === "EMERGENCY_STOP") return "Release the E-stop first.";
  if (activeMission.value && !missionHeld.value) return "A mission is running; pause it to drive by hand.";
  return null;
});
function toggleManual() {
  if (manualActive.value) mission.stopManualControl();
  else mission.startManualControl();
}

// The knob and readout update imperatively: at pointer rates a reactive write
// would re-render this panel. The store sends the values at 20 Hz.
const knob = ref(null);
const readout = ref(null);
let pad = null;
let padRect = null;
let pointerId = null;
function syncJoystick() {
  if (knob.value) knob.value.style.transform = `translate(${manualSteering.value * 0.82}px, ${-manualThrottle.value * 0.82}px)`;
  if (readout.value) readout.value.textContent = `Throttle ${manualThrottle.value} · Steering ${manualSteering.value}`;
}
watch([manualThrottle, manualSteering], syncJoystick);
watch(manualAuthorityReleaseBusy, (busy) => { if (busy) pointerId = null; });
function updateJoystick(e) {
  if (manualAuthorityReleaseBusy.value || !padRect) return;
  const cx = padRect.left + padRect.width / 2;
  const cy = padRect.top + padRect.height / 2;
  const maxR = padRect.width / 2;
  let dx = (e.clientX - cx) / maxR;
  let dy = -(e.clientY - cy) / maxR;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 1) { dx /= len; dy /= len; }
  manualSteering.value = Math.round(dx * 100);
  manualThrottle.value = Math.round(dy * 100);
}
function onDown(e) {
  if (manualAuthorityReleaseBusy.value) return;
  pad = e.currentTarget;
  padRect = pad.getBoundingClientRect();
  pointerId = e.pointerId;
  pad.setPointerCapture(e.pointerId);
  updateJoystick(e);
}
function onMove(e) {
  if (manualAuthorityReleaseBusy.value || e.pointerId !== pointerId) return;
  updateJoystick(e);
}
function onUp(e) {
  if (e.pointerId !== pointerId) return;
  pointerId = null;
  manualThrottle.value = 0;
  manualSteering.value = 0;
}
</script>

<template>
  <div class="operate" data-testid="operate-panel">
    <section v-if="!configured" class="ck-section">
      <div class="ck-empty">
        <strong>No rover is set up</strong>
        Add the rover's address in the console settings to plan and run missions here.
      </div>
    </section>

    <template v-else>
      <!-- Rover -->
      <section class="ck-section">
        <div class="ck-section-head">
          <span class="ck-section-title">Rover</span>
          <button class="ck-btn quiet" @click="editor.drawer.value = 'rover'"><ConsoleIcon name="calibrate" :size="15" />Details</button>
        </div>
        <template v-if="connected">
          <div class="ck-row wrap summary">
            <span :class="['ck-badge', status.nav.value?.tone === 'bad' ? 'bad' : status.nav.value?.tone === 'ok' ? 'ok' : '']">{{ status.nav.value?.label || "—" }}</span>
            <span v-if="status.fix.value" :class="['ck-badge', status.fix.value.tone]">{{ status.fix.value.label }}</span>
            <span v-if="status.battery.value" :class="['ck-badge', status.battery.value.tone]">Battery {{ status.battery.value.percent }}%</span>
          </div>
          <dl class="gps-cells">
            <div v-for="[k, v] in gpsCells" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></div>
          </dl>
        </template>
        <p v-else class="ck-hint offline">
          Offline<template v-if="status.disconnect.value?.ago"> for {{ status.disconnect.value.ago }}</template>.
          The rover connects on its own once it is powered and on the tailnet.
        </p>
      </section>

      <!-- Mission -->
      <section class="ck-section" data-testid="mission">
        <div class="ck-section-head">
          <span class="ck-section-title">Mission</span>
          <span :class="['ck-badge', missionState.tone]">{{ missionState.label }}</span>
        </div>

        <template v-if="roverMode === 'none' || roverMode === 'manual'">
          <button class="ck-btn primary lg block" :disabled="pathButtonDisabled || !!planBlocked || roverMode === 'manual'" @click="mission.openMissionBuilder()">
            <ConsoleIcon name="route" :size="16" />Plan a mission
          </button>
          <p v-if="planBlocked" class="ck-hint reason">{{ planBlocked }}</p>
        </template>

        <template v-else-if="roverMode === 'path-ready'">
          <div class="facts">
            <span><strong>{{ pathWaypoints.length }}</strong> cones</span>
            <span v-if="distanceText">{{ distanceText }}</span>
            <span>{{ missionFinishBehavior === "return_to_start" ? "Returns to start" : "Stops at the last cone" }}</span>
          </div>
          <button class="ck-btn primary lg block" :disabled="pathButtonDisabled" @click="mission.onPathBtn()">
            <ConsoleIcon name="play" :size="16" />{{ pathBtnLabel === "Run route" ? "Check and run" : pathBtnLabel }}
          </button>
          <div class="ck-row wrap actions">
            <button class="ck-btn" @click="mission.openMissionBuilder()"><ConsoleIcon name="edit" :size="15" />Edit route</button>
            <button class="ck-btn quiet" @click="discardRoute">Discard</button>
          </div>
        </template>

        <template v-else-if="roverMode === 'executing'">
          <div v-if="progress" class="progress">
            <div class="progress-bar"><div class="progress-fill" :style="{ width: `${progress.percent}%` }"></div></div>
            <div class="facts">
              <strong>{{ progress.returnOnly ? "Returning to start" : `${progress.current} / ${progress.total}` }} · {{ progress.percent }}%</strong>
              <span v-if="progress.eta">ETA {{ progress.eta }}</span>
              <span v-if="remainingText">{{ remainingText }}</span>
            </div>
          </div>
          <p class="ck-hint status-line">{{ pathBtnLabel }}</p>
          <button
            v-if="roverStatus.nav_state === 'PAUSED'" class="ck-btn primary lg block"
            :disabled="pauseBusy || !connected" @click="mission.resumeMission()"
          ><ConsoleIcon name="play" :size="16" />Resume</button>
          <button
            v-else class="ck-btn lg block"
            :disabled="pauseBusy || !connected || !PAUSABLE_NAV.has(roverStatus.nav_state)" @click="mission.pauseMission()"
          ><ConsoleIcon name="pause" :size="16" />Pause</button>
        </template>

        <template v-else-if="roverMode === 'stopped'">
          <p class="ck-hint">The mission is held on the rover and can continue from where it stopped.</p>
          <button class="ck-btn primary lg block" :disabled="pathButtonDisabled" @click="mission.onPathBtn()">
            <ConsoleIcon name="play" :size="16" />{{ pathBtnLabel }}
          </button>
          <div class="ck-row wrap actions">
            <button class="ck-btn" :disabled="!missionHeld" @click="mission.openMissionBuilder()"><ConsoleIcon name="edit" :size="15" />Edit remaining route</button>
            <button class="ck-btn danger" :disabled="stopping || endAwaiting" @click="mission.abandonMission()">
              {{ endAwaiting ? "Waiting for the rover…" : "End mission" }}
            </button>
          </div>
        </template>

        <div v-if="waypointRows.length" class="waypoints">
          <button class="ck-btn quiet block waypoints-toggle" :aria-expanded="showWaypoints" @click="showWaypoints = !showWaypoints">
            {{ showWaypoints ? "Hide" : "Show" }} the {{ waypointRows.length }} waypoints
            <ConsoleIcon name="chevron" :size="15" :class="{ flipped: showWaypoints }" />
          </button>
          <ol v-if="showWaypoints" class="waypoint-list">
            <li v-for="(w, i) in waypointRows" :key="w.key" :class="['waypoint', w.state]">
              <span class="wp-index">{{ i + 1 }}</span>
              <span :class="['ck-side', w.side, 'ck-grow']">{{ w.name }}</span>
              <span v-if="w.spray" class="wp-spray">{{ w.spray }}</span>
              <span class="wp-state">{{ w.state === "done" ? "Done" : w.state === "active" ? "Next" : "" }}</span>
            </li>
          </ol>
        </div>
      </section>

      <!-- Manual control -->
      <section class="ck-section">
        <div class="ck-section-head">
          <span class="ck-section-title">Manual control</span>
          <span v-if="manualActive" class="ck-badge info">On</span>
        </div>
        <button
          :class="['ck-btn', 'block', manualActive ? 'danger' : '']" :disabled="!!manualBlocked && !manualActive"
          :aria-pressed="manualActive" @click="toggleManual"
        ><ConsoleIcon name="joystick" :size="16" />{{ manualActive ? "Stop manual control" : "Drive by hand" }}</button>
        <p v-if="manualBlocked && !manualActive" class="ck-hint reason">{{ manualBlocked }}</p>
        <div v-if="manualActive" class="joystick-area">
          <div ref="readout" class="joystick-readout">Throttle 0 · Steering 0</div>
          <div class="joystick" @pointerdown.prevent="onDown" @pointermove.prevent="onMove" @pointerup.prevent="onUp" @pointercancel.prevent="onUp">
            <div class="joystick-cross"></div>
            <div ref="knob" class="joystick-knob" style="transform: translate(0px, 0px)"></div>
          </div>
          <button :class="['ck-btn', 'block', { active: pumpOn }]" :aria-pressed="pumpOn" :disabled="pumpBusy" @click="rover.togglePump()">
            Pump {{ pumpOn ? "on" : "off" }}
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.summary { margin-bottom: 0.6rem; }
.gps-cells { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem 0.75rem; margin: 0; }
.gps-cells div { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.8rem; }
.gps-cells dt { color: var(--text-secondary); }
.gps-cells dd { margin: 0; font-family: "JetBrains Mono", monospace; font-weight: 600; }
.offline { color: var(--text-secondary); }
.facts { display: flex; flex-wrap: wrap; gap: 0.4rem 0.9rem; margin-bottom: 0.6rem; font-size: 0.85rem; color: var(--text-secondary); }
.facts strong { color: var(--text-primary); }
.actions { margin-top: 0.5rem; }
.reason { margin-top: 0.4rem; }
.progress { margin-bottom: 0.4rem; }
.progress-bar { height: 8px; border-radius: 4px; background: var(--bg-hover); overflow: hidden; margin-bottom: 0.45rem; }
.progress-fill { height: 100%; background: var(--accent-primary); transition: width 0.3s ease; }
.status-line { margin-bottom: 0.5rem; }
.waypoints { margin-top: 0.75rem; }
.waypoints-toggle { justify-content: space-between; }
.flipped { transform: rotate(180deg); }
.waypoint-list { list-style: none; margin: 0.3rem 0 0; padding: 0; max-height: 320px; overflow-y: auto; }
.waypoint { display: flex; align-items: center; gap: 0.6rem; min-height: 30px; padding: 0 0.4rem; border-radius: 6px; font-size: 0.83rem; }
.waypoint.done { opacity: 0.55; }
.waypoint.active { background: color-mix(in srgb, var(--accent-primary) 12%, transparent); }
.wp-index { flex: none; width: 1.8rem; font-family: "JetBrains Mono", monospace; color: var(--text-secondary); font-size: 0.75rem; }
.wp-state { flex: none; font-size: 0.72rem; color: var(--text-secondary); }
.joystick-area { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; margin-top: 0.75rem; }
.joystick-readout { font-family: "JetBrains Mono", monospace; font-size: 0.78rem; color: var(--text-secondary); }
.joystick {
  position: relative; width: 200px; height: 200px; border-radius: 50%;
  border: 2px solid var(--border-color); background: var(--bg-primary);
  touch-action: none; user-select: none; cursor: grab;
}
.joystick-cross { position: absolute; inset: 50% 10% auto; height: 1px; background: var(--border-color); }
.joystick-cross::after { content: ""; position: absolute; left: 50%; top: -80px; width: 1px; height: 160px; background: var(--border-color); }
.joystick-knob {
  position: absolute; left: calc(50% - 22px); top: calc(50% - 22px);
  width: 44px; height: 44px; border-radius: 50%;
  background: var(--accent-primary); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); pointer-events: none;
}
</style>
