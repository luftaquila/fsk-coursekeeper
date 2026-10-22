// Rover routes and the in-memory rover link state.
//
// deviceApp serves bridge_node on the rover (127.0.0.1 only): the command SSE
// stream and the rover's reports. operatorApp serves browsers on the tailnet:
// rover status, operator commands, mission ledger, and settings.
import crypto from "node:crypto";
import { SYSTEM_ACTOR } from "./actor.mjs";
import { createMissionV2Store, MISSION_PROTOCOL_VERSION } from "./mission-v2.mjs";
import {
  DEFAULT_NTRIP_SOURCE,
  haversine,
  validateAltitude,
  validateCoordinate,
  validateNtripSource,
} from "./validation.mjs";

export const DEFAULT_MAX_WAYPOINT_DIST_M = 200;
export const DEFAULT_MAX_SEGMENT_DIST_M = 50;
const ROVER_MAX_PENDING_REQUESTS = 32;
const ROVER_POSITION_STALE_MS = 30 * 1000;
const POSITION_REQUEST_TIMEOUT_MS = 5000;
// The rover's SSE read timeout is 25s, so a dead connection (Wi-Fi gone, no
// FIN/RST) is noticed within ~25s. Keep the heartbeat at most half of that.
const ROVER_STREAM_HEARTBEAT_MS = 10000;
// The rover POSTs telemetry every 3s. If none arrives for this long, its SSE
// peer is treated as dead and the link flips offline even though the socket
// never closed: an abrupt power-off leaves the TCP connection half-open for
// minutes, and a write to a half-open socket buffers instead of failing.
// 15s, not 10: a telemetry cycle is sleep(3s) + a POST with a 5s timeout, so a
// single slow POST can stretch one cycle to ~8s. 15s clears two such cycles
// before tripping, so a transient stall on a live link does not force-close
// the stream (which would blip the mission to interrupted).
const DEFAULT_DEVICE_STALE_MS = 15 * 1000;
const DEFAULT_DEVICE_WATCHDOG_TICK_MS = 5 * 1000;
const MOVING_MISSION_STATES = ["starting", "running", "pausing", "resuming"];
const NTRIP_SOURCE_KEY = "ntrip_source";
const MISSION_LIST_MAX_LIMIT = 500;
const MISSION_LIST_DEFAULT_LIMIT = 50;
const MAX_ROVER_LOG_ENTRIES = 1000;
const SPRAY_OUTCOMES = new Set(["success", "cancelled", "timeout"]);
// Joystick input arrives at up to 20 Hz, so it is not logged per packet. A
// success is logged once per driving session: a new session starts after a
// 5-minute gap or when another operator takes over. Repeated rejections are
// logged once per minute per operator and reason.
const CONTROL_SESSION_GAP_MS = 5 * 60 * 1000;
const CONTROL_WARN_INTERVAL_MS = 60 * 1000;

const positiveNumber = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

