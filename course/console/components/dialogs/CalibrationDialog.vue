<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useConsoleState } from "../../state/console.mjs";
import ConsoleDialog from "../ui/ConsoleDialog.vue";

// Both rover calibrations: antenna offset and wheel encoder scale. The rover
// keeps each result and reports every attempt, so a stale or wrong value shows
// before a mission. Starting needs a connected, IDLE rover; the E-stop stays
// reachable above this dialog while the rover drives the pattern.
const emit = defineEmits(["close"]);
const state = useConsoleState();
const { rover, mission } = state;
const { error: notifyError } = state.notify;
const { roverStatus } = rover;

const tab = ref("antenna");
const antennaSubmitting = ref(false);
const wheelSubmitting = ref(false);
const wheelResetSubmitting = ref(false);

const antennaRunning = computed(() => roverStatus.value.nav_state === "CAL_ANTENNA");
const wheelRunning = computed(() => roverStatus.value.nav_state === "CAL_WHEELS");
const canStart = computed(() => roverStatus.value.connected
  && (roverStatus.value.nav_state === "IDLE" || roverStatus.value.nav_state == null));
function startLabel(running) {
  if (running) return "Running";
  if (!roverStatus.value.connected) return "Rover not connected";
  if (roverStatus.value.nav_state && roverStatus.value.nav_state !== "IDLE") return "Only available when IDLE";
  return "Start";
}

function ago(at) {
  if (!at) return "—";
  const min = Math.max(0, Math.round((Date.now() - at) / 60000));
  return min < 1 ? "just now" : `${min} min ago`;
}

const antenna = computed(() => {
  const cal = roverStatus.value.antenna_calibration;
  const fmt = (v) => (typeof v === "number" ? v.toFixed(3) + " m" : "—");
  return {
    a_x: fmt(cal?.a_x),
    a_y: fmt(cal?.a_y),
    rms: typeof cal?.rms_residual_m === "number" ? (cal.rms_residual_m * 100).toFixed(1) + " cm" : "—",
    calibratedAgo: ago(cal?.calibrated_at),
    errorReason: cal && !cal.ok ? cal.reason : null,
    sourceLabel: cal?.source === "manual" ? "Manual" : (cal?.source === "auto" ? "Auto" : null),
  };
});

const wheel = computed(() => {
  const cal = roverStatus.value.wheel_calibration;
  const fmtScale = (v) => (typeof v === "number" ? v.toFixed(4) : "—");
  // radius_m is null when the rover drove straight enough that no trim was needed.
  let radius = "—";
  if (typeof cal?.radius_m === "number") radius = `${cal.radius_m.toFixed(1)} m`;
  else if (typeof cal?.trim_us === "number") radius = "Straight";
  return {
    scale_l: fmtScale(cal?.scale_l),
    scale_r: fmtScale(cal?.scale_r),
    samples: typeof cal?.samples === "number" ? String(cal.samples) : "—",
    trim: typeof cal?.trim_us === "number" ? `${cal.trim_us >= 0 ? "+" : ""}${cal.trim_us.toFixed(1)} µs` : "—",
    radius,
    calibratedAgo: ago(cal?.calibrated_at),
    errorReason: cal && !cal.ok ? cal.reason : null,
    // The wheel scales applied but the steering-trim solve refused to persist.
    steeringWarning: cal && cal.ok && cal.steering_reason ? cal.steering_reason : null,
  };
});

