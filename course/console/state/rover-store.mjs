import { computed, onScopeDispose, ref, watch } from "vue";
import { ACTIVE_NAV_STATES } from "../lib/rover-ui.mjs";

// Nav-light patterns. The hub persists the choice and re-sends it to the rover
// on (re)connect.
export const NAV_LIGHT_MODES = [
  { mode: 0, label: "Off", short: "OFF" },
  { mode: 1, label: "Steady", short: "STEADY" },
  { mode: 2, label: "Double strobe", short: "STROBE2" },
  { mode: 3, label: "Single strobe", short: "STROBE1" },
  { mode: 4, label: "50% blink", short: "BLINK" },
];

// The selected rover's live status (from its hub) and the operator settings
// and commands that are not part of a mission.
export function createRoverStore({ host, notify, clock }) {
  const { error: notifyError } = notify;

  function request(endpoint, options) {
    const transport = host.devices.transport("rover");
    if (!transport) return Promise.reject(Object.assign(new Error("No rover is configured."), { status: 503 }));
    return transport.request(endpoint, options);
  }

  const roverStatus = ref({
    connected: false,
    last_position_at: 0,
    fix_status: null,
    nav_state: null,
    ntrip_connected: null,
    last_disconnect_reason: null,
    last_disconnect_at: 0,
    last_spray_result: null,
    battery: null,
    ntrip: null,
    gps: null,
    // The rover's correction source: { source: "ngii" } or
    // { source: "caster", host, port, mountpoint } (a GPS unit base station).
    ntrip_source: { source: "ngii" },
    // The NGII login the hub sends with the NGII source ("" = unset).
    ntrip_username: "",
    active_mission: null,
    mission_protocol: { required: 2, connected: null, compatible: false, boot_id: null },
  });
  // The rover's latest position, from position events or a status snapshot;
  // null removes its marker.
  const livePosition = ref(null);

  const lastPositionAge = computed(() => {
    clock.tick.value;
    const at = roverStatus.value.last_position_at;
    if (!at) return null;
    return Math.max(0, Math.round((Date.now() - at) / 1000));
  });
  const ntripCorrectionAge = computed(() => {
    clock.tick.value;
    const n = roverStatus.value.ntrip;
    if (!n?.last_correction_at) return null;
    return Math.max(0, Math.round(Date.now() / 1000 - n.last_correction_at));
  });

  /* ── Emergency stop ───────────────────────────────── */
  const emergencyStopLatched = computed(() =>
    roverStatus.value.nav_state === "EMERGENCY_STOP" || roverStatus.value.stop_requested === true);
  const inEmergency = computed(() => roverStatus.value.nav_state === "EMERGENCY_STOP");
  const missionActive = computed(() => roverStatus.value.connected && ACTIVE_NAV_STATES.has(roverStatus.value.nav_state));
  // Held while a stop or release is in flight, until telemetry confirms the
  // requested state (or 5 s pass, so a missed update can never freeze it);
  // every mission button reflects the same in-flight command.
  const stopping = ref(false);
  let stopRequestedKind = null; // "stop" | "clear" | null
  let stopReleaseTimer = null;

  function clearStopLatch() {
    stopping.value = false;
    stopRequestedKind = null;
    if (stopReleaseTimer) { clearTimeout(stopReleaseTimer); stopReleaseTimer = null; }
  }

  // Stops the rover, or releases a latched E-stop.
  async function emergencyStop() {
    if (stopping.value || !roverStatus.value.connected) return;
    stopRequestedKind = inEmergency.value ? "clear" : "stop";
    stopping.value = true;
    try {
      const path = stopRequestedKind === "clear" ? "/api/rover/clear-emergency" : "/api/rover/stop";
      await request(path, { method: "POST" });
    } catch (err) {
      const kind = stopRequestedKind;
      clearStopLatch();
      notifyError((kind === "clear" ? "Failed to release E-stop: " : "E-stop failed: ") + err.message);
      return;
    }
    stopReleaseTimer = setTimeout(clearStopLatch, 5000);
  }

  watch(() => [roverStatus.value.nav_state, roverStatus.value.stop_requested === true], ([cur, stopRequested]) => {
    if (!stopping.value) return;
    if (stopRequestedKind === "stop" && cur === "EMERGENCY_STOP") clearStopLatch();
    else if (stopRequestedKind === "clear"
        && (cur === "IDLE" || (cur === "PAUSED" && stopRequested === false))) clearStopLatch();
  });

  /* ── Lights, pump ─────────────────────────────────── */
  const navLightsBusy = ref(false);
  async function setNavLights(mode) {
    if (navLightsBusy.value) return false;
    navLightsBusy.value = true;
    try {
      await request("/api/rover/nav-lights", { method: "POST", body: JSON.stringify({ mode }) });
      roverStatus.value = { ...roverStatus.value, nav_lights_mode: mode };
      return true;
    } catch (err) {
      notifyError(`Failed to set nav lights: ${err.message}`);
      return false;
    } finally {
      navLightsBusy.value = false;
    }
  }

  // Status-LED (TSAL) global brightness 0-255.
  const ledBrightness = ref(255);
  watch(() => roverStatus.value.led_brightness, (v) => {
    if (Number.isInteger(v)) ledBrightness.value = v;
  });
  let ledBrightnessTimer = null;
  function setLedBrightness(val) {
    ledBrightness.value = Number(val);
    if (ledBrightnessTimer) clearTimeout(ledBrightnessTimer);
    ledBrightnessTimer = setTimeout(() => {
      request("/api/rover/led-brightness", {
        method: "POST",
        body: JSON.stringify({ brightness: ledBrightness.value }),
      }).catch((err) => notifyError(`Failed to set TSAL brightness: ${err.message}`));
    }, 200);
  }

  // Peristaltic pump: manual on/off toggle and the dispense time.
  const pumpOn = computed(() => roverStatus.value.pump_on === true);
  const pumpBusy = ref(false);
  const pumpDuration = ref(2.0);
  watch(() => roverStatus.value.pump_run_duration, (v) => {
    if (typeof v === "number" && v > 0) pumpDuration.value = v;
  });
  let pumpDurationTimer = null;
  function setPumpDuration(val) {
    pumpDuration.value = Number(val);
    if (pumpDurationTimer) clearTimeout(pumpDurationTimer);
    pumpDurationTimer = setTimeout(() => {
      request("/api/rover/pump-duration", {
        method: "POST",
        body: JSON.stringify({ seconds: pumpDuration.value }),
      }).catch((err) => notifyError(`Failed to set dispense time: ${err.message}`));
    }, 200);
  }

  async function togglePump() {
    if (pumpBusy.value) return;
    pumpBusy.value = true;
    const next = !pumpOn.value;
    try {
      await request("/api/rover/pump", {
        method: "POST",
        body: JSON.stringify({ on: next }),
      });
    } catch (e) {
      notify.warning(`Pump control failed: ${e?.message || e}`);
    } finally {
      pumpBusy.value = false;
    }
  }

  /* ── Corrections ──────────────────────────────────── */
  async function setNtripUsername(username) {
    const res = await request("/api/rover/ntrip-username", { method: "PUT", body: JSON.stringify({ username }) });
    roverStatus.value = { ...roverStatus.value, ntrip_username: (await res.json()).username };
  }

  async function setCorrectionSource(body) {
    const res = await request("/api/rover/ntrip-source", { method: "PUT", body: JSON.stringify(body) });
    roverStatus.value = { ...roverStatus.value, ntrip_source: await res.json() };
  }

  onScopeDispose(() => {
    if (stopReleaseTimer) clearTimeout(stopReleaseTimer);
    if (ledBrightnessTimer) clearTimeout(ledBrightnessTimer);
    if (pumpDurationTimer) clearTimeout(pumpDurationTimer);
  });

  return {
    request, roverStatus, livePosition, lastPositionAge, ntripCorrectionAge,
    emergencyStopLatched, inEmergency, missionActive, stopping, emergencyStop,
    navLightsBusy, setNavLights, ledBrightness, setLedBrightness,
    pumpOn, pumpBusy, togglePump, pumpDuration, setPumpDuration,
    setNtripUsername, setCorrectionSource,
  };
}