export function registerRoverRoutes({
  deviceApp,
  operatorApp,
  db,
  dbRun,
  logger,
  broadcastEvent,
  device,
  deviceStaleMs,
  deviceWatchdogTickMs,
  maxWaypointDistM,
  maxSegmentDistM,
}) {
  const DEVICE_STALE_MS = positiveNumber(deviceStaleMs, DEFAULT_DEVICE_STALE_MS);
  const DEVICE_WATCHDOG_TICK_MS = positiveNumber(deviceWatchdogTickMs, DEFAULT_DEVICE_WATCHDOG_TICK_MS);
  const MAX_WAYPOINT_DIST_M = positiveNumber(maxWaypointDistM, DEFAULT_MAX_WAYPOINT_DIST_M);
  const MAX_SEGMENT_DIST_M = positiveNumber(maxSegmentDistM, DEFAULT_MAX_SEGMENT_DIST_M);

  const missionV2 = createMissionV2Store(db);
  let roverClient = null;
  let roverProtocolVersion = 0;
  let roverBootId = null;
  let pendingEmergencyClear = null; // { bootId }
  const roverPendingResolves = [];
  const streamHeartbeats = new Set();
  let lastRoverPosition = null; // { lat, lng, alt, at: epoch ms }
  // E-stop telemetry is a high-frequency observation, not a mutation. The hold
  // creation itself is already audited, so log at most one observation per
  // durable hold and boot instead of one per telemetry frame.
  let lastEstopObservedHoldKey = null;
  let closed = false;

  const roverState = {
    last_seen: 0, // epoch ms of the last inbound signal (SSE connect / telemetry / position); drives the liveness watchdog
    connected: false,
    last_position: null,
    last_position_at: 0,
    fix_status: null,
    fix_status_at: 0,
    nav_state: null,
    // Optimistic E-stop latch set by /stop. Telemetry's nav_state cannot clear
    // it; only the rover's EMERGENCY_STOP→IDLE report (operator released the
    // button) or an acknowledged clear does. Start/resume check it too, so an
    // in-flight NAVIGATING frame sent just before the stop cannot reopen them.
    stop_requested: false,
    ntrip_connected: null,
    // Nav-light pattern: 0=off 1=steady 2=double-strobe 3=single-strobe 4=50% blink.
    // Operator-selected and re-sent to the rover on (re)connect.
    nav_lights_mode: 2,
    // Status-LED (WS2812) global brightness 0-255. Re-sent on (re)connect.
    led_brightness: 255,
    // Manual pump toggle. Reset on (re)connect since the rover boots the pump off.
    pump_on: false,
    // Pump run time per waypoint in seconds. Re-sent on (re)connect.
    pump_run_duration: 2.0,
    last_disconnect_reason: null, // "sse_closed" | "write_failed" | "replaced" | "stale"
    last_disconnect_at: 0,
    last_spray_result: null, // { waypoint, outcome, at }
    // { ok, a_x, a_y, rms_residual_m, samples, drive_distance_m, calibrated_at, reason, source }
    antenna_calibration: null,
    // { ok, scale_l, scale_r, gps_distance_m, encoder_left_m, encoder_right_m, samples, trim_us, ... }
    wheel_calibration: null,
    battery: null, // { voltage, voltage_raw, percent, source, gain, measured_v, calibrated_at, flags }
    ntrip: null, // { host, port, mountpoint, fail_count, last_error, last_correction_at, bytes_received }
    gps: null, // { h_acc, v_acc, altitude, speed, heading, num_sv, pdop, tdop }
    updated_at: 0,
  };

  /* ── Hub configuration ─────────────────────────────── */

  const selectConfig = db.prepare("SELECT value FROM hub_config WHERE key=?");
  const upsertConfig = db.prepare(`INSERT INTO hub_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);

  function loadNtripSource() {
    const row = selectConfig.get(NTRIP_SOURCE_KEY);
    if (!row) return { ...DEFAULT_NTRIP_SOURCE };
    let stored = null;
    try { stored = JSON.parse(row.value); } catch { /* reported below */ }
    const checked = validateNtripSource(stored);
    if (checked.valid) return checked.value;
    logger.warn(null, "rover.ntrip_source.invalid_stored", { value: row.value, error: checked.error }, "rover", SYSTEM_ACTOR);
    return { ...DEFAULT_NTRIP_SOURCE };
  }
  let ntripSource = loadNtripSource();

  /* ── Rover link ────────────────────────────────────── */

  function missionProtocol() {
    return {
      required: MISSION_PROTOCOL_VERSION,
      connected: roverProtocolVersion,
      compatible: roverProtocolVersion === MISSION_PROTOCOL_VERSION,
      boot_id: roverBootId,
    };
  }

  // rover:status is GPS-rate, so it carries only the bounded mission summary.
  // The full mission (up to 1,000 waypoints) rides rover:mission mutations and
  // GET /api/rover/status.
  function statusSnapshot() {
    return {
      ...roverState,
      device,
      ntrip_source: ntripSource,
      // Shutdown may close SQLite just before a half-open stream's deferred
      // close or stale callback runs.
      active_mission_summary: db.open ? missionV2.activeMissionSummary() : null,
      mission_protocol: missionProtocol(),
    };
  }

  function broadcastRoverStatus() {
    roverState.updated_at = Date.now();
    broadcastEvent("rover:status", statusSnapshot());
  }

  function broadcastMissionMutation(mission) {
    broadcastEvent("rover:mission", { mission: mission || null });
  }

  function markRoverDisconnected(reason) {
    if (roverState.connected) {
      roverState.last_disconnect_reason = reason;
      roverState.last_disconnect_at = Date.now();
    }
    roverState.connected = false;
  }

  function sendRoverEvent(event, data) {
    if (!roverClient) return false;
    try {
      roverClient.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      try { roverClient.end(); } catch { /* already closed */ }
      roverClient = null;
      markRoverDisconnected("write_failed");
      logger.warn(null, "rover.stream.write_failed", { event }, "rover", SYSTEM_ACTOR);
      broadcastRoverStatus();
      return false;
    }
  }

  function sendSafetyHold(mission, reason) {
    return sendRoverEvent("mission-safety-hold", {
      protocol_version: MISSION_PROTOCOL_VERSION,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      hold_id: mission.active_hold_id,
      reason,
    });
  }

  // The rover keeps driving autonomously when the hub loses it, so a moving
  // mission is flagged interrupted (resumable), never ended.
  function interruptMovingMission(req, reason, actor) {
    const active = db.open ? missionV2.activeMission() : null;
    if (!active || !MOVING_MISSION_STATES.includes(active.status)) return;
    const interrupted = missionV2.markInterrupted(active.id, reason, roverBootId);
    logger.warn(req, "mission.v2.interrupted", {
      mission_id: active.id,
      before: active.status,
      after: interrupted?.status,
      reason,
      boot_id: roverBootId,
    }, active.course_name, actor);
    broadcastMissionMutation(interrupted);
  }

  function activeMissionId() {
    return missionV2.activeMissionSummary()?.id ?? null;
  }

  const insertTelemetry = db.prepare(
    `INSERT INTO mission_telemetry
       (mission_id, t, lat, lng, fix_status, nav_state, ntrip_connected, corr_age_ms, ntrip_fail_count, h_acc_m, altitude_m, v_acc_m)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  function recordTelemetrySample(missionId) {
    if (missionId == null) return;
    const pos = roverState.last_position;
    const now = Date.now();
    // ntrip_connected=false zeroes roverState.ntrip, so a disconnected sample
    // has a null correction age: the flag alone is the network-drop signature.
    // last_correction_at is the rover's unix-seconds clock; rover and hub are
    // NTP-synced, so the ms delta is meaningful.
    const ntrip = roverState.ntrip;
    const corrAgeMs =
      ntrip && typeof ntrip.last_correction_at === "number" && ntrip.last_correction_at > 0
        ? Math.max(0, now - Math.round(ntrip.last_correction_at * 1000))
        : null;
    // A failed insert must not fail the rover's POST.
    try {
      insertTelemetry.run(
        missionId,
        now,
        pos ? pos.lat : null,
        pos ? pos.lng : null,
        roverState.fix_status,
        roverState.nav_state,
        typeof roverState.ntrip_connected === "boolean" ? (roverState.ntrip_connected ? 1 : 0) : null,
        corrAgeMs,
        ntrip && Number.isInteger(ntrip.fail_count) ? ntrip.fail_count : null,
        roverState.gps && typeof roverState.gps.h_acc === "number" ? roverState.gps.h_acc : null,
        roverState.gps && typeof roverState.gps.altitude === "number" ? roverState.gps.altitude : null,
        roverState.gps && typeof roverState.gps.v_acc === "number" ? roverState.gps.v_acc : null,
      );
    } catch (e) {
      logger.warn(null, "mission.telemetry_persist", { error: e.message || String(e), mission_id: missionId }, "rover", SYSTEM_ACTOR);
    }
  }

  // Liveness watchdog (see DEFAULT_DEVICE_STALE_MS). It mirrors the stream's
  // close path: the link goes offline and a moving mission is interrupted.
  const deviceLivenessWatchdog = setInterval(() => {
    const now = Date.now();
    if (!roverState.connected || now - roverState.last_seen <= DEVICE_STALE_MS) return;
    if (roverClient) { try { roverClient.end(); } catch { /* already closed */ } roverClient = null; }
    markRoverDisconnected("stale");
    interruptMovingMission(null, "telemetry_stale", SYSTEM_ACTOR);
    roverProtocolVersion = 0;
    logger.warn(null, "rover.stream.stale", { silent_ms: now - roverState.last_seen }, "rover", SYSTEM_ACTOR);
    broadcastRoverStatus();
  }, DEVICE_WATCHDOG_TICK_MS);
  deviceLivenessWatchdog.unref?.();

  // Telemetry sanitizers. They return null when the block is absent or
  // malformed, and the cached value is then left untouched.
  function sanitizeGpsMetrics(gps) {
    if (!gps || typeof gps !== "object" || Array.isArray(gps)) return null;
    return {
      h_acc: typeof gps.h_acc === "number" ? gps.h_acc : null,
      v_acc: typeof gps.v_acc === "number" ? gps.v_acc : null,
      altitude: typeof gps.altitude === "number" ? gps.altitude : null,
      speed: typeof gps.speed === "number" ? gps.speed : null,
      heading: typeof gps.heading === "number" ? gps.heading : null,
      num_sv: Number.isInteger(gps.num_sv) ? gps.num_sv : null,
      pdop: typeof gps.pdop === "number" ? gps.pdop : null,
      tdop: typeof gps.tdop === "number" ? gps.tdop : null,
    };
  }
  function sanitizeNtripDetail(ntrip) {
    if (!ntrip || typeof ntrip !== "object" || Array.isArray(ntrip)) return null;
    return {
      host: typeof ntrip.host === "string" ? ntrip.host.slice(0, 128) : null,
      port: Number.isInteger(ntrip.port) ? ntrip.port : null,
      mountpoint: typeof ntrip.mountpoint === "string" ? ntrip.mountpoint.slice(0, 64) : null,
      fail_count: Number.isInteger(ntrip.fail_count) ? ntrip.fail_count : null,
      last_error: typeof ntrip.last_error === "string" ? ntrip.last_error.slice(0, 256) : null,
      last_correction_at: typeof ntrip.last_correction_at === "number" ? ntrip.last_correction_at : null,
      bytes_received: Number.isInteger(ntrip.bytes_received) ? ntrip.bytes_received : null,
    };
  }

  function rejectNoRover(req, res, action, extra = {}) {
    logger.warn(req, action, { error: "not_connected", ...extra }, "rover");
    return res.status(503).send("The rover is not connected.");
  }

  function rejectWriteFailed(req, res, action, extra = {}) {
    logger.warn(req, action, { error: "write_failed", ...extra }, "rover");
    return res.status(503).send("The rover connection was lost.");
  }

  // A report must come from the boot session that holds the stream. A protocol
  // v2 rover always sends boot_id; a report that names one must match too.
  function isStaleBoot(reportedBootId) {
    const mustMatch = reportedBootId !== undefined || roverProtocolVersion === MISSION_PROTOCOL_VERSION;
    return mustMatch && (!roverClient || typeof reportedBootId !== "string" || reportedBootId !== roverBootId);
  }

  /* ============================================
     Device API (bridge_node)
     ============================================ */

  deviceApp.get("/api/rover/stream", (req, res) => {
    if (closed) return res.status(503).send("The hub is shutting down.");
    const announcedProtocol = Number(req.query.protocol_version);
    const announcedBootId = typeof req.query.boot_id === "string" ? req.query.boot_id.slice(0, 128) : null;
    const previousBootId = roverBootId;
    let bootReconcileHold = null;
    const nextProtocolVersion = Number.isInteger(announcedProtocol) ? announcedProtocol : 0;
    if (nextProtocolVersion === MISSION_PROTOCOL_VERSION) {
      const bootClaim = missionV2.claimRoverBootSession(announcedBootId);
      if (!bootClaim.accepted) {
        logger.warn(req, "rover.stream.boot_rejected", {
          error: bootClaim.reason,
          reported_boot_id: announcedBootId,
          generation: bootClaim.generation ?? null,
          current_generation: bootClaim.current_generation ?? null,
        }, "rover");
        return res.status(409).send(bootClaim.reason === "stale_boot_session"
          ? "A superseded rover boot session cannot reconnect."
          : "A valid boot_id is required.");
      }
      logger.log(req, "rover.stream.boot_claimed", {
        boot_id: announcedBootId,
        generation: bootClaim.generation,
        last_report_seq: bootClaim.last_report_seq,
        replay: bootClaim.replay,
      }, "rover");
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ required_mission_protocol: MISSION_PROTOCOL_VERSION })}\n\n`);

    roverProtocolVersion = nextProtocolVersion;
    roverBootId = announcedBootId;
    if (roverProtocolVersion === MISSION_PROTOCOL_VERSION && roverBootId) {
      if (previousBootId !== roverBootId) pendingEmergencyClear = null;
      const beforeBootReconcile = missionV2.activeMission();
      const afterBootReconcile = missionV2.reconcileRoverBoot(roverBootId);
      if (afterBootReconcile?.active_hold_id) {
        bootReconcileHold = afterBootReconcile;
      }
      if (beforeBootReconcile && afterBootReconcile
          && (beforeBootReconcile.status !== afterBootReconcile.status
            || beforeBootReconcile.active_command_id !== afterBootReconcile.active_command_id)) {
        logger.log(req, "mission.v2.boot_reconcile", {
          mission_id: afterBootReconcile.id,
          previous_boot_id: previousBootId,
          reported_boot_id: roverBootId,
          before: {
            state: beforeBootReconcile.status,
            active_command_id: beforeBootReconcile.active_command_id,
          },
          after: {
            state: afterBootReconcile.status,
            active_command_id: afterBootReconcile.active_command_id,
          },
        }, afterBootReconcile.course_name);
        broadcastMissionMutation(afterBootReconcile);
      }
    } else {
      logger.warn(req, "rover.protocol.incompatible", {
        announced: roverProtocolVersion || null,
        required: MISSION_PROTOCOL_VERSION,
        boot_id: roverBootId,
      }, "rover");
    }

    // A new stream replaces the old one. The mission is kept: the rover keeps
    // driving on the waypoints it has while it reconnects, and the new session
    // inherits the same mission. The replaced stream's own close handler cannot
    // log this because roverClient no longer points at it.
    if (roverClient && roverClient !== res) {
      logger.warn(req, "rover.stream.replaced", { mission_id: activeMissionId() }, "rover");
      markRoverDisconnected("replaced");
      try { roverClient.end(); } catch { /* already closed */ }
    }
    roverClient = res;
    roverState.connected = true;
    roverState.last_seen = Date.now();
    roverState.last_disconnect_reason = null;
    roverState.last_disconnect_at = 0;
    roverState.pump_on = false;
    logger.log(req, "rover.stream.connected", null, "rover");
    broadcastRoverStatus();

    // Re-apply operator settings so they survive a pilot restart.
    if (roverState.nav_lights_mode != null) sendRoverEvent("nav-lights", { mode: roverState.nav_lights_mode });
    if (roverState.led_brightness != null) sendRoverEvent("led-brightness", { brightness: roverState.led_brightness });
    if (roverState.pump_run_duration != null) sendRoverEvent("pump-duration", { seconds: roverState.pump_run_duration });
    sendRoverEvent("ntrip-source", ntripSource);

    if (roverProtocolVersion === MISSION_PROTOCOL_VERSION) {
      // A bridge/process boot identity change is a hard hold boundary. Usually
      // the navigator restarted too and already restored PAUSED, but this also
      // stops a still-running navigator if only the bridge was replaced. The hub
      // refuses a running state report while hold_reason=rover_rebooted until an
      // explicit resume command.
      if (bootReconcileHold && !sendSafetyHold(bootReconcileHold, "rover_rebooted")) {
        logger.warn(req, "mission.v2.boot_hold", {
          error: "write_failed",
          mission_id: bootReconcileHold.id,
          boot_id: roverBootId,
        }, bootReconcileHold.course_name);
      }
      sendRoverEvent("mission-state-request", { protocol_version: MISSION_PROTOCOL_VERSION });
      for (const command of missionV2.pendingCommands()) {
        if (command.rover_boot_id && command.rover_boot_id !== roverBootId) continue;
        let payload = null;
        try { payload = JSON.parse(command.payload_json); } catch { /* logged when command was created */ }
        if (payload) sendRoverEvent("mission-command", payload);
      }
    }

    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(heartbeat);
        streamHeartbeats.delete(heartbeat);
        return;
      }
      try { res.write(": heartbeat\n\n"); } catch { /* the close handler cleans up */ }
    }, ROVER_STREAM_HEARTBEAT_MS);
    streamHeartbeats.add(heartbeat);

    req.on("close", () => {
      clearInterval(heartbeat);
      streamHeartbeats.delete(heartbeat);
      if (roverClient !== res) return;
      roverClient = null;
      markRoverDisconnected("sse_closed");
      logger.log(req, "rover.stream.closed", null, "rover");
      interruptMovingMission(req, "sse_disconnect");
      roverProtocolVersion = 0;
      broadcastRoverStatus();
    });
  });

  deviceApp.post("/api/rover/position", (req, res) => {
    const body = req.body || {};
    const { lat, lng, alt, request_id, request_ids } = body;
    if (isStaleBoot(body.boot_id)) {
      logger.warn(req, "rover.position.stale_boot", {
        error: "stale_boot",
        reported_boot_id: body.boot_id || null,
        connected_boot_id: roverBootId,
      }, "rover");
      return res.status(409).send("The position is not from the connected rover boot session.");
    }

    const requestIds = Array.isArray(request_ids) ? request_ids : [request_id];
    // Cone-capture failure: the rover could not hold a stable RTK fix. The
    // pending request fails now instead of waiting for its timeout.
    if (body.capture_failed) {
      for (const id of requestIds) {
        if (typeof id !== "string" || !id) continue;
        const idx = roverPendingResolves.findIndex((entry) => entry.request_id === id);
        if (idx !== -1) {
          const [{ resolve }] = roverPendingResolves.splice(idx, 1);
          resolve({ ok: false, error: typeof body.error === "string" ? body.error : "capture_failed" });
        }
      }
      return res.json({ ok: true });
    }

    const coordValidation = validateCoordinate(lat, lng);
    if (!coordValidation.valid) return res.status(400).send(coordValidation.error);
    const altValidation = validateAltitude(alt);
    if (!altValidation.valid) return res.status(400).send(altValidation.error);
    // MSL altitude from the same RTK fix as lat/lng.
    const altValue = altValidation.value;
    const now = Date.now();
    roverState.last_seen = now;
    lastRoverPosition = { lat, lng, alt: altValue, at: now };
    roverState.last_position = { lat, lng, alt: altValue };
    roverState.last_position_at = now;

    // Only an explicit request id resolves a pending capture; periodic
    // position POSTs carry none.
    for (const id of requestIds) {
      if (typeof id !== "string" || !id) continue;
      const idx = roverPendingResolves.findIndex((entry) => entry.request_id === id);
      if (idx !== -1) {
        const [{ resolve }] = roverPendingResolves.splice(idx, 1);
        resolve({ lat, lng, alt: altValue });
      }
    }

    recordTelemetrySample(activeMissionId());
    broadcastEvent("rover", { lat, lng, alt: altValue, source: "rover" });
    broadcastRoverStatus();
    res.json({ lat, lng, alt: altValue });
  });

  deviceApp.post("/api/rover/telemetry", (req, res) => {
    const body = req.body || {};
    const { nav_state, fix_status, ntrip_connected, battery, ntrip, gps } = body;
    if (isStaleBoot(body.boot_id)) {
      logger.warn(req, "rover.telemetry.stale_boot", {
        error: "stale_boot",
        reported_boot_id: body.boot_id || null,
        connected_boot_id: roverBootId,
      }, "rover");
      return res.status(409).send("The telemetry is not from the connected rover boot session.");
    }

    const now = Date.now();
    roverState.last_seen = now;
    const prevNav = roverState.nav_state;
    if (typeof nav_state === "string") roverState.nav_state = nav_state;
    // The optimistic E-stop latch clears only when the rover reports
    // EMERGENCY_STOP→IDLE (the operator physically released it).
    if (prevNav === "EMERGENCY_STOP" && nav_state === "IDLE") {
      roverState.stop_requested = false;
      pendingEmergencyClear = null;
    }
    if (typeof fix_status === "string") {
      roverState.fix_status = fix_status;
      roverState.fix_status_at = now;
    }
    // null means "not reported"; false means "reported disconnected", which
    // also drops the previous caster detail so it is not shown as current.
    if (typeof ntrip_connected === "boolean") {
      roverState.ntrip_connected = ntrip_connected;
      if (ntrip_connected === false) roverState.ntrip = null;
    }
    if (battery && typeof battery === "object") {
      roverState.battery = {
        voltage: typeof battery.voltage === "number" ? battery.voltage : null,
        voltage_raw: typeof battery.voltage_raw === "number" ? battery.voltage_raw : null,
        percent: Number.isInteger(battery.percent) ? battery.percent : null,
        source: typeof battery.source === "string" ? battery.source : null,
        gain: typeof battery.gain === "number" ? battery.gain : null,
        measured_v: typeof battery.measured_v === "number" ? battery.measured_v : null,
        calibrated_at: Number.isInteger(battery.calibrated_at) ? battery.calibrated_at : null,
        // Raw MCU status flags (T-frame field 7): the console decodes the
        // fault behind an ERROR / EMERGENCY_STOP chip from them.
        flags: Number.isInteger(battery.flags) ? battery.flags : null,
      };
    }
    const gpsMetrics = sanitizeGpsMetrics(gps);
    if (gpsMetrics) roverState.gps = gpsMetrics;
    const ntripDetail = sanitizeNtripDetail(ntrip);
    if (ntripDetail) roverState.ntrip = ntripDetail;

    if (roverProtocolVersion === MISSION_PROTOCOL_VERSION && nav_state === "EMERGENCY_STOP") {
      // Telemetry can stay at GPS rate throughout an E-stop. The bounded summary
      // is mutation-maintained, so this safety gate must not load up to 1,000
      // waypoint rows on every identical frame.
      const activeV2 = missionV2.activeMissionSummary();
      if (activeV2 && activeV2.active_hold_id) {
        const observedHoldKey = `${activeV2.id}:${activeV2.active_hold_id}:${roverBootId || ""}`;
        if (lastEstopObservedHoldKey !== observedHoldKey) {
          lastEstopObservedHoldKey = observedHoldKey;
          logger.warn(req, "mission.v2.estop_observed", {
            mission_id: activeV2.id,
            reason: "reboot_hold_preserved",
            active_hold_id: activeV2.active_hold_id,
            boot_id: roverBootId,
          }, activeV2.course_name);
        }
      } else if (activeV2 && !activeV2.motion_confirmed_held) {
        const interrupted = missionV2.markInterrupted(
          activeV2.id, "emergency_stop", roverBootId, { confirmed: true },
        );
        logger.warn(req, "mission.v2.interrupted", {
          mission_id: activeV2.id,
          before: activeV2.status,
          after: interrupted?.status,
          reason: "emergency_stop_confirmed",
          boot_id: roverBootId,
        }, activeV2.course_name);
        broadcastMissionMutation(interrupted);
      }
    }

    recordTelemetrySample(activeMissionId());
    broadcastRoverStatus();
    res.json({ ok: true });
  });

  // Rover-local waypoint index events. Mission progress is tracked by
  // mission-report; these only relay the live event to operators.
  deviceApp.post("/api/rover/waypoint_reached", (req, res) => {
    const index = Number(req.body?.index);
    if (!Number.isInteger(index) || index < 0) return res.status(400).send("Invalid waypoint index.");
    broadcastEvent("rover:waypoint", { index });
    res.json({ ok: true });
  });

  deviceApp.post("/api/rover/waypoint_skipped", (req, res) => {
    const index = Number(req.body?.index);
    if (!Number.isInteger(index) || index < 0) return res.status(400).send("Invalid waypoint index.");
    broadcastEvent("rover:skipped", { index });
    logger.warn(req, "rover.waypoint_skipped", { index, mission_id: activeMissionId() }, "rover");
    res.json({ ok: true });
  });

  deviceApp.post("/api/rover/spray_result", (req, res) => {
    const index = Number(req.body?.waypoint);
    const outcome = req.body?.outcome;
    if (!Number.isInteger(index) || index < 0 || !SPRAY_OUTCOMES.has(outcome)) {
      return res.status(400).send("Invalid spray result.");
    }
    roverState.last_spray_result = { waypoint: index, outcome, at: Date.now() };
    broadcastEvent("rover:spray", { waypoint: index, outcome, at: roverState.last_spray_result.at });
    broadcastRoverStatus();
    res.json({ ok: true });
  });

  deviceApp.post("/api/rover/antenna_calibration_result", (req, res) => {
    const body = req.body || {};
    const ok = !!body.ok;
    // Everything the rover sent is logged so a failed calibration shows which
    // gate tripped without SSH.
    const stored = {
      ok,
      a_x: typeof body.a_x === "number" ? body.a_x : null,
      a_y: typeof body.a_y === "number" ? body.a_y : null,
      rms_residual_m: typeof body.rms_residual_m === "number" ? body.rms_residual_m : null,
      samples: Number.isInteger(body.samples) ? body.samples : null,
      drive_distance_m: typeof body.drive_distance_m === "number" ? body.drive_distance_m : null,
      calibrated_at: Number.isInteger(body.calibrated_at) ? body.calibrated_at : Date.now(),
      reason: typeof body.reason === "string" ? body.reason : null,
      // 'auto' (calibration drive) or 'manual' (operator-entered offset).
      source: body.source === "manual" ? "manual" : (body.source === "auto" ? "auto" : null),
    };
    roverState.antenna_calibration = stored;
    broadcastEvent("rover:antenna_calibration", stored);
    broadcastRoverStatus();
    if (ok) logger.log(req, "rover.antenna_calibration", stored, "rover");
    else logger.warn(req, "rover.antenna_calibration", stored, "rover");
    res.json({ ok: true });
  });

  deviceApp.post("/api/rover/wheel_calibration_result", (req, res) => {
    const body = req.body || {};
    const ok = !!body.ok;
    const stored = {
      ok,
      scale_l: typeof body.scale_l === "number" ? body.scale_l : null,
      scale_r: typeof body.scale_r === "number" ? body.scale_r : null,
      gps_distance_m: typeof body.gps_distance_m === "number" ? body.gps_distance_m : null,
      encoder_left_m: typeof body.encoder_left_m === "number" ? body.encoder_left_m : null,
      encoder_right_m: typeof body.encoder_right_m === "number" ? body.encoder_right_m : null,
      samples: Number.isInteger(body.samples) ? body.samples : null,
      // Steering-trim calibration rides the same drive. A null radius_m means
      // the path was straight (0 µs trim); a null trim_us with steering_reason
      // means the trim solve failed but the wheel scales still applied.
      trim_us: typeof body.trim_us === "number" ? body.trim_us : null,
      radius_m: typeof body.radius_m === "number" ? body.radius_m : null,
      steering_rms_m: typeof body.steering_rms_m === "number" ? body.steering_rms_m : null,
      steering_reason: typeof body.steering_reason === "string" ? body.steering_reason : null,
      // The rover does not stamp the result; receipt is within ~100 ms of the solve.
      calibrated_at: Date.now(),
      reason: typeof body.reason === "string" ? body.reason : null,
    };
    roverState.wheel_calibration = stored;
    broadcastRoverStatus();
    if (ok) logger.log(req, "rover.wheel_calibration", stored, "rover");
    else logger.warn(req, "rover.wheel_calibration", stored, "rover");
    res.json({ ok: true });
  });

  // Rover log cache: in memory only. Filled by the rover, read by operators.
  let roverLogCache = { entries: [], uploaded_at: 0 };

  deviceApp.post("/api/rover/logs", (req, res) => {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
    if (!entries) return res.status(400).send("Invalid log payload.");
    const sanitized = entries
      .filter((e) => e && typeof e === "object")
      .slice(-MAX_ROVER_LOG_ENTRIES)
      .map((e) => ({
        t: Number(e.t) || 0,
        level: typeof e.level === "string" ? e.level.slice(0, 10) : "",
        node: typeof e.node === "string" ? e.node.slice(0, 64) : "",
        msg: typeof e.msg === "string" ? e.msg.slice(0, 2000) : "",
      }));
    roverLogCache = { entries: sanitized, uploaded_at: Date.now() };
    broadcastEvent("rover:logs", { count: sanitized.length, uploaded_at: roverLogCache.uploaded_at });
    res.json({ ok: true, stored: sanitized.length });
  });

  deviceApp.post("/api/rover/mission-report", (req, res) => {
    const body = req.body || {};
    if (body.protocol_version !== MISSION_PROTOCOL_VERSION) {
      logger.warn(req, "mission.report", { error: "protocol_mismatch", announced: body.protocol_version, required: MISSION_PROTOCOL_VERSION }, "rover");
      return res.status(409).send("Mission protocol version mismatch.");
    }
    if (!roverClient || roverProtocolVersion !== MISSION_PROTOCOL_VERSION || typeof body.boot_id !== "string" || body.boot_id !== roverBootId) {
      logger.warn(req, "mission.report", { error: "stale_boot", reported_boot_id: body.boot_id, connected_boot_id: roverBootId }, "rover");
      return res.status(409).send("The report is not from the connected rover boot session.");
    }
    if (!Number.isSafeInteger(body.report_seq) || body.report_seq < 0) {
      return res.status(400).send("Invalid report_seq.");
    }
    try {
      const sequenced = missionV2.processRoverReport(body.boot_id, body.report_seq, () => {
        const before = missionV2.missionPublic(Number(body.mission_id));
        if (before && ["completed", "cancelled"].includes(before.status) && body.event !== "command") {
          if (before.plan_hash !== body.plan_hash) {
            throw Object.assign(new Error("The rover plan hash does not match the hub."), {
              status: 409, reason: "plan_hash_mismatch",
            });
          }
          return { before, mission: before, terminal: true };
        }
        return { before, mission: missionV2.applyReport(body), terminal: false };
      });
      if (sequenced.duplicate) {
        const duplicateMission = missionV2.missionPublic(Number(body.mission_id));
        const terminalDuplicate = duplicateMission
          && duplicateMission.plan_hash === body.plan_hash
          && ["completed", "cancelled"].includes(duplicateMission.status);
        if (terminalDuplicate) {
          logger.log(req, "mission.report.duplicate_terminal_reset", {
            mission_id: duplicateMission.id,
            boot_id: body.boot_id,
            report_seq: body.report_seq,
            event: body.event,
          }, duplicateMission.course_name);
        }
        return res.json({
          ok: true,
          duplicate: true,
          ...(terminalDuplicate ? { reset_mission: true, mission: duplicateMission } : {}),
        });
      }
      const { before, mission, terminal } = sequenced.value;
      const clearAcknowledged = pendingEmergencyClear?.bootId === body.boot_id
        && ["held", "mission_completed"].includes(body.event)
        && body.emergency_stop_cleared === true
        && body.motion_state === "held"
        && body.checkpoint_persisted === true
        && mission?.plan_hash === body.plan_hash;
      if (clearAcknowledged) {
        roverState.stop_requested = false;
        pendingEmergencyClear = null;
        logger.log(req, "rover.clear_emergency.acknowledged", {
          mission_id: mission.id,
          boot_id: body.boot_id,
          report_seq: body.report_seq,
        }, mission.course_name);
      }
      if (terminal) {
        logger.warn(req, "mission.report.reset", {
          mission_id: before.id,
          boot_id: body.boot_id,
          report_seq: body.report_seq,
          event: body.event,
          terminal_status: before.status,
        }, before.course_name);
        if (clearAcknowledged) broadcastRoverStatus();
        return res.json({ ok: true, reset_mission: true, mission: before });
      }
      logger.log(req, "mission.report", {
        mission_id: mission.id,
        boot_id: body.boot_id,
        report_seq: body.report_seq,
        event: body.event,
        command_id: body.command_id || null,
        command_result: body.command_result || null,
        waypoint_id: body.waypoint_id || null,
        before: before?.status || null,
        after: mission.status,
        emergency_clear_acknowledged: clearAcknowledged,
      }, mission.course_name);
      broadcastMissionMutation(mission);
      broadcastRoverStatus();
      if (mission.active_hold_id) sendSafetyHold(mission, mission.hold_reason || "rover_rebooted");
      res.json({
        ok: true,
        reset_mission: ["completed", "cancelled"].includes(mission.status),
        mission,
      });
    } catch (error) {
      if (["hold_id_mismatch", "checkpoint_not_persisted", "safety_hold_pending"].includes(error?.reason)) {
        const mission = missionV2.missionPublic(Number(body.mission_id));
        if (mission?.active_hold_id) sendSafetyHold(mission, mission.hold_reason || "rover_rebooted");
      }
      missionApiError(req, res, "mission.report", error);
    }
  });

  /* ============================================
     Operator API
     ============================================ */

  operatorApp.get("/api/rover/status", (req, res) => {
    res.json({
      ...roverState,
      device,
      ntrip_source: ntripSource,
      active_mission: missionV2.activeMission(),
      mission_protocol: missionProtocol(),
    });
  });

  operatorApp.get("/api/rover/ntrip-source", (req, res) => {
    res.json(ntripSource);
  });

  // The correction source is stored on the hub and pushed to the rover now
  // and on every (re)connect.
  operatorApp.put("/api/rover/ntrip-source", (req, res) => {
    const checked = validateNtripSource(req.body);
    if (!checked.valid) {
      logger.warn(req, "rover.ntrip_source.update", { error: checked.error }, "rover");
      return res.status(400).send(checked.error);
    }
    const next = checked.value;
    const result = dbRun(() => upsertConfig.run(NTRIP_SOURCE_KEY, JSON.stringify(next), Date.now()));
    if (!result.success) {
      logger.warn(req, "rover.ntrip_source.update", { error: result.internalError || result.error }, "rover");
      return res.status(result.status).send(result.error);
    }
    const before = ntripSource;
    ntripSource = next;
    const delivered = sendRoverEvent("ntrip-source", next);
    logger.log(req, "rover.ntrip_source.update", { before, after: next, delivered }, "rover");
    broadcastRoverStatus();
    res.json(next);
  });

  // Captures the rover's current RTK position for a cone.
  operatorApp.post("/api/rover/request", async (req, res) => {
    if (!roverClient) return rejectNoRover(req, res, "rover.request");
    if (roverPendingResolves.length >= ROVER_MAX_PENDING_REQUESTS) {
      logger.warn(req, "rover.request", { error: "queue_full", pending: roverPendingResolves.length }, "rover");
      return res.status(503).send("Too many pending position requests.");
    }

    const request_id = crypto.randomUUID();
    let removeFromQueue;
    const pending = new Promise((resolve) => {
      const entry = { request_id, resolve, createdAt: Date.now() };
      roverPendingResolves.push(entry);
      removeFromQueue = () => {
        const idx = roverPendingResolves.indexOf(entry);
        if (idx !== -1) roverPendingResolves.splice(idx, 1);
      };
    });

    if (!sendRoverEvent("request-position", { request_id })) {
      removeFromQueue();
      return rejectWriteFailed(req, res, "rover.request");
    }

    let timer;
    const position = await Promise.race([
      pending,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), POSITION_REQUEST_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    removeFromQueue();

    if (!position) {
      logger.warn(req, "rover.request", { result: "timeout" }, "rover");
      return res.status(504).send("The rover did not answer in time.");
    }
    if (position.ok === false) {
      logger.warn(req, "rover.request", { result: "capture_failed", error: position.error }, "rover");
      return res.status(422).send("Position capture failed: no stable RTK fix.");
    }
    logger.log(req, "rover.request", { lat: position.lat, lng: position.lng, alt: position.alt }, "rover");
    res.json({ ...position, source: "rover" });
  });

  operatorApp.post("/api/rover/stop", (req, res) => {
    if (!roverClient) return rejectNoRover(req, res, "rover.stop");
    if (!sendRoverEvent("emergency-stop", {})) return rejectWriteFailed(req, res, "rover.stop");
    // Latch the stop now instead of waiting up to ~3s for telemetry, so a
    // start/resume racing the stop cannot slip through. The E-stop stays
    // latched until cleared; the next telemetry reports the real state.
    roverState.stop_requested = true;
    pendingEmergencyClear = null;
    roverState.nav_state = "EMERGENCY_STOP";
    broadcastRoverStatus();
    logger.log(req, "rover.stop", null, "rover");
    res.json({ stopped: true });
  });

  operatorApp.post("/api/rover/clear-emergency", (req, res) => {
    if (!roverClient) return rejectNoRover(req, res, "rover.clear_emergency");
    if (!sendRoverEvent("clear-emergency", {})) return rejectWriteFailed(req, res, "rover.clear_emergency");
    pendingEmergencyClear = roverProtocolVersion === MISSION_PROTOCOL_VERSION
      ? { bootId: roverBootId }
      : null;
    logger.log(req, "rover.clear_emergency", null, "rover");
    res.json({ cleared: true });
  });

  // One-point battery gain calibration: the operator enters the voltage read
  // on a multimeter and the rover stores gain = measured / raw.
  operatorApp.post("/api/rover/calibrate-battery", (req, res) => {
    const measured_v = Number(req.body?.measured_v);
    if (!Number.isFinite(measured_v) || measured_v < 15 || measured_v > 32) {
      return res.status(400).send("measured_v must be a number from 15 to 32 V.");
    }
    if (!roverClient) return rejectNoRover(req, res, "rover.calibrate_battery", { measured_v });
    if (!sendRoverEvent("calibrate-battery", { measured_v })) {
      return rejectWriteFailed(req, res, "rover.calibrate_battery", { measured_v });
    }
    logger.log(req, "rover.calibrate_battery", { measured_v }, "rover");
    res.json({ ok: true, measured_v });
  });

  function rejectNotIdle(req, res, action) {
    if (!roverState.nav_state || roverState.nav_state === "IDLE") return false;
    logger.warn(req, action, { error: "not_idle", nav_state: roverState.nav_state }, "rover");
    res.status(409).send(`The rover is not IDLE (now ${roverState.nav_state}). End the mission first.`);
    return true;
  }

  // Antenna-offset calibration drive. The result comes back through
  // /api/rover/antenna_calibration_result.
  operatorApp.post("/api/rover/calibrate-antenna", (req, res) => {
    if (!roverClient) return rejectNoRover(req, res, "rover.calibrate_antenna");
    if (rejectNotIdle(req, res, "rover.calibrate_antenna")) return;
    if (!sendRoverEvent("calibrate-antenna", {})) return rejectWriteFailed(req, res, "rover.calibrate_antenna");
    logger.log(req, "rover.calibrate_antenna", null, "rover");
    res.json({ ok: true });
  });

  // Antenna offset measured by hand; stored by the rover with source=manual.
  operatorApp.post("/api/rover/set-antenna-offset", (req, res) => {
    const body = req.body || {};
    const a_x = typeof body.a_x === "number" ? body.a_x : null;
    const a_y = typeof body.a_y === "number" ? body.a_y : null;
    if (a_x === null || a_y === null) {
      return res.status(400).send("a_x and a_y must be numbers.");
    }
    if (a_x < 0.05 || a_x > 1.0 || Math.abs(a_y) > 1.0) {
      return res.status(400).send("a_x must be 0.05 to 1 m and a_y within ±1 m.");
    }
    if (!roverClient) return rejectNoRover(req, res, "rover.set_antenna_offset", { a_x, a_y });
    if (!sendRoverEvent("set-antenna-offset", { a_x, a_y })) {
      return rejectWriteFailed(req, res, "rover.set_antenna_offset", { a_x, a_y });
    }
    logger.log(req, "rover.set_antenna_offset", { a_x, a_y }, "rover");
    res.json({ ok: true, a_x, a_y });
  });

  // Wheel-scale (and steering-trim) calibration drive. The result comes back
  // through /api/rover/wheel_calibration_result.
  operatorApp.post("/api/rover/calibrate-wheels", (req, res) => {
    if (!roverClient) return rejectNoRover(req, res, "rover.calibrate_wheels");
    if (rejectNotIdle(req, res, "rover.calibrate_wheels")) return;
    if (!sendRoverEvent("calibrate-wheels", {})) return rejectWriteFailed(req, res, "rover.calibrate_wheels");
    logger.log(req, "rover.calibrate_wheels", null, "rover");
    res.json({ ok: true });
  });

  // Resets wheel scales and the accumulated steering trim to defaults.
  operatorApp.post("/api/rover/reset-wheel-cal", (req, res) => {
    if (!roverClient) return rejectNoRover(req, res, "rover.reset_wheel_cal");
    if (rejectNotIdle(req, res, "rover.reset_wheel_cal")) return;
    if (!sendRoverEvent("reset-wheel-cal", {})) return rejectWriteFailed(req, res, "rover.reset_wheel_cal");
    roverState.wheel_calibration = null;
    broadcastRoverStatus();
    logger.log(req, "rover.reset_wheel_cal", null, "rover");
    res.json({ ok: true });
  });

  operatorApp.post("/api/rover/pump", (req, res) => {
    const on = req.body?.on;
    if (typeof on !== "boolean") return res.status(400).send("on must be a boolean.");
    if (!roverClient) return rejectNoRover(req, res, "rover.pump", { on });
    if (!sendRoverEvent("pump-set", { on })) return rejectWriteFailed(req, res, "rover.pump", { on });
    roverState.pump_on = on;
    logger.log(req, "rover.pump", { on }, "rover");
    broadcastRoverStatus();
    res.json({ on });
  });

  // Stored even while the rover is offline; re-sent on (re)connect.
  operatorApp.post("/api/rover/pump-duration", (req, res) => {
    const seconds = Number(req.body?.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10) {
      logger.warn(req, "rover.pump_duration", { error: "invalid_seconds", seconds: req.body?.seconds }, "rover");
      return res.status(400).send("seconds must be greater than 0 and at most 10.");
    }
    roverState.pump_run_duration = seconds;
    if (roverClient) sendRoverEvent("pump-duration", { seconds });
    logger.log(req, "rover.pump_duration", { seconds, connected: !!roverClient }, "rover");
    broadcastRoverStatus();
    res.json({ ok: true });
  });

  let lastControlAt = 0;
  let lastControlActor = null;
  const controlWarnState = new Map(); // operator + reason → { at, suppressed }
  function warnControlThrottled(req, actorKey, reason, detail, now) {
    const key = `${actorKey || "anonymous"}:${reason}`;
    const state = controlWarnState.get(key);
    if (state && now - state.at < CONTROL_WARN_INTERVAL_MS) {
      state.suppressed += 1;
      return;
    }
    logger.warn(req, "rover.control", {
      ...detail,
      ...(state?.suppressed ? { suppressed: state.suppressed } : {}),
    }, "rover");
    controlWarnState.set(key, { at: now, suppressed: 0 });
  }

  operatorApp.post("/api/rover/control", (req, res) => {
    const { throttle, steering } = req.body || {};
    if (typeof throttle !== "number" || typeof steering !== "number" || !Number.isFinite(throttle) || !Number.isFinite(steering)) {
      return res.status(400).send("Invalid control input.");
    }
    const t = Math.max(-100, Math.min(100, throttle));
    const s = Math.max(-100, Math.min(100, steering));
    const actorKey = req.actor?.login || req.actor?.label || null;
    const now = Date.now();
    // Manual authority needs only the mutation-maintained bounded summary,
    // never the full waypoint plan.
    const activeMission = missionV2.activeMissionSummary();
    if ((t !== 0 || s !== 0) && activeMission && !activeMission.motion_confirmed_held) {
      warnControlThrottled(req, actorKey, "autonomous_mission_not_held", {
        error: "autonomous_mission_not_held",
        mission_id: activeMission.id,
        mission_status: activeMission.status,
        throttle: t,
        steering: s,
      }, now);
      return res.status(409).send("Pause the autonomous mission before manual control.");
    }
    if (!roverClient) {
      warnControlThrottled(req, actorKey, "not_connected", {
        error: "not_connected", throttle: t, steering: s,
      }, now);
      return res.status(503).send("The rover is not connected.");
    }
    if (!sendRoverEvent("manual-control", { throttle: t, steering: s })) {
      return rejectWriteFailed(req, res, "rover.control");
    }
    // One audit line per driving session.
    if (now - lastControlAt > CONTROL_SESSION_GAP_MS || actorKey !== lastControlActor) {
      logger.log(req, "rover.control", {}, "rover");
    }
    lastControlAt = now;
    lastControlActor = actorKey;
    res.json({ throttle: t, steering: s });
  });

  // Stored even while the rover is offline; re-sent on (re)connect.
  operatorApp.post("/api/rover/nav-lights", (req, res) => {
    const mode = Number(req.body?.mode);
    if (!Number.isInteger(mode) || mode < 0 || mode > 4) {
      logger.warn(req, "rover.nav_lights", { error: "invalid_mode", mode: req.body?.mode }, "rover");
      return res.status(400).send("mode must be an integer from 0 to 4.");
    }
    roverState.nav_lights_mode = mode;
    if (roverClient) sendRoverEvent("nav-lights", { mode });
    logger.log(req, "rover.nav_lights", { mode, connected: !!roverClient }, "rover");
    broadcastRoverStatus();
    res.json({ ok: true });
  });

  // Stored even while the rover is offline; re-sent on (re)connect.
  operatorApp.post("/api/rover/led-brightness", (req, res) => {
    const brightness = Number(req.body?.brightness);
    if (!Number.isInteger(brightness) || brightness < 0 || brightness > 255) {
      logger.warn(req, "rover.led_brightness", { error: "invalid_brightness", brightness: req.body?.brightness }, "rover");
      return res.status(400).send("brightness must be an integer from 0 to 255.");
    }
    roverState.led_brightness = brightness;
    if (roverClient) sendRoverEvent("led-brightness", { brightness });
    logger.log(req, "rover.led_brightness", { brightness, connected: !!roverClient }, "rover");
    broadcastRoverStatus();
    res.json({ ok: true });
  });

  operatorApp.get("/api/rover/logs", (req, res) => {
    res.json(roverLogCache);
  });

  // Asks the rover to upload its log buffer.
  operatorApp.post("/api/rover/logs/fetch", (req, res) => {
    if (!roverClient) return rejectNoRover(req, res, "rover.logs.fetch");
    if (!sendRoverEvent("fetch-logs", {})) return rejectWriteFailed(req, res, "rover.logs.fetch");
    logger.log(req, "rover.logs.fetch", null, "rover");
    res.json({ ok: true });
  });

  /* ── Durable mission protocol v2 ───────────────────── */

  function missionApiError(req, res, action, error, subject = "rover") {
    const known = Number.isInteger(error?.status);
    const status = known ? error.status : 500;
    logger.warn(req, action, {
      error: error?.message || String(error),
      reason: error?.reason || null,
      ...(typeof req.body?.expected_plan_hash === "string"
        ? { expected_plan_hash: req.body.expected_plan_hash } : {}),
      ...(typeof req.body?.expected_occurrence_revision === "string"
        ? { expected_occurrence_revision: req.body.expected_occurrence_revision } : {}),
      ...(error?.current_plan_hash ? { current_plan_hash: error.current_plan_hash } : {}),
      ...(error?.current_occurrence_revision ? { current_occurrence_revision: error.current_occurrence_revision } : {}),
      ...(Number.isInteger(error?.position) ? { position: error.position } : {}),
      ...(Number.isInteger(error?.cone_id) ? { cone_id: error.cone_id } : {}),
    }, subject);
    // Unexpected errors (SQLite and the like) stay in the log.
    const message = known && error.message ? error.message : "The mission request failed.";
    if (typeof error?.reason === "string" && error.reason) {
      return res.status(status).json({
        message,
        reason: error.reason,
        ...(error.current_plan_hash ? { current_plan_hash: error.current_plan_hash } : {}),
        ...(error.current_occurrence_revision
          ? { current_occurrence_revision: error.current_occurrence_revision } : {}),
        ...(Number.isInteger(error.position) ? { position: error.position } : {}),
        ...(Number.isInteger(error.cone_id) ? { cone_id: error.cone_id } : {}),
      });
    }
    return res.status(status).send(message);
  }

  const actorLabel = (req) => req.actor?.label ?? null;

  function validateV2MissionDistances(waypoints, returnPoint = null) {
    if (!Array.isArray(waypoints)) return { valid: true };
    const drivePoints = waypoints.length > 0 ? waypoints : (returnPoint ? [returnPoint] : []);
    if (drivePoints.length === 0) return { valid: true };
    if (lastRoverPosition && Date.now() - lastRoverPosition.at < ROVER_POSITION_STALE_MS) {
      const first = haversine(lastRoverPosition, drivePoints[0]);
      if (first > MAX_WAYPOINT_DIST_M) {
        return { valid: false, reason: "first_waypoint_far", distance: first, index: 0 };
      }
    }
    for (let i = 1; i < drivePoints.length; i += 1) {
      const distance = haversine(drivePoints[i - 1], drivePoints[i]);
      // Zero-distance legs are intentional repeated visits to the same cone.
      if (distance > MAX_SEGMENT_DIST_M) {
        return { valid: false, reason: "segment_too_long", distance, index: i };
      }
    }
    if (returnPoint && waypoints.length > 0) {
      const distance = haversine(waypoints[waypoints.length - 1], returnPoint);
      if (distance > MAX_SEGMENT_DIST_M) {
        return { valid: false, reason: "return_segment_too_long", distance, index: waypoints.length };
      }
    }
    return { valid: true };
  }

  function distanceMessage(check) {
    const meters = check.distance.toFixed(1);
    if (check.reason === "first_waypoint_far") {
      return `The first waypoint is ${meters} m from the rover (max ${MAX_WAYPOINT_DIST_M} m).`;
    }
    if (check.reason === "return_segment_too_long") {
      return `The return from the last waypoint to the mission start is ${meters} m (max ${MAX_SEGMENT_DIST_M} m).`;
    }
    return `The leg to waypoint ${check.index + 1} is ${meters} m (max ${MAX_SEGMENT_DIST_M} m).`;
  }

  operatorApp.get("/api/missions/active", (req, res) => {
    try {
      res.json({ mission: missionV2.activeMission() });
    } catch (error) {
      missionApiError(req, res, "mission.v2.active", error);
    }
  });

  // The browser sends the course identity and the authoritative cone geometry;
  // the hub has no course data of its own.
  operatorApp.post("/api/missions", (req, res) => {
    const body = req.body || {};
    try {
      const mission = missionV2.createMission({
        course: body.course,
        presetId: body.preset_id ?? null,
        finishBehavior: body.finish_behavior ?? "stop",
        items: body.items,
        actor: actorLabel(req),
      });
      logger.log(req, "mission.v2.create", {
        mission_id: mission.id,
        course_id: mission.course_id,
        preset_id: mission.preset_id,
        plan_hash: mission.plan_hash,
        finish_behavior: mission.finish_behavior,
        waypoint_count: mission.waypoints.length,
      }, mission.course_name);
      broadcastMissionMutation(mission);
      broadcastRoverStatus();
      res.status(201).json(mission);
    } catch (error) {
      missionApiError(req, res, "mission.v2.create", error);
    }
  });

  operatorApp.put("/api/missions/:id/remaining", (req, res) => {
    const missionId = Number(req.params.id);
    if (!Number.isInteger(missionId)) return res.status(400).send("Invalid mission ID.");
    const body = req.body || {};
    try {
      const before = missionV2.missionPublic(missionId);
      const after = missionV2.editRemaining({
        missionId,
        expectedPlanHash: body.expected_plan_hash,
        expectedOccurrenceRevision: body.expected_occurrence_revision,
        finishBehavior: body.finish_behavior,
        items: body.items,
        actor: actorLabel(req),
      });
      logger.log(req, "mission.v2.remaining.update", {
        mission_id: missionId,
        before: {
          plan_hash: before.plan_hash,
          occurrence_revision: before.occurrence_revision,
          pending: before.waypoints.filter((w) => w.state === "pending").length,
          finish_behavior: before.finish_behavior,
        },
        after: {
          plan_hash: after.plan_hash,
          occurrence_revision: after.occurrence_revision,
          pending: after.waypoints.filter((w) => w.state === "pending").length,
          finish_behavior: after.finish_behavior,
          empty_plan_mode: after.empty_plan_mode,
        },
      }, after.course_name);
      broadcastMissionMutation(after);
      broadcastRoverStatus();
      res.json(after);
    } catch (error) {
      missionApiError(req, res, "mission.v2.remaining.update", error);
    }
  });

  function issueMissionCommand(action) {
    return (req, res) => {
      const missionId = Number(req.params.id);
      if (!Number.isInteger(missionId)) return res.status(400).send("Invalid mission ID.");
      const body = req.body || {};
      const movementCommand = action !== "end";
      if (movementCommand && (!roverClient || roverProtocolVersion !== MISSION_PROTOCOL_VERSION || !roverBootId)) {
        logger.warn(req, `mission.v2.${action}`, {
          error: "incompatible_or_disconnected_rover",
          connected: !!roverClient,
          announced_protocol: roverProtocolVersion,
          required_protocol: MISSION_PROTOCOL_VERSION,
        }, "rover");
        return res.status(409).send("No mission protocol v2 rover is connected.");
      }
      if ((action === "start" || action === "resume")
          && (roverState.nav_state === "EMERGENCY_STOP" || roverState.stop_requested)) {
        logger.warn(req, `mission.v2.${action}`, { error: "in_emergency_stop", mission_id: missionId }, "rover");
        return res.status(409).send("The rover is in emergency stop. Clear it first.");
      }
      try {
        const mission = missionV2.missionPublic(missionId);
        if (!mission) throw Object.assign(new Error("Mission not found."), { status: 404 });
        if (action === "start" || action === "resume") {
          if (typeof body.expected_plan_hash !== "string"
              || body.expected_plan_hash !== mission.plan_hash) {
            throw Object.assign(new Error("The mission route changed. Retry with the latest mission."), {
              status: 409,
              reason: "plan_hash_mismatch",
              current_plan_hash: mission.plan_hash,
            });
          }
          // A same-action retry while a command is pending carries the revision
          // captured before the transition; issueCommand validates it against
          // the durable envelope. Fresh commands must match the current
          // occurrence before distance checks or any persistence.
          if (!mission.active_command_id
              && (typeof body.expected_occurrence_revision !== "string"
                || body.expected_occurrence_revision !== mission.occurrence_revision)) {
            throw Object.assign(new Error("The mission progress changed. Reload the latest mission."), {
              status: 409,
              reason: "occurrence_revision_mismatch",
              current_occurrence_revision: mission.occurrence_revision,
            });
          }
          const pending = mission.waypoints.filter((wp) => wp.state === "pending" || wp.state === "active");
          const freshRoverPosition = lastRoverPosition
            && Date.now() - lastRoverPosition.at < ROVER_POSITION_STALE_MS
            ? lastRoverPosition : null;
          const returnPoint = mission.finish_behavior === "return_to_start"
            ? (mission.start_position || freshRoverPosition) : null;
          const distance = validateV2MissionDistances(pending, returnPoint);
          if (!distance.valid && body.force !== true) {
            throw Object.assign(new Error(distanceMessage(distance)), { status: 400, reason: distance.reason });
          }
          if (!distance.valid) logger.warn(req, `mission.v2.${action}.force`, { mission_id: missionId, ...distance }, "rover");
        }
        const issued = missionV2.issueCommand({
          missionId,
          action,
          expectedPlanHash: body.expected_plan_hash,
          expectedOccurrenceRevision: body.expected_occurrence_revision,
          actor: actorLabel(req),
          force: body.force === true,
          targetBootId: roverBootId,
        });
        let delivered = false;
        const deliveryAttempted = !!roverClient
          && roverProtocolVersion === MISSION_PROTOCOL_VERSION;
        if (deliveryAttempted) {
          let payload = null;
          try { payload = JSON.parse(issued.command.payload_json); } catch { /* impossible for a freshly issued command */ }
          if (payload) delivered = sendRoverEvent("mission-command", payload);
        }
        let effectiveMission = issued.mission;
        if (deliveryAttempted && !delivered) {
          effectiveMission = missionV2.markCommandDeliveryFailed(
            missionId, issued.command.id, roverBootId,
          ) || issued.mission;
          logger.warn(req, `mission.v2.${action}.delivery`, {
            error: "sse_write_failed",
            mission_id: missionId,
            command_id: issued.command.id,
            command_seq: issued.command.command_seq,
            boot_id: roverBootId,
          }, issued.mission.course_name);
        }
        logger.log(req, `mission.v2.${action}`, {
          mission_id: missionId,
          command_id: issued.command.id,
          command_seq: issued.command.command_seq,
          plan_hash: effectiveMission.plan_hash,
          delivered,
          replay: issued.replay,
          before: mission.status,
          after: effectiveMission.status,
        }, effectiveMission.course_name);
        broadcastMissionMutation(effectiveMission);
        broadcastRoverStatus();
        res.status(202).json({
          command_id: issued.command.id,
          command_seq: issued.command.command_seq,
          delivered,
          replay: issued.replay,
          mission: effectiveMission,
        });
      } catch (error) {
        missionApiError(req, res, `mission.v2.${action}`, error);
      }
    };
  }

  operatorApp.post("/api/missions/:id/start", issueMissionCommand("start"));
  operatorApp.post("/api/missions/:id/pause", issueMissionCommand("pause"));
  operatorApp.post("/api/missions/:id/resume", issueMissionCommand("resume"));
  operatorApp.post("/api/missions/:id/end", issueMissionCommand("end"));

  /* ── Mission history ───────────────────────────────── */

  const selectMissions = db.prepare(
    `SELECT m.id, m.course_id, m.course_name, COALESCE(m.activated_at, m.created_at) AS started_at,
            m.ended_at, m.lifecycle_state AS status, m.actor,
            (SELECT COUNT(*) FROM mission_telemetry t WHERE t.mission_id = m.id) AS sample_count
     FROM mission m
     ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
  );
  const countMissions = db.prepare("SELECT COUNT(*) AS cnt FROM mission");
  const selectMissionTelemetry = db.prepare(
    `SELECT t, lat, lng, fix_status, nav_state, ntrip_connected, corr_age_ms, ntrip_fail_count, h_acc_m, altitude_m, v_acc_m
     FROM mission_telemetry WHERE mission_id = ? ORDER BY t, id`,
  );

  operatorApp.get("/api/missions", (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || MISSION_LIST_DEFAULT_LIMIT, MISSION_LIST_MAX_LIMIT));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = selectMissions.all(limit, offset);
    const total = countMissions.get().cnt;
    res.json({ missions: rows, total, limit, offset });
  });

  operatorApp.get("/api/missions/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).send("Invalid mission ID.");
    const mission = missionV2.missionPublic(id, { events: true });
    if (!mission) return res.status(404).send("Mission not found.");
    res.json(mission);
  });

  operatorApp.get("/api/missions/:id/telemetry", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).send("Invalid mission ID.");
    if (!missionV2.missionRow(id)) return res.status(404).send("Mission not found.");
    res.json({ samples: selectMissionTelemetry.all(id) });
  });

  // Ends the rover stream and stops the watchdog. Mission state is left as is:
  // the rover keeps driving and the next hub process resumes the same ledger.
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(deviceLivenessWatchdog);
    for (const heartbeat of streamHeartbeats) clearInterval(heartbeat);
    streamHeartbeats.clear();
    const client = roverClient;
    roverClient = null;
    if (client) {
      try { client.end(); } catch { /* already closed */ }
    }
  }

  return { statusSnapshot, close };
}
