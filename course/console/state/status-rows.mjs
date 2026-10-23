import { computed } from "vue";
import { formatAlt, formatCoord } from "../../geo.mjs";
import {
  BATTERY_CRIT_PERCENT, BATTERY_WARN_PERCENT, DISCONNECT_REASON_LABEL, FIX_STATUS_META, roverFaultRows,
} from "../lib/rover-ui.mjs";
import { NAV_LIGHT_MODES } from "./rover-store.mjs";

// Release versions. A console or device built from a release reports its tag
// (vX.Y.Z); edge and dev builds report another name and are never flagged.
const RELEASE_VERSION = /^v\d+\.\d+\.\d+$/;

// Status summaries and detail rows of the rover and the GPS unit, shared by the
// header badges, the device drawer and the Operate panel. A row is
// [key, value, tone?]; tone ("ok" | "warn" | "bad" | "neutral") colours the value.
export function createStatusRows({ host, clock, rover, gps, mission }) {
  const { roverStatus, lastPositionAge, ntripCorrectionAge } = rover;
  const consoleVersion = host.version || "dev";

  function versionRow(key, version) {
    if (!version) return [key, "—"];
    const mismatch = RELEASE_VERSION.test(version) && RELEASE_VERSION.test(consoleVersion) && version !== consoleVersion;
    return mismatch ? [key, `${version} (console ${consoleVersion})`, "warn"] : [key, version];
  }

  // A missing fix still yields a summary in an error state with the cause in
  // the rows: a missing summary would read as "no GPS feature".
  const fix = computed(() => {
    const s = roverStatus.value;
    if (!s.connected) return null;
    const hasFix = !!s.fix_status;
    const label = hasFix ? s.fix_status.replace(/_/g, " ").toUpperCase() : "NO GPS";
    const meta = hasFix ? (FIX_STATUS_META[s.fix_status] || { tone: "bad" }) : { tone: "bad" };
    // A stale position during a mission degrades the tone even when the latched
    // fix looks fine: 5 s warn / 15 s bad while executing, 15 s warn otherwise.
    const age = lastPositionAge.value;
    const exec = mission.roverMode.value === "executing";
    const stale = age != null && (exec ? age >= 5 : age >= 15);
    let tone = meta.tone;
    if (stale && exec && age >= 15) tone = "bad";
    else if (stale) tone = tone === "ok" ? "warn" : tone;
    const rows = [["MODE", label, tone]];
    if (!hasFix) rows.push(["GPS", "NO SIGNAL", "bad"]);
    if (s.last_position?.lat != null && s.last_position?.lng != null) {
      rows.push(["LAT", formatCoord(s.last_position.lat)]);
      rows.push(["LON", formatCoord(s.last_position.lng)]);
    }
    if (s.gps?.altitude != null) rows.push(["ALT", `${formatAlt(s.gps.altitude)} m`]);
    if (age != null) rows.push(["UPDATE", `${age}s`, age <= 2 ? "ok" : age <= 10 ? "warn" : "bad"]);
    if (s.gps?.h_acc != null) {
      const a = s.gps.h_acc;
      rows.push(["ACC", `±${a.toFixed(2)} m`, a <= 0.05 ? "ok" : a <= 0.5 ? "warn" : "bad"]);
    }
    if (s.gps?.v_acc != null) rows.push(["V-ACC", `±${s.gps.v_acc.toFixed(2)} m`]);
    if (s.gps?.speed != null) rows.push(["SPEED", `${s.gps.speed.toFixed(2)} m/s`]);
    if (s.gps?.num_sv != null) {
      const n = s.gps.num_sv;
      rows.push(["SAT", `${n}`, n >= 12 ? "ok" : n >= 6 ? "warn" : "bad"]);
    }
    if (s.gps?.pdop != null) {
      const d = s.gps.pdop;
      rows.push(["PDOP", d.toFixed(2), d <= 2 ? "ok" : d <= 5 ? "warn" : "bad"]);
    }
    if (s.gps?.tdop != null) {
      const d = s.gps.tdop;
      rows.push(["TDOP", d.toFixed(2), d <= 2 ? "ok" : d <= 5 ? "warn" : "bad"]);
    }
    if (s.ntrip_connected) {
      if (s.ntrip?.mountpoint) rows.push(["NTRIP", s.ntrip.mountpoint, "ok"]);
      if (s.ntrip?.host) rows.push(["CASTER", `${s.ntrip.host}${s.ntrip.port ? `:${s.ntrip.port}` : ""}`]);
      const c = ntripCorrectionAge.value;
      if (c != null) rows.push(["FIXED", `${c}s`, c <= 2 ? "ok" : c <= 10 ? "warn" : "bad"]);
      if (s.ntrip?.last_error) rows.push(["ERR", s.ntrip.last_error, "bad"]);
    } else {
      rows.push(["NTRIP", "OFF", "bad"]);
    }
    return { label, tone, rows };
  });

  // On a fault the rows spell out why (the MCU LED shows it; the state alone says only "ERROR").
  const nav = computed(() => {
    const s = roverStatus.value;
    if (!s.connected || !s.nav_state) return null;
    const dist = mission.currentTargetDistance.value;
    const next = mission.executedIndex.value + 1;
    const stateLabel = s.nav_state.replace(/_/g, " ");
    const label = (dist != null && dist < 50) ? `${stateLabel} · #${next} → ${dist.toFixed(1)}m` : stateLabel;
    const fault = s.nav_state === "ERROR" || s.nav_state === "EMERGENCY_STOP";
    const tone = fault ? "bad" : s.nav_state === "IDLE" ? "neutral" : "ok";
    const rows = [["STATUS", stateLabel, tone]];
    if (dist != null) rows.push(["NEXT", `#${next} · ${dist.toFixed(1)} m`]);
    if (fault) rows.push(...roverFaultRows(s));
    return { label, tone, rows };
  });

  const battery = computed(() => {
    const s = roverStatus.value;
    if (!s.connected || !s.battery || s.battery.percent == null) return null;
    const p = s.battery.percent;
    const tone = p <= BATTERY_CRIT_PERCENT ? "bad" : p <= BATTERY_WARN_PERCENT ? "warn" : "ok";
    const rows = [["SOC", `${p}%`, tone]];
    if (s.battery.voltage != null) rows.push(["VOLT", `${s.battery.voltage.toFixed(2)} V`, tone]);
    if (s.battery.voltage_raw != null && s.battery.gain != null && Math.abs(s.battery.gain - 1.0) > 1e-4) {
      rows.push(["ADC", `${s.battery.voltage_raw.toFixed(2)} V`]);
    }
    if (s.battery.gain != null) rows.push(["GAIN", s.battery.gain.toFixed(4)]);
    if (s.battery.calibrated_at) {
      const ago = Math.max(0, Math.round((Date.now() - s.battery.calibrated_at) / 60000));
      rows.push(["FIX", ago < 1 ? "just now" : ago < 60 ? `${ago} min ago` : `${Math.round(ago / 60)} h ago`]);
    }
    return { percent: p, voltage: s.battery.voltage, tone, rows };
  });

  const navLights = computed(() => {
    const s = roverStatus.value;
    if (!s.connected) return null;
    const mode = Number.isInteger(s.nav_lights_mode) ? s.nav_lights_mode : 2;
    return { mode, label: (NAV_LIGHT_MODES[mode] || NAV_LIGHT_MODES[2]).label };
  });

  const missionProgress = computed(() => {
    const m = mission;
    if (m.roverMode.value !== "executing" && m.roverMode.value !== "stopped") return null;
    const returnOnly = m.pathWaypoints.value.length === 0
      && m.missionFinishBehavior.value === "return_to_start"
      && !!m.pathStart.value && !!m.pathReturnOrigin.value;
    if (m.pathWaypoints.value.length === 0 && !returnOnly) return null;
    return {
      current: returnOnly ? 0 : m.executedIndex.value,
      total: returnOnly ? 0 : m.pathWaypoints.value.length,
      percent: m.pathProgress.value,
      eta: m.missionETA.value,
      remaining: m.remainingDistanceM.value,
      returnOnly,
    };
  });

  const disconnect = computed(() => {
    clock.tick.value;
    const s = roverStatus.value;
    if (s.connected) return null;
    const label = DISCONNECT_REASON_LABEL[s.last_disconnect_reason] || s.last_disconnect_reason || "UNKNOWN";
    let ago = null;
    if (s.last_disconnect_at) {
      const sec = Math.max(0, Math.round((Date.now() - s.last_disconnect_at) / 1000));
      if (sec < 60) ago = `${sec}s`;
      else {
        const m = Math.floor(sec / 60);
        const rs = sec % 60;
        ago = rs === 0 ? `${m}m` : `${m}m ${rs}s`;
      }
    }
    return { label, ago };
  });

  const software = computed(() => [
    ["CONSOLE", consoleVersion],
    versionRow("HUB", roverStatus.value.device?.version),
    versionRow("PILOT", roverStatus.value.pilot_version),
  ]);

  // The same rows, order and tones as the rover's fix rows; a base station
  // generates its own corrections, so NTRIP is left out in base mode.
  const receiver = computed(() => {
    const r = gps.receiver.value;
    const online = !!r?.online;
    const rows = [["DEVICE", online ? "ONLINE" : "OFFLINE", online ? "ok" : "bad"]];
    if (!online) return rows;
    rows.push(versionRow("VERSION", gps.gpsStatus.value?.device?.version));
    if (!r.connected) {
      rows.push(["RECEIVER", "DISCONNECTED", "bad"]);
      return rows;
    }
    const g = r.gps || {};
    const hasFix = !!r.fix_status;
    rows.push(["MODE", hasFix ? r.fix_status.replace(/_/g, " ").toUpperCase() : "NO GPS",
      hasFix ? (FIX_STATUS_META[r.fix_status]?.tone || "bad") : "bad"]);
    if (!hasFix) rows.push(["GPS", "NO SIGNAL", "bad"]);
    if (r.last_position?.lat != null && r.last_position?.lng != null) {
      rows.push(["LAT", formatCoord(r.last_position.lat)]);
      rows.push(["LON", formatCoord(r.last_position.lng)]);
    }
    if (g.altitude != null) rows.push(["ALT", `${formatAlt(g.altitude)} m`]);
    const a = gps.receiverPositionAge.value;
    if (a != null) rows.push(["UPDATE", `${a}s`, a <= 2 ? "ok" : a <= 10 ? "warn" : "bad"]);
    if (g.h_acc != null) rows.push(["ACC", `±${g.h_acc.toFixed(2)} m`, g.h_acc <= 0.05 ? "ok" : g.h_acc <= 0.5 ? "warn" : "bad"]);
    if (g.v_acc != null) rows.push(["V-ACC", `±${g.v_acc.toFixed(2)} m`]);
    if (g.speed != null) rows.push(["SPEED", `${g.speed.toFixed(2)} m/s`]);
    if (g.num_sv != null) rows.push(["SAT", `${g.num_sv}`, g.num_sv >= 12 ? "ok" : g.num_sv >= 6 ? "warn" : "bad"]);
    if (g.pdop != null) rows.push(["PDOP", g.pdop.toFixed(2), g.pdop <= 2 ? "ok" : g.pdop <= 5 ? "warn" : "bad"]);
    if (g.tdop != null) rows.push(["TDOP", g.tdop.toFixed(2), g.tdop <= 2 ? "ok" : g.tdop <= 5 ? "warn" : "bad"]);
    if (r.mode !== "base") {
      if (r.ntrip_connected) {
        if (r.ntrip?.mountpoint) rows.push(["NTRIP", r.ntrip.mountpoint, "ok"]);
        if (r.ntrip?.host) rows.push(["CASTER", `${r.ntrip.host}${r.ntrip.port ? `:${r.ntrip.port}` : ""}`]);
        const c = gps.receiverCorrectionAge.value;
        if (c != null) rows.push(["FIXED", `${c}s`, c <= 2 ? "ok" : c <= 10 ? "warn" : "bad"]);
        if (r.ntrip?.last_error) rows.push(["ERR", r.ntrip.last_error, "bad"]);
      } else {
        rows.push(["NTRIP", "OFF", "bad"]);
      }
    }
    return rows;
  });

  return { fix, nav, battery, navLights, missionProgress, disconnect, software, receiver };
}
