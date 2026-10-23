import { computed, ref, watch } from "vue";
import { isValidRoverPos } from "../lib/rover-ui.mjs";

// The unit reports position at ~1 Hz while it holds a fix and stops when the fix
// drops, so an older position means it cannot answer a capture right now.
const RECEIVER_POSITION_STALE_MS = 5000;

// The handheld GPS unit: its own API and status stream, its survey points, and
// the base-station setup that spans the unit and the rover's correction source.
export function createGpsStore({ host, notify, clock, rover, access }) {
  const { success: notifySuccess, error: notifyError, warning: notifyWarn } = notify;

  function request(endpoint, options) {
    const transport = host.devices.transport("gps");
    if (!transport) return Promise.reject(Object.assign(new Error("No GPS unit is configured."), { status: 503 }));
    return transport.request(endpoint, options);
  }

  // null until the unit answers.
  const gpsStatus = ref(null);
  const gpsOnline = ref(false);

  async function fetchStatus() {
    if (!host.devices.transport("gps")) {
      gpsStatus.value = null;
      gpsOnline.value = false;
      return;
    }
    try {
      gpsStatus.value = await (await request("/api/gps/status")).json();
      gpsOnline.value = true;
    } catch {
      gpsOnline.value = false;
    }
  }

  // The unit's receiver in the shape the panels render. "online" means the unit
  // answers; "connected" also needs its receiver serial link.
  const receiver = computed(() => {
    const s = gpsStatus.value;
    if (!s) return null;
    return {
      online: gpsOnline.value,
      connected: gpsOnline.value && s.receiver_connected !== false,
      mode: s.mode,
      fix_status: s.fix_status,
      last_position: s.last_position ? { lat: s.last_position.lat, lng: s.last_position.lng, alt: s.last_position.alt } : null,
      last_position_at: s.last_position?.at ?? 0,
      ntrip_connected: s.ntrip_connected,
      ntrip: s.ntrip,
      gps: s.gps,
      base: s.base,
    };
  });
  const receiverConnected = computed(() => !!receiver.value?.connected);
  const baseState = computed(() => receiver.value?.base?.state || "idle");
  const surveyingPointId = computed(() =>
    baseState.value === "surveying" ? (receiver.value?.base?.point_id ?? null) : null);

  // Live survey progress from receiver.base.survey; null when not surveying.
  const surveyProgress = computed(() => {
    clock.tick.value;
    const s = receiver.value?.base?.survey;
    if (!s || !s.started_at || !s.duration_s) return null;
    const elapsed = Math.max(0, (Date.now() - s.started_at) / 1000);
    return {
      pct: Math.min(100, Math.round((elapsed / s.duration_s) * 100)),
      remaining: Math.max(0, Math.ceil(s.duration_s - elapsed)),
      elapsed: Math.floor(elapsed),
      duration: s.duration_s,
      samples: s.samples ?? 0,
    };
  });

  const receiverPositionAge = computed(() => {
    clock.tick.value;
    const at = receiver.value?.last_position_at;
    if (!at) return null;
    return Math.max(0, Math.round((Date.now() - at) / 1000));
  });
  const receiverCorrectionAge = computed(() => {
    clock.tick.value;
    const n = receiver.value?.ntrip;
    if (!n?.last_correction_at) return null;
    return Math.max(0, Math.round(Date.now() / 1000 - n.last_correction_at));
  });

  // Only a unit in capture mode is a moving position source.
  const receiverCanTrack = computed(() => {
    const r = receiver.value;
    const lp = r?.last_position;
    return !!(r?.mode === "capture" && lp && isValidRoverPos(lp.lat, lp.lng));
  });

  // Which device supplies the cone-capture position: the GPS unit (preferred,
  // in capture mode with a fresh fix), the rover (fallback), or nothing.
  const positionSource = computed(() => {
    clock.tick.value;
    const r = receiver.value;
    if (r?.connected && r.mode === "capture" && r.last_position
        && Date.now() - r.last_position_at < RECEIVER_POSITION_STALE_MS) return "receiver";
    if (rover.roverStatus.value.connected) return "rover";
    return null;
  });

  // Captures an RTK position for a cone from `source`.
  async function capturePosition(source) {
    const res = source === "receiver"
      ? await request("/api/gps/capture", { method: "POST" })
      : await rover.request("/api/rover/request", { method: "POST" });
    return res.json();
  }

  /* ── Configuration and survey points ──────────────── */
  // The unit's own mode; the rover's correction source lives on the rover.
  const gpsUnitConfig = ref({ mode: "capture", active_base_point_id: null, ntrip_username: "", caster: null });
  // "base" while the rover takes corrections from the unit's caster; the active
  // point only while the unit is a base station.
  const gpsConfig = computed(() => ({
    ntrip_source: rover.roverStatus.value.ntrip_source?.source === "caster" ? "base" : "ngii",
    active_base_point_id: gpsUnitConfig.value.mode === "base" ? gpsUnitConfig.value.active_base_point_id : null,
  }));
  const surveyPoints = ref([]);
  const gpsSaving = ref(false);
  const surveyDuration = 60; // fixed base-station survey window
  const selectedBasePointId = ref(null);

  // Only surveyed points (with recorded coordinates) can serve as a base station.
  const surveyedPoints = computed(() => surveyPoints.value.filter((p) => p.lat != null && p.lng != null));
  const hasSurveyedPoint = computed(() => surveyedPoints.value.length > 0);

  // The rover takes corrections from the unit's caster but the unit is not a live
  // base station → the rover silently drops from RTK fixed to standalone.
  const baseNoReceiver = computed(() =>
    rover.roverStatus.value.ntrip_source?.source === "caster"
    && !(receiver.value?.connected && receiver.value.mode === "base"));
  watch(baseNoReceiver, (now, prev) => {
    if (now && !prev && access.canOperateRover.value) {
      notifyWarn("The GPS unit is not connected. RTK corrections are not reaching the rover.");
    }
  });

  // Keep the base-point choice on the active point, else the first surveyed one.
  watch([gpsConfig, surveyedPoints], () => {
    if (gpsConfig.value.active_base_point_id != null) {
      selectedBasePointId.value = gpsConfig.value.active_base_point_id;
    } else if (selectedBasePointId.value == null && surveyedPoints.value.length) {
      selectedBasePointId.value = surveyedPoints.value[0].id;
    }
  }, { deep: true });

  async function loadConfig() {
    if (!host.devices.transport("gps")) return;
    try {
      const [cfgRes, spRes] = await Promise.all([
        request("/api/gps/config"),
        request("/api/gps/survey-points"),
      ]);
      gpsUnitConfig.value = await cfgRes.json();
      surveyPoints.value = await spRes.json();
    } catch (err) {
      notifyError(err.message || "Failed to load GPS settings.");
    }
  }

  async function setNtripUsername(username) {
    const res = await request("/api/gps/ntrip-username", { method: "PUT", body: JSON.stringify({ username }) });
    gpsUnitConfig.value = await res.json();
  }

  async function setUnitMode(mode, activeBasePointId) {
    const res = await request("/api/gps/config", {
      method: "PUT",
      body: JSON.stringify({ mode, active_base_point_id: activeBasePointId }),
    });
    gpsUnitConfig.value = await res.json();
  }

  // A base station takes two steps on two devices: the unit becomes a caster at a
  // surveyed point, then the rover takes its corrections from that caster.
  async function setNtripSource(source, pointId = null) {
    const roverAvailable = host.devices.transport("rover") != null;
    gpsSaving.value = true;
    try {
      if (source === "base") {
        const pid = pointId ?? selectedBasePointId.value ?? gpsUnitConfig.value.active_base_point_id;
        if (pid == null) { notifyError("Select a survey point first."); return; }
        const gpsDevice = host.devices.selected("gps");
        if (!gpsDevice) { notifyError("No GPS unit is configured."); return; }
        await setUnitMode("base", pid);
        if (roverAvailable) {
          // The rover pins public DNS, so it reaches the caster by tailnet IP.
          const { host: casterHost, port, mountpoint } = gpsUnitConfig.value.caster || {};
          if (!casterHost) throw new Error("The GPS unit has no tailnet address yet. Check its Tailscale connection.");
          await rover.setCorrectionSource({ source: "caster", host: casterHost, port, mountpoint });
        }
        notifySuccess("Set the GPS unit as the base station.");
      } else {
        if (roverAvailable) await rover.setCorrectionSource({ source: "ngii" });
        if (gpsUnitConfig.value.mode === "base") await setUnitMode("capture", null);
        notifySuccess("Switched corrections to NGII.");
      }
    } catch (err) {
      notifyError(err.message || "Failed to change the GPS source.");
    } finally {
      gpsSaving.value = false;
    }
  }

  async function addSurveyPoint(name) {
    try {
      await request("/api/gps/survey-points", { method: "POST", body: JSON.stringify({ name }) });
      await loadConfig();
      return true;
    } catch (err) {
      notifyError(err.message || "Failed to add the survey point.");
      return false;
    }
  }

  async function deleteSurveyPoint(p) {
    try {
      await request(`/api/gps/survey-points/${p.id}`, { method: "DELETE" });
      await loadConfig();
      return true;
    } catch (err) {
      notifyError(err.message || "Failed to delete the survey point.");
      return false;
    }
  }

  async function startSurvey(p) {
    try {
      await request(`/api/gps/survey-points/${p.id}/survey`, {
        method: "POST",
        body: JSON.stringify({ duration_s: surveyDuration }),
      });
      notifySuccess(`Started surveying "${p.name}".`);
    } catch (err) {
      notifyError(err.message || "Failed to start the survey.");
    }
  }

  async function cancelSurvey(p) {
    try {
      await request(`/api/gps/survey-points/${p.id}/survey/cancel`, { method: "POST" });
    } catch (err) {
      notifyError(err.message || "Failed to cancel the survey.");
    }
  }

  // Reload once a survey ends (the GPS API is for rover operators only).
  watch(baseState, (now, prev) => {
    if (prev === "surveying" && now !== "surveying" && access.canOperateRover.value) loadConfig();
  });

  /* ── Events ───────────────────────────────────────── */
  function parseSSE(e) {
    try { return JSON.parse(e.data); } catch { return null; }
  }

  function attachEvents(stream) {
    stream.addEventListener("error", () => { gpsOnline.value = false; });
    stream.addEventListener("gps:status", (e) => {
      const data = parseSSE(e);
      if (!data) return;
      gpsStatus.value = data;
      gpsOnline.value = true;
    });
    // A failed survey otherwise just reverts to "Not surveyed" silently.
    stream.addEventListener("gps:survey_result", (e) => {
      const data = parseSSE(e);
      if (!data) return;
      if (!access.canOperateRover.value) return;
      if (data.ok) {
        notifySuccess(`Survey complete: ${data.name}${data.samples != null ? ` (${data.samples} samples)` : ""}`);
      } else {
        const reason = {
          insufficient_samples: "Not enough RTK fixed samples.",
          unstable: "The position did not stabilize. Check the GPS unit setup.",
        }[data.error] || "Could not collect RTK fixed samples.";
        notifyError(`Survey failed: ${data.name || "survey point"} — ${reason}`);
      }
    });
  }

  return {
    request, gpsStatus, gpsOnline, fetchStatus, attachEvents,
    receiver, receiverConnected, baseState, surveyingPointId, surveyProgress,
    receiverPositionAge, receiverCorrectionAge, receiverCanTrack, positionSource, capturePosition,
    gpsUnitConfig, gpsConfig, surveyPoints, surveyedPoints, hasSurveyedPoint, gpsSaving,
    selectedBasePointId, baseNoReceiver,
    loadConfig, setNtripUsername, setNtripSource, addSurveyPoint, deleteSurveyPoint, startSurvey, cancelSurvey,
  };
}