async function post(path, busy, body) {
  busy.value = true;
  try {
    await rover.request(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
    return true;
  } catch (err) {
    notifyError(err.message);
    return false;
  } finally {
    busy.value = false;
  }
}

function startAntenna() {
  if (canStart.value) post("/api/rover/calibrate-antenna", antennaSubmitting);
}
function startWheels() {
  if (canStart.value) post("/api/rover/calibrate-wheels", wheelSubmitting);
}
function resetWheels() {
  if (!roverStatus.value.connected || wheelResetSubmitting.value) return;
  if (!window.confirm("This resets the wheel calibration (scale_l/r=1.0, trim=0 µs). Continue?")) return;
  post("/api/rover/reset-wheel-cal", wheelResetSubmitting);
}

// Manual entry from a tape measure: rear axle centre → antenna phase centre, in
// millimetres; sent in metres.
const manualX = ref("");
const manualY = ref("");
const manualSubmitting = ref(false);
const manualValid = computed(() => {
  const x = parseFloat(manualX.value);
  const y = parseFloat(manualY.value);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 1000 && Math.abs(y) <= 1000;
});
async function saveManual() {
  if (!manualValid.value || !roverStatus.value.connected) return;
  const ok = await post("/api/rover/set-antenna-offset", manualSubmitting, {
    a_x: parseFloat(manualX.value) / 1000,
    a_y: parseFloat(manualY.value) / 1000,
  });
  if (ok) { manualX.value = ""; manualY.value = ""; }
}

// A dropped status event must not leave the buttons stuck on CAL_*, so the
// status is fetched now and every 2 s while the dialog is open. Manual control
// holds the motors' priority window and would starve the calibration drive, so
// opening this releases it.
let poll = null;
onMounted(() => {
  if (mission.roverMode.value === "manual") mission.stopManualControl();
  mission.fetchRoverStatus();
  poll = setInterval(mission.fetchRoverStatus, 2000);
});
onUnmounted(() => clearInterval(poll));
</script>

<template>
  <ConsoleDialog title="Calibration" width="480px" :closable="!antennaSubmitting && !wheelSubmitting" @close="emit('close')">
    <div class="ck-seg tabs" role="tablist">
      <button role="tab" :aria-selected="tab === 'antenna'" :class="['ck-seg-btn', { active: tab === 'antenna' }]" @click="tab = 'antenna'">
        Antenna<span v-if="antennaRunning" class="running-dot" title="Running"></span>
      </button>
      <button role="tab" :aria-selected="tab === 'wheel'" :class="['ck-seg-btn', { active: tab === 'wheel' }]" @click="tab = 'wheel'">
        Wheels<span v-if="wheelRunning" class="running-dot" title="Running"></span>
      </button>
    </div>

    <section v-show="tab === 'antenna'" class="cal">
      <h3>Antenna offset <span v-if="antenna.sourceLabel" class="ck-badge">{{ antenna.sourceLabel }}</span></h3>
      <p class="ck-hint">Rerun when the GPS antenna is moved or remounted.</p>
      <div class="ck-rows current">
        <span class="k">a_x</span><span class="v">{{ antenna.a_x }}</span>
        <span class="k">a_y</span><span class="v">{{ antenna.a_y }}</span>
        <span class="k">RMS</span><span class="v">{{ antenna.rms }}</span>
        <span class="k">Updated</span><span class="v">{{ antenna.calibratedAgo }}</span>
      </div>
      <p v-if="antenna.errorReason" class="cal-error">Last attempt failed: {{ antenna.errorReason }}</p>
      <h4>Manual entry</h4>
      <div class="ck-row manual">
        <label class="ck-field ck-grow">a_x (mm)<input v-model="manualX" class="ck-input" type="number" step="1" inputmode="numeric" placeholder="300" /></label>
        <label class="ck-field ck-grow">a_y (mm)<input v-model="manualY" class="ck-input" type="number" step="1" inputmode="numeric" placeholder="50" /></label>
        <button class="ck-btn primary" :disabled="!manualValid || manualSubmitting || !roverStatus.connected" @click="saveManual">{{ manualSubmitting ? "Saving…" : "Save" }}</button>
      </div>
      <h4>Auto calibration</h4>
      <div class="ck-row">
        <span class="ck-hint ck-grow">Needs 5 m of space on every side.</span>
        <button class="ck-btn primary" :disabled="antennaSubmitting || antennaRunning || !canStart" @click="startAntenna">
          {{ antennaSubmitting ? "Sending…" : startLabel(antennaRunning) }}
        </button>
      </div>
      <p v-if="antennaRunning" class="cal-status">Running…</p>
    </section>

    <section v-show="tab === 'wheel'" class="cal">
      <h3>Wheel encoder scale</h3>
      <p class="ck-hint">Rerun when tires or wheels are replaced, or when odometry or straight tracking disagrees with GPS. Needs 12 m ahead.</p>
      <div class="ck-rows current">
        <span class="k">scale_l</span><span class="v">{{ wheel.scale_l }}</span>
        <span class="k">scale_r</span><span class="v">{{ wheel.scale_r }}</span>
        <span class="k">Samples</span><span class="v">{{ wheel.samples }}</span>
        <span class="k">Steering trim</span><span class="v">{{ wheel.trim }}</span>
        <span class="k">Arc radius</span><span class="v">{{ wheel.radius }}</span>
        <span class="k">Updated</span><span class="v">{{ wheel.calibratedAgo }}</span>
      </div>
      <p v-if="wheel.errorReason" class="cal-error">Last attempt failed: {{ wheel.errorReason }}</p>
      <p v-if="wheel.steeringWarning" class="cal-error warn">Steering trim not applied: {{ wheel.steeringWarning }} (wheel scale applied)</p>
      <p v-if="wheelRunning" class="cal-status">Running…</p>
      <div class="ck-row end">
        <button class="ck-btn quiet" :disabled="wheelResetSubmitting || wheelRunning || !roverStatus.connected" @click="resetWheels">{{ wheelResetSubmitting ? "Resetting…" : "Reset" }}</button>
        <button class="ck-btn primary" :disabled="wheelSubmitting || wheelRunning || !canStart" @click="startWheels">
          {{ wheelSubmitting ? "Sending…" : startLabel(wheelRunning) }}
        </button>
      </div>
    </section>
  </ConsoleDialog>
</template>

<style scoped>
.tabs { display: flex; margin-bottom: 0.75rem; }
.tabs .ck-seg-btn { flex: 1; }
.running-dot { display: inline-block; width: 6px; height: 6px; margin-left: 0.35rem; border-radius: 50%; background: #f59e0b; vertical-align: middle; }
.cal h3 { font-size: 0.95rem; margin-bottom: 0.2rem; display: flex; align-items: center; gap: 0.4rem; }
.cal h4 { font-size: 0.85rem; margin: 0.9rem 0 0.4rem; }
.current { grid-template-columns: max-content 1fr max-content 1fr; margin: 0.6rem 0; padding: 0.5rem 0.7rem; border-radius: 8px; background: var(--bg-primary); }
.manual { align-items: flex-end; }
.cal-error { margin-top: 0.5rem; padding: 0.4rem 0.6rem; border-radius: 6px; font-size: 0.8rem; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.4); }
.cal-error.warn { background: rgba(234, 179, 8, 0.12); border-color: rgba(234, 179, 8, 0.5); }
.cal-status { margin-top: 0.5rem; padding: 0.4rem 0.6rem; border-radius: 6px; font-size: 0.82rem; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.4); }
.end { justify-content: flex-end; margin-top: 0.75rem; }
</style>
