import crypto from "node:crypto";
import { CONE_SIDES, validateAltitude, validateCoordinate } from "./validation.mjs";

export const MISSION_PROTOCOL_VERSION = 2;
export const MISSION_MAX_OCCURRENCES = 1000;
export const ACTIVE_MISSION_STATES = [
  "ready", "starting", "running", "pausing", "paused", "interrupted", "resuming",
];

const TERMINAL_MISSION_STATES = new Set(["completed", "cancelled"]);
const COMMAND_ACTIONS = new Set(["start", "pause", "resume", "end"]);
const FINISH_BEHAVIORS = new Set(["stop", "return_to_start"]);
const ROVER_CONFIRMED_HOLD_PREFIX = "rover_confirmed:";
const NETWORK_RECONCILE_REASONS = new Set([
  "sse_disconnect", "telemetry_stale", "command_delivery_failed",
]);
const REPORT_EVENTS = new Set([
  "command", "state", "waypoint_active", "waypoint_completed",
  "waypoint_failed", "held", "interrupted", "mission_completed",
]);
const COURSE_NAME_MAX_LENGTH = 100;
const MAX_OCCURRENCES_LABEL = MISSION_MAX_OCCURRENCES.toLocaleString("en-US");

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

// Coarse value of the mission.status column for a lifecycle state.
function coarseStatus(lifecycleState) {
  if (lifecycleState === "running") return "running";
  if (lifecycleState === "interrupted") return "interrupted";
  if (["ready", "starting", "pausing", "paused", "resuming"].includes(lifecycleState)) return "paused";
  if (lifecycleState === "completed") return "completed";
  return "stopped";
}

function canonicalPlan(finishBehavior, waypoints) {
  return JSON.stringify({
    finish_behavior: finishBehavior,
    waypoints: waypoints.map((w) => ({
      id: w.id,
      cone_id: w.cone_id ?? null,
      lat: Number(w.lat),
      lng: Number(w.lng),
      alt: Number.isFinite(w.alt) ? Number(w.alt) : null,
      side: w.side || null,
    })),
  });
}

export function missionPlanHash(finishBehavior, waypoints) {
  return crypto.createHash("sha256").update(canonicalPlan(finishBehavior, waypoints)).digest("hex");
}

function opaqueRevision(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function occurrenceRevision(mission, waypoints) {
  return opaqueRevision({
    plan_hash: mission.plan_hash,
    lifecycle_state: mission.lifecycle_state,
    hold_reason: mission.hold_reason,
    active_command_id: mission.active_command_id,
    active_hold_id: mission.active_hold_id,
    empty_plan_mode: mission.empty_plan_mode,
    waypoints: waypoints.map((waypoint) => ({
      id: waypoint.id,
      position: waypoint.position,
      state: waypoint.state,
      outcome: waypoint.outcome,
      skipped_at: waypoint.skipped_at,
      skip_reason: waypoint.skip_reason,
    })),
  });
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicWaypoint(row) {
  return {
    id: row.id,
    position: row.position,
    cone_id: row.cone_id,
    lat: row.lat,
    lng: row.lng,
    alt: row.alt,
    side: row.side,
    state: row.state,
    outcome: row.outcome,
    attempt_count: row.attempt_count,
    completed_at: row.completed_at,
    skipped_at: row.skipped_at,
    skip_reason: row.skip_reason,
  };
}

// The course the operator built the mission from. The hub keeps its id and
// name only; the course itself lives with the browser's course host.
function validateCourse(course) {
  if (!course || typeof course !== "object" || Array.isArray(course)) {
    throw httpError(400, "course must be an object with id and name.", { reason: "invalid_course" });
  }
  if (!Number.isSafeInteger(course.id)) {
    throw httpError(400, "course.id must be an integer.", { reason: "invalid_course" });
  }
  const name = typeof course.name === "string" ? course.name.trim() : "";
  if (!name || name.length > COURSE_NAME_MAX_LENGTH) {
    throw httpError(400, `course.name must be 1-${COURSE_NAME_MAX_LENGTH} characters.`, { reason: "invalid_course" });
  }
  return { id: course.id, name };
}

function invalidItem(position, message, coneId = null) {
  return httpError(400, `Waypoint ${position + 1}: ${message}`, {
    reason: "invalid_item",
    position,
    ...(Number.isSafeInteger(coneId) ? { cone_id: coneId } : {}),
  });
}

// A route item is authoritative geometry supplied by the browser: the cone it
// came from (or null for a free point), its position, and its side.
export function validateMissionItem(item, position) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw invalidItem(position, "Invalid item.");
  }
  const coneId = item.cone_id ?? null;
  if (coneId !== null && !Number.isSafeInteger(coneId)) {
    throw invalidItem(position, "cone_id must be an integer or null.");
  }
  const coordinate = validateCoordinate(item.lat, item.lng);
  if (!coordinate.valid) throw invalidItem(position, coordinate.error, coneId);
  const altitude = validateAltitude(item.alt);
  if (!altitude.valid) throw invalidItem(position, altitude.error, coneId);
  if (!CONE_SIDES.has(item.side)) {
    throw invalidItem(position, "side must be left, right, or center.", coneId);
  }
  return { cone_id: coneId, lat: item.lat, lng: item.lng, alt: altitude.value, side: item.side };
}

export function createMissionV2Store(db) {
  let activeSummaryHydrated = false;
  let activeSummaryCache = null;
  const insertEvent = db.prepare(`INSERT INTO mission_event
    (mission_id, event_type, t, waypoint_id, command_id, rover_boot_id, actor,
     before_json, after_json, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function recordEvent(missionId, eventType, {
    waypointId = null, commandId = null, roverBootId = null, actor = null,
    before = null, after = null, detail = null, t = Date.now(),
  } = {}) {
    insertEvent.run(
      missionId, eventType, t, waypointId, commandId, roverBootId, actor,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      detail == null ? null : JSON.stringify(detail),
    );
  }

  function waypointRows(missionId, { includeSkipped = false } = {}) {
    return db.prepare(`SELECT * FROM mission_waypoint WHERE mission_id=?
      ${includeSkipped ? "" : "AND state <> 'skipped'"}
      ORDER BY CASE WHEN position IS NULL THEN 1 ELSE 0 END, position, created_at, id`).all(missionId);
  }

  function pendingWaypoints(missionId) {
    return db.prepare(`SELECT * FROM mission_waypoint
      WHERE mission_id=? AND state IN ('pending','active') ORDER BY position, created_at, id`).all(missionId);
  }

  function missionRow(id) {
    return db.prepare("SELECT * FROM mission WHERE id=?").get(id);
  }

  function motionConfirmedHeld(missionOrId) {
    const row = typeof missionOrId === "object" && missionOrId != null
      ? missionOrId : missionRow(missionOrId);
    if (!row) return false;
    if (row.active_hold_id) return false;
    const state = row.lifecycle_state;
    if (state === "ready" || state === "paused") return true;
    return state === "interrupted"
      && typeof row.hold_reason === "string"
      && row.hold_reason.startsWith(ROVER_CONFIRMED_HOLD_PREFIX);
  }

  function publicHoldReason(reason) {
    return typeof reason === "string" && reason.startsWith(ROVER_CONFIRMED_HOLD_PREFIX)
      ? reason.slice(ROVER_CONFIRMED_HOLD_PREFIX.length) : reason;
  }

  function missionPublic(id, { events = false } = {}) {
    const row = missionRow(id);
    if (!row) return null;
    const waypoints = waypointRows(id);
    const skippedWaypointCount = db.prepare(`SELECT COUNT(*) AS count FROM mission_waypoint
      WHERE mission_id=? AND state='skipped'`).get(id).count;
    const result = {
      id: row.id,
      course_id: row.course_id,
      course_name: row.course_name,
      preset_id: row.preset_id,
      created_at: row.created_at,
      started_at: row.activated_at ?? row.created_at,
      ended_at: row.ended_at,
      status: row.lifecycle_state,
      hold_reason: publicHoldReason(row.hold_reason),
      motion_confirmed_held: motionConfirmedHeld(row),
      finish_behavior: row.finish_behavior,
      plan_hash: row.plan_hash,
      start_position: row.start_lat == null ? null : {
        lat: row.start_lat, lng: row.start_lng, alt: row.start_alt,
      },
      actor: row.actor,
      protocol_version: row.protocol_version,
      active_command_id: row.active_command_id,
      active_hold_id: row.active_hold_id,
      empty_plan_mode: row.empty_plan_mode,
      occurrence_revision: occurrenceRevision(row, waypoints),
      waypoints: waypoints.map(publicWaypoint),
      skipped_waypoint_count: skippedWaypointCount,
    };
    if (ACTIVE_MISSION_STATES.includes(result.status)) {
      activeSummaryHydrated = true;
      activeSummaryCache = missionSummary(result);
    } else if (activeSummaryCache?.id === result.id) {
      activeSummaryHydrated = true;
      activeSummaryCache = null;
    }
    if (events) {
      result.events = db.prepare(`SELECT * FROM mission_event WHERE mission_id=? ORDER BY t,id`).all(id)
        .map((event) => ({
          ...event,
          before: parseJson(event.before_json, null),
          after: parseJson(event.after_json, null),
          detail: parseJson(event.detail_json, null),
          before_json: undefined,
          after_json: undefined,
          detail_json: undefined,
        }));
    }
    return result;
  }

  function activeMission() {
    const row = db.prepare(`SELECT id FROM mission WHERE lifecycle_state IN
      ('ready','starting','running','pausing','paused','interrupted','resuming')
      ORDER BY id DESC LIMIT 1`).get();
    if (row) return missionPublic(row.id);
    activeSummaryHydrated = true;
    activeSummaryCache = null;
    return null;
  }

  function missionSummary(mission) {
    if (!mission) return null;
    return {
      id: mission.id,
      status: mission.status,
      motion_confirmed_held: mission.motion_confirmed_held,
      course_id: mission.course_id,
      course_name: mission.course_name,
      plan_hash: mission.plan_hash,
      occurrence_revision: mission.occurrence_revision,
      active_command_id: mission.active_command_id,
      active_hold_id: mission.active_hold_id,
      hold_reason: mission.hold_reason,
      finish_behavior: mission.finish_behavior,
      empty_plan_mode: mission.empty_plan_mode,
      protocol_version: mission.protocol_version,
    };
  }

  function activeMissionSummary() {
    if (!activeSummaryHydrated) activeMission();
    return activeSummaryCache == null ? null : { ...activeSummaryCache };
  }

  function rehydrateActiveSummaryCache() {
    activeSummaryHydrated = false;
    activeSummaryCache = null;
    activeMission();
  }

  function createMission({
    course,
    presetId = null,
    finishBehavior = "stop",
    items,
    actor = null,
  }) {
    if (!FINISH_BEHAVIORS.has(finishBehavior)) {
      throw httpError(400, "Invalid finish behavior.");
    }
    const missionCourse = validateCourse(course);
    if (presetId != null && !Number.isSafeInteger(presetId)) {
      throw httpError(400, "preset_id must be an integer.", { reason: "invalid_preset_id" });
    }
    if (!Array.isArray(items) || items.length === 0 || items.length > MISSION_MAX_OCCURRENCES) {
      throw httpError(400, `A mission needs 1 to ${MAX_OCCURRENCES_LABEL} waypoints.`);
    }
    const geometry = items.map((item, position) => validateMissionItem(item, position));
    if (activeMission()) {
      throw httpError(409, "Another mission is still active.", { reason: "active_mission" });
    }
    const now = Date.now();
    const waypoints = geometry.map((item, position) => ({ id: crypto.randomUUID(), position, ...item }));
    const planHash = missionPlanHash(finishBehavior, waypoints);
    const missionId = db.transaction(() => {
      const result = db.prepare(`INSERT INTO mission
        (course_id,course_name,preset_id,created_at,updated_at,lifecycle_state,status,
         finish_behavior,plan_hash,protocol_version,actor)
        VALUES (?,?,?,?,?,'ready',?,?,?,?,?)`)
        .run(
          missionCourse.id, missionCourse.name, presetId ?? null, now, now, coarseStatus("ready"),
          finishBehavior, planHash, MISSION_PROTOCOL_VERSION, actor,
        );
      const id = Number(result.lastInsertRowid);
      const insert = db.prepare(`INSERT INTO mission_waypoint
        (id,mission_id,position,cone_id,lat,lng,alt,side,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`);
      for (const wp of waypoints) insert.run(
        wp.id, id, wp.position, wp.cone_id, wp.lat, wp.lng, wp.alt, wp.side, now, now,
      );
      recordEvent(id, "mission.created", {
        actor,
        after: {
          course_id: missionCourse.id,
          course_name: missionCourse.name,
          preset_id: presetId ?? null,
          finish_behavior: finishBehavior,
          plan_hash: planHash,
          waypoint_count: waypoints.length,
        },
      });
      return id;
    })();
    return missionPublic(missionId);
  }

  function editRemaining({
    missionId, expectedPlanHash, expectedOccurrenceRevision,
    finishBehavior, items, actor = null,
  }) {
    const mission = missionRow(missionId);
    if (!mission) throw httpError(404, "Mission not found.");
    if (!motionConfirmedHeld(mission)) {
      throw httpError(409, "The remaining route can be edited only after the rover confirms it is stopped.", {
        reason: "motion_not_confirmed_held",
      });
    }
    if (mission.active_command_id) {
      throw httpError(409, "A rover command is still pending.");
    }
    const before = missionPublic(missionId);
    if (typeof expectedOccurrenceRevision !== "string"
        || expectedOccurrenceRevision !== before.occurrence_revision) {
      throw httpError(409, "The mission progress changed. Reload the latest mission.", {
        reason: "occurrence_revision_mismatch",
        current_occurrence_revision: before.occurrence_revision,
      });
    }
    if (expectedPlanHash !== mission.plan_hash) {
      throw httpError(409, "Another operator changed the route. Reload the latest mission.", {
        reason: "plan_hash_mismatch", current_plan_hash: mission.plan_hash,
      });
    }
    const nextFinish = finishBehavior ?? mission.finish_behavior;
    if (!FINISH_BEHAVIORS.has(nextFinish)) {
      throw httpError(400, "Invalid finish behavior.");
    }
    if (!Array.isArray(items) || items.length > MISSION_MAX_OCCURRENCES) {
      throw httpError(400, "Invalid remaining route.");
    }
    const currentPending = pendingWaypoints(missionId);
    const pendingById = new Map(currentPending.map((w) => [w.id, w]));
    const used = new Set();
    const nextPending = items.map((item, position) => {
      if (item?.waypoint_id) {
        const existing = pendingById.get(item.waypoint_id);
        if (!existing || used.has(existing.id)) {
          throw httpError(409, `Remaining waypoint ${position + 1} is not a pending waypoint of this mission.`);
        }
        used.add(existing.id);
        return existing;
      }
      return {
        id: crypto.randomUUID(), mission_id: missionId, ...validateMissionItem(item, position),
        state: "pending", attempt_count: 0,
      };
    });
    const completedCount = before.waypoints.filter((waypoint) => waypoint.state === "completed").length;
    if (completedCount + nextPending.length > MISSION_MAX_OCCURRENCES) {
      throw httpError(409, `Completed and remaining waypoints cannot exceed ${MAX_OCCURRENCES_LABEL} in total.`, {
        reason: "mission_occurrence_limit",
      });
    }
    let emptyPlanMode = null;
    if (nextPending.length === 0) {
      const removedOnlyUncertain = currentPending.length > 0
        && currentPending.every((row) =>
          row.outcome === "dispense_outcome_uncertain" && !used.has(row.id));
      if (nextFinish === "return_to_start") {
        if (!Number.isFinite(mission.start_lat) || !Number.isFinite(mission.start_lng)) {
          throw httpError(409, "No recorded mission start point, so the route cannot become return-only.", {
            reason: "return_start_unavailable",
          });
        }
        emptyPlanMode = "return_only";
      }
      else if (removedOnlyUncertain) emptyPlanMode = "uncertainty_resolved";
      else {
        throw httpError(409, "The remaining route of a paused mission cannot be empty.", {
          reason: "empty_remaining_plan",
        });
      }
    }
    const now = Date.now();
    return db.transaction(() => {
      db.prepare(`UPDATE mission_waypoint SET position=position+1000000
        WHERE mission_id=? AND state IN ('pending','active') AND position IS NOT NULL`).run(missionId);
      const skip = db.prepare(`UPDATE mission_waypoint SET state='skipped',position=NULL,
        skipped_at=?,skip_reason='operator_removed',updated_at=? WHERE id=? AND mission_id=?`);
      for (const row of currentPending) {
        if (!used.has(row.id)) {
          skip.run(now, now, row.id, missionId);
          recordEvent(missionId, "waypoint.skipped", { waypointId: row.id, actor, before: publicWaypoint(row), after: { state: "skipped", skip_reason: "operator_removed" } });
        }
      }
      const completedMax = db.prepare(`SELECT COALESCE(MAX(position),-1) AS p FROM mission_waypoint
        WHERE mission_id=? AND state='completed'`).get(missionId).p;
      const update = db.prepare(`UPDATE mission_waypoint SET position=?,state='pending',updated_at=? WHERE id=? AND mission_id=?`);
      const insert = db.prepare(`INSERT INTO mission_waypoint
        (id,mission_id,position,cone_id,lat,lng,alt,side,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`);
      nextPending.forEach((row, index) => {
        const position = completedMax + 1 + index;
        if (pendingById.has(row.id)) update.run(position, now, row.id, missionId);
        else insert.run(row.id, missionId, position, row.cone_id, row.lat, row.lng, row.alt, row.side, now, now);
      });
      const planRows = db.prepare(`SELECT * FROM mission_waypoint WHERE mission_id=? AND state <> 'skipped'
        ORDER BY position,created_at,id`).all(missionId);
      const planHash = missionPlanHash(nextFinish, planRows);
      const nextHoldReason = mission.lifecycle_state === "interrupted"
        ? `${ROVER_CONFIRMED_HOLD_PREFIX}route_edited` : "route_edited";
      db.prepare(`UPDATE mission SET finish_behavior=?,plan_hash=?,updated_at=?,hold_reason=?,empty_plan_mode=? WHERE id=?`)
        .run(nextFinish, planHash, now, nextHoldReason, emptyPlanMode, missionId);
      const after = missionPublic(missionId);
      recordEvent(missionId, "mission.remaining_edited", {
        actor,
        before: { plan_hash: before.plan_hash, pending: before.waypoints.filter((w) => w.state === "pending").map((w) => w.id), finish_behavior: before.finish_behavior },
        after: {
          plan_hash: planHash,
          occurrence_revision: after.occurrence_revision,
          pending: after.waypoints.filter((w) => w.state === "pending").map((w) => w.id),
          finish_behavior: nextFinish,
          empty_plan_mode: emptyPlanMode,
        },
      });
      return after;
    })();
  }

  function issueCommand({
    missionId, action, expectedPlanHash = null, expectedOccurrenceRevision = null, actor = null,
    force = false, targetBootId = null,
  }) {
    if (!COMMAND_ACTIONS.has(action)) throw httpError(400, "Invalid mission command.");
    const mission = missionRow(missionId);
    if (!mission) throw httpError(404, "Mission not found.");
    if ((action === "start" || action === "resume")
        && (typeof expectedPlanHash !== "string" || expectedPlanHash !== mission.plan_hash)) {
      throw httpError(409, "The mission route changed. Retry with the latest mission.", {
        reason: "plan_hash_mismatch",
        current_plan_hash: mission.plan_hash,
      });
    }
    let pendingToSupersede = null;
    if (mission.active_command_id) {
      const pending = db.prepare("SELECT * FROM mission_command WHERE id=?").get(mission.active_command_id);
      if (pending?.state === "pending") {
        if (pending.action === action) {
          const pendingPayload = parseJson(pending.payload_json, {});
          const replayRevisionMatches = !["start", "resume"].includes(action)
            || pendingPayload.expected_occurrence_revision === expectedOccurrenceRevision;
          if (replayRevisionMatches) {
            return { command: pending, mission: missionPublic(missionId), replay: true };
          }
          throw httpError(409, "The mission progress changed. Reload the latest mission.", {
            reason: "occurrence_revision_mismatch",
            current_occurrence_revision: missionPublic(missionId).occurrence_revision,
          });
        }
        if (action !== "end") {
          throw httpError(409, `A ${pending.action} command is still pending.`, {
            reason: "command_in_progress", pending_action: pending.action,
          });
        }
        pendingToSupersede = pending;
      }
    }
    if ((action === "start" || action === "resume")) {
      const currentOccurrenceRevision = missionPublic(missionId).occurrence_revision;
      if (typeof expectedOccurrenceRevision !== "string"
          || expectedOccurrenceRevision !== currentOccurrenceRevision) {
        throw httpError(409, "The mission progress changed. Reload the latest mission.", {
          reason: "occurrence_revision_mismatch",
          current_occurrence_revision: currentOccurrenceRevision,
        });
      }
    }
    if (mission.active_hold_id && action !== "end") {
      throw httpError(409, "The rover has not confirmed the reboot safety hold yet.", {
        reason: "safety_hold_pending",
      });
    }
    if (TERMINAL_MISSION_STATES.has(mission.lifecycle_state)) {
      throw httpError(409, "The mission has already ended.");
    }
    if (action === "resume" && !motionConfirmedHeld(mission)) {
      throw httpError(409, "Only a mission the rover confirmed as stopped can be resumed.", {
        reason: "motion_not_confirmed_held",
      });
    }
    const allowed = action === "start" ? mission.lifecycle_state === "ready"
      : action === "resume" ? ["paused", "interrupted"].includes(mission.lifecycle_state)
        : action === "pause" ? mission.lifecycle_state === "running"
          : true;
    if (!allowed) throw httpError(409, `Cannot ${action} a mission that is ${mission.lifecycle_state}.`);
    const pending = pendingWaypoints(missionId).map(publicWaypoint);
    if ((action === "start" || action === "resume") && pending.length === 0
        && !["return_only", "uncertainty_resolved"].includes(mission.empty_plan_mode)) {
      throw httpError(409, "No remaining waypoints to run.");
    }
    if ((action === "start" || action === "resume")
        && pending.length === 0 && mission.empty_plan_mode === "return_only"
        && (!Number.isFinite(mission.start_lat) || !Number.isFinite(mission.start_lng))) {
      throw httpError(409, "No recorded mission start point, so the return-only route cannot run.", {
        reason: "return_start_unavailable",
      });
    }
    const now = Date.now();
    return db.transaction(() => {
      if (pendingToSupersede) {
        db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,
          reject_reason='operator_end' WHERE id=? AND state='pending'`)
          .run(now, pendingToSupersede.id);
        recordEvent(missionId, "command.superseded", {
          commandId: pendingToSupersede.id, actor,
          before: { state: "pending", action: pendingToSupersede.action },
          after: { state: "superseded" }, detail: { reason: "operator_end" },
        });
      }
      const seq = db.prepare("SELECT COALESCE(MAX(command_seq),0)+1 AS seq FROM mission_command WHERE mission_id=?").get(missionId).seq;
      const commandId = crypto.randomUUID();
      const nextState = action === "start" ? "starting"
        : action === "resume" ? "resuming"
          : action === "pause" ? "pausing" : mission.lifecycle_state;
      const payload = {
        protocol_version: MISSION_PROTOCOL_VERSION,
        command_id: commandId,
        command_seq: seq,
        mission_id: missionId,
        action,
        plan_hash: mission.plan_hash,
        expected_occurrence_revision: (action === "start" || action === "resume")
          ? expectedOccurrenceRevision : null,
        finish_behavior: mission.finish_behavior,
        mission_start: mission.start_lat == null ? null : { lat: mission.start_lat, lng: mission.start_lng, alt: mission.start_alt },
        waypoints: (action === "start" || action === "resume") ? pending : undefined,
        empty_plan_mode: mission.empty_plan_mode,
        force: force === true,
        target_boot_id: targetBootId,
        previous_state: mission.lifecycle_state,
      };
      db.prepare(`INSERT INTO mission_command
        (id,mission_id,command_seq,action,plan_hash,state,requested_at,actor,rover_boot_id,payload_json)
        VALUES (?,?,?,?,?,'pending',?,?,?,?)`)
        .run(commandId, missionId, seq, action, mission.plan_hash, now, actor, targetBootId, JSON.stringify(payload));
      if (action === "end") {
        // Keep the mission active until the rover durably acknowledges the end.
        // This preserves the motion fence and prevents a successor mission from
        // being created while the previous navigator may still be driving.
        db.prepare(`UPDATE mission SET updated_at=?,active_command_id=?,
          hold_reason=CASE WHEN active_hold_id IS NULL THEN 'operator_end_requested' ELSE hold_reason END
          WHERE id=?`).run(now, commandId, missionId);
      } else {
        db.prepare(`UPDATE mission SET lifecycle_state=?,status=?,updated_at=?,active_command_id=?,hold_reason=NULL WHERE id=?`)
          .run(nextState, coarseStatus(nextState), now, commandId, missionId);
      }
      recordEvent(missionId, `command.${action}.requested`, {
        commandId, actor, before: { state: mission.lifecycle_state },
        after: { state: action === "end" ? mission.lifecycle_state : nextState },
        detail: { command_seq: seq, plan_hash: mission.plan_hash, waypoint_count: pending.length, force: force === true },
      });
      return { command: { id: commandId, mission_id: missionId, command_seq: seq, action, state: "pending", payload_json: JSON.stringify(payload) }, mission: missionPublic(missionId), replay: false };
    })();
  }

  function applyReport(report, actor = "rover") {
    const missionId = Number(report.mission_id);
    if (!REPORT_EVENTS.has(report.event)) {
      throw httpError(400, "Unknown mission report event.", { reason: "unknown_report_event" });
    }
    if (report.event === "command"
        && (typeof report.command_id !== "string"
          || !Number.isInteger(report.command_seq)
          || !["accepted", "rejected"].includes(report.command_result)
          || !["running", "held"].includes(report.motion_state))) {
      throw httpError(400, "The command report is missing its correlation fields.", { reason: "invalid_command_report" });
    }
    if (report.event === "state" && !["running", "held"].includes(report.motion_state)) {
      throw httpError(400, "Invalid rover motion state.", { reason: "invalid_motion_state" });
    }
    if (["waypoint_active", "waypoint_completed", "waypoint_failed"].includes(report.event)
        && (typeof report.waypoint_id !== "string" || !report.waypoint_id)) {
      throw httpError(400, "The waypoint report has no waypoint ID.", { reason: "missing_waypoint_id" });
    }
    if (report.completed_waypoint_ids !== undefined
        && (!Array.isArray(report.completed_waypoint_ids)
          || report.completed_waypoint_ids.some((id) => typeof id !== "string" || !id))) {
      throw httpError(400, "Invalid completed waypoint checkpoint.", {
        reason: "invalid_completed_waypoint_ids",
      });
    }
    const mission = missionRow(missionId);
    if (!mission) throw httpError(404, "The reported mission does not exist.", { reason: "unknown_mission" });
    if (report.plan_hash !== mission.plan_hash) {
      throw httpError(409, "The rover plan hash does not match the hub.", { reason: "plan_hash_mismatch" });
    }
    if (TERMINAL_MISSION_STATES.has(mission.lifecycle_state) && report.event !== "command") {
      throw httpError(409, "An ended mission cannot change state.", { reason: "terminal_mission" });
    }
    const now = Date.now();
    return db.transaction(() => {
      const terminalAtReport = TERMINAL_MISSION_STATES.has(mission.lifecycle_state);
      const activeCommandAtReport = mission.active_command_id == null ? null : db.prepare(`SELECT id,action,state
        FROM mission_command WHERE id=? AND mission_id=?`).get(mission.active_command_id, missionId);
      const pendingEnd = activeCommandAtReport?.state === "pending"
        && activeCommandAtReport.action === "end" ? activeCommandAtReport : null;
      if (mission.active_hold_id && ["held", "interrupted"].includes(report.event)) {
        if (report.hold_id !== mission.active_hold_id) {
          throw httpError(409, "The safety hold ID does not match the current hold.", {
            reason: "hold_id_mismatch",
          });
        }
        if (report.checkpoint_persisted !== true) {
          throw httpError(409, "The rover has not persisted its hold checkpoint yet.", {
            reason: "checkpoint_not_persisted",
          });
        }
      }
      if (mission.active_hold_id
          && ["waypoint_active", "waypoint_failed", "mission_completed"].includes(report.event)) {
        throw httpError(409, "This report cannot change the mission until the safety hold is confirmed.", {
          reason: "safety_hold_pending",
        });
      }
      const completedIds = Array.isArray(report.completed_waypoint_ids)
        ? [...new Set(report.completed_waypoint_ids)] : [];
      if (!terminalAtReport) {
        const selectWaypoint = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?");
        const completeWaypoint = db.prepare(`UPDATE mission_waypoint SET state='completed',outcome='success',
          completed_at=COALESCE(completed_at,?),updated_at=? WHERE id=? AND mission_id=? AND state IN ('pending','active')`);
        for (const waypointId of completedIds) {
          const wp = selectWaypoint.get(waypointId, missionId);
          if (!wp) {
            throw httpError(409, "The checkpoint lists a waypoint outside this mission.", {
              reason: "unknown_completed_waypoint",
            });
          }
          if (wp.state === "skipped") {
            throw httpError(409, "A skipped waypoint cannot be checkpointed as completed.", {
              reason: "skipped_completed_waypoint",
            });
          }
          if (report.event === "waypoint_completed" && waypointId === report.waypoint_id) continue;
          const changed = completeWaypoint.run(now, now, waypointId, missionId).changes;
          if (changed) recordEvent(missionId, "waypoint.reconciled_completed", {
            waypointId, roverBootId: report.boot_id, actor,
            before: { state: wp.state }, after: { state: "completed", outcome: "success" },
          });
        }
      }
      let command = null;
      if (report.command_id) command = db.prepare("SELECT * FROM mission_command WHERE id=? AND mission_id=?").get(report.command_id, missionId);
      if (report.command_id && !command) {
        throw httpError(409, "Unknown command ID.", { reason: "unknown_command" });
      }
      if (command && report.event === "command" && report.command_seq !== command.command_seq) {
        throw httpError(409, "The command sequence does not match the request.", { reason: "command_seq_mismatch" });
      }
      if (command && report.event === "command" && command.action === "end"
          && report.command_result === "accepted" && report.motion_state !== "held") {
        throw httpError(409, "The mission cannot end before the rover confirms it is stopped.", {
          reason: "end_motion_not_held",
        });
      }
      if (command && report.event === "command" && command.action === "pause"
          && report.command_result === "accepted" && report.motion_state !== "held") {
        throw httpError(409, "The pause cannot complete before the rover confirms it is stopped.", {
          reason: "pause_motion_not_held",
        });
      }
      if (command && report.event === "command" && command.state === "superseded") {
        recordEvent(missionId, `command.${command.action}.late_result_ignored`, {
          commandId: command.id, roverBootId: report.boot_id, actor,
          before: { state: mission.lifecycle_state, command_state: "superseded" },
          after: { state: mission.lifecycle_state, command_state: "superseded" },
          detail: { reported_result: report.command_result, motion_state: report.motion_state },
        });
        return missionPublic(missionId);
      }
      if (command && report.event === "command" && command.state !== "pending"
          && command.state !== report.command_result) {
        throw httpError(409, "The result conflicts with the recorded command result.", { reason: "command_result_conflict" });
      }
      if (command && report.command_result && command.state === "pending") {
        const accepted = report.command_result === "accepted";
        if (!accepted && report.command_result !== "rejected") {
          throw httpError(400, "Invalid command result.");
        }
        db.prepare(`UPDATE mission_command SET state=?,acknowledged_at=?,rover_boot_id=?,reject_reason=? WHERE id=?`)
          .run(accepted ? "accepted" : "rejected", now, report.boot_id, accepted ? null : (report.reason || "rejected"), command.id);
        if (terminalAtReport || mission.active_command_id !== command.id) {
          recordEvent(missionId, `command.${command.action}.${accepted ? "accepted" : "rejected"}`, {
            commandId: command.id, roverBootId: report.boot_id, actor,
            before: { state: mission.lifecycle_state, command_state: "pending" },
            after: { state: mission.lifecycle_state, command_state: accepted ? "accepted" : "rejected" },
            detail: { reason: report.reason || null, lifecycle_unchanged: true },
          });
          return missionPublic(missionId);
        }
        let nextState = mission.lifecycle_state;
        let nextStatus = mission.status;
        let endedAt = mission.ended_at;
        if (accepted) {
          if (command.action === "start" || command.action === "resume") {
            nextState = report.motion_state === "running"
              ? "running" : (command.action === "start" ? "ready" : "paused");
            nextStatus = coarseStatus(nextState);
          } else if (command.action === "pause") {
            nextState = report.motion_state === "held" ? "paused" : mission.lifecycle_state;
            nextStatus = coarseStatus(nextState);
          } else if (command.action === "end") {
            nextState = "cancelled";
            nextStatus = "stopped";
            endedAt = endedAt || now;
          }
        } else {
          const payload = parseJson(command.payload_json, {});
          const previousState = payload.previous_state || "interrupted";
          nextState = report.motion_state === "held"
            ? (previousState === "ready" ? "ready" : "paused")
            : (previousState === "running" ? "running" : "interrupted");
          nextStatus = coarseStatus(nextState);
        }
        const preserveSafetyHold = mission.active_hold_id != null && nextState !== "cancelled";
        if (preserveSafetyHold) {
          nextState = "interrupted";
          nextStatus = "interrupted";
          endedAt = mission.ended_at;
        }
        db.prepare(`UPDATE mission SET lifecycle_state=?,status=?,updated_at=?,ended_at=?,
          active_command_id=NULL,last_rover_boot_id=?,activated_at=CASE WHEN ?='running' THEN COALESCE(activated_at,?) ELSE activated_at END,
          hold_reason=?,active_hold_id=CASE WHEN ? IN ('running','cancelled') THEN NULL ELSE active_hold_id END WHERE id=?`)
          .run(nextState, nextStatus, now, endedAt, report.boot_id, nextState, now,
            preserveSafetyHold
              ? "rover_rebooted"
              : nextState === "running" || nextState === "cancelled"
              ? null
              : (report.reason || (accepted ? "command_accepted_held" : `command_rejected:${report.reason || "unknown"}`)),
            nextState, missionId);
        recordEvent(missionId, `command.${command.action}.${accepted ? "accepted" : "rejected"}`, {
          commandId: command.id, roverBootId: report.boot_id, actor,
          before: { state: mission.lifecycle_state }, after: { state: nextState }, detail: { reason: report.reason || null },
        });
      }

      if (report.event === "state") {
        let reconciledState;
        if (report.motion_state === "running") {
          const sameBoot = !mission.last_rover_boot_id || mission.last_rover_boot_id === report.boot_id;
          // A new boot is held explicitly by reconcileRoverBoot. Even if a
          // faulty/stale navigator claims it is moving under that new boot ID,
          // only an operator resume command may release the reboot hold. A
          // same-process network reconnect uses a different hold reason and may
          // legitimately re-adopt motion already in progress.
          const mayAdoptMotion = sameBoot && (
            mission.lifecycle_state === "running"
            || (mission.lifecycle_state === "interrupted"
              && NETWORK_RECONCILE_REASONS.has(mission.hold_reason))
          );
          if (mayAdoptMotion) {
            reconciledState = "running";
            db.prepare(`UPDATE mission SET lifecycle_state='running',status='running',hold_reason=NULL,
              updated_at=?,last_rover_boot_id=?,activated_at=COALESCE(activated_at,?) WHERE id=?`)
              .run(now, report.boot_id, now, missionId);
          } else {
            // A state report is observational, not an authorization to release a
            // confirmed hold. Preserve pause/reboot/operator state verbatim; the
            // only path back to running is a correlated resume acceptance (or the
            // narrow network-reconciliation cases above).
            reconciledState = mission.lifecycle_state;
          }
        } else if (report.motion_state === "held") {
          if (mission.active_hold_id) {
            reconciledState = mission.lifecycle_state;
          } else if (mission.active_command_id) {
            const pendingCommand = db.prepare(`SELECT id,command_seq,action,state FROM mission_command
              WHERE id=? AND mission_id=?`).get(mission.active_command_id, missionId);
            const checkpointSeq = Number.isInteger(report.command_seq) ? report.command_seq : null;
            const checkpointCommandId = typeof report.last_command_id === "string"
              ? report.last_command_id : null;
            const checkpointResult = ["accepted", "rejected"].includes(report.last_command_result)
              ? report.last_command_result : null;
            const resolvesPending = pendingCommand?.state === "pending"
              && checkpointSeq === pendingCommand.command_seq
              && checkpointCommandId === pendingCommand.id
              && checkpointResult != null;
            const supersedesPending = pendingCommand?.state === "pending"
              && checkpointSeq != null && checkpointSeq > pendingCommand.command_seq;
            if (resolvesPending || supersedesPending) {
              const pendingPayload = parseJson(
                db.prepare("SELECT payload_json FROM mission_command WHERE id=?")
                  .get(mission.active_command_id)?.payload_json,
                {},
              );
              if (resolvesPending && checkpointResult === "accepted") {
                reconciledState = pendingCommand.action === "end" ? "cancelled"
                  : pendingCommand.action === "start" ? "ready" : "paused";
              } else if (resolvesPending) {
                reconciledState = pendingPayload.previous_state === "ready" ? "ready" : "paused";
              } else {
                reconciledState = "paused";
              }
              const acceptedEnd = reconciledState === "cancelled";
              db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=?
                WHERE mission_id=? AND state='active'`).run(now, missionId);
              db.prepare(`UPDATE mission SET lifecycle_state=?,status=?,hold_reason=?,updated_at=?,
                ended_at=CASE WHEN ?='cancelled' THEN COALESCE(ended_at,?) ELSE ended_at END,
                last_rover_boot_id=?,active_command_id=NULL,
                active_hold_id=CASE WHEN ?='cancelled' THEN NULL ELSE active_hold_id END WHERE id=?`)
                .run(
                  reconciledState, coarseStatus(reconciledState),
                  acceptedEnd ? null : (report.last_command_reason || report.reason || "checkpoint_restored"),
                  now, reconciledState, now, report.boot_id, reconciledState, missionId,
                );
              if (resolvesPending) {
                db.prepare(`UPDATE mission_command SET state=?,acknowledged_at=?,reject_reason=?
                  WHERE id=? AND state='pending'`).run(
                  checkpointResult,
                  now,
                  checkpointResult === "rejected"
                    ? (report.last_command_reason || report.reason || "checkpoint_rejected") : null,
                  mission.active_command_id,
                );
              } else {
                db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,
                  reject_reason='newer_held_checkpoint' WHERE id=? AND state='pending'`)
                  .run(now, mission.active_command_id);
              }
            } else {
              // A state request is sent before pending-command replay on hub
              // recovery. A held checkpoint whose durable command sequence is
              // older than (or equal to) that pending command is pre-command
              // evidence, not authority to retire the command that follows it.
              // Keep the transition fenced until the correlated command result.
              reconciledState = mission.lifecycle_state;
              db.prepare(`UPDATE mission SET last_rover_boot_id=?,updated_at=? WHERE id=?`)
                .run(report.boot_id, now, missionId);
              recordEvent(missionId, "command.checkpoint_observed", {
                commandId: mission.active_command_id, roverBootId: report.boot_id, actor,
                before: { state: mission.lifecycle_state, command_state: pendingCommand?.state || null },
                after: { state: mission.lifecycle_state, command_state: pendingCommand?.state || null },
                detail: {
                  checkpoint_command_seq: checkpointSeq,
                  checkpoint_command_id: checkpointCommandId,
                  checkpoint_command_result: checkpointResult,
                  checkpoint_command_reason: report.last_command_reason || null,
                },
              });
            }
          } else {
            reconciledState = "paused";
            db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
            db.prepare(`UPDATE mission SET lifecycle_state='paused',status='paused',hold_reason=?,updated_at=?,
              last_rover_boot_id=?,active_command_id=NULL WHERE id=?`)
              .run(report.reason || "checkpoint_restored", now, report.boot_id, missionId);
            if (mission.active_command_id) {
              db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,reject_reason='newer_held_report'
                WHERE id=? AND state='pending'`).run(now, mission.active_command_id);
            }
          }
        }
        recordEvent(missionId, "mission.reconciled", {
          roverBootId: report.boot_id, actor,
          before: { state: mission.lifecycle_state, rover_boot_id: mission.last_rover_boot_id },
          after: { state: reconciledState, rover_boot_id: report.boot_id },
          detail: { completed_count: completedIds.length, reason: report.reason || null },
        });
      }

      if (report.event === "waypoint_active" && report.waypoint_id) {
        const wp = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?").get(report.waypoint_id, missionId);
        if (!wp || !["pending", "active"].includes(wp.state)) {
          throw httpError(409, "The active waypoint is not a pending waypoint of this mission.");
        }
        db.prepare(`UPDATE mission_waypoint SET state='active',attempt_count=attempt_count+CASE WHEN state='pending' THEN 1 ELSE 0 END,
          updated_at=? WHERE id=?`).run(now, wp.id);
        recordEvent(missionId, "waypoint.active", { waypointId: wp.id, roverBootId: report.boot_id, actor, before: { state: wp.state }, after: { state: "active" } });
      }
      if (report.event === "waypoint_completed" && report.waypoint_id) {
        const wp = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?").get(report.waypoint_id, missionId);
        if (!wp) {
          throw httpError(409, "The completed waypoint does not belong to this mission.");
        }
        if (["pending", "active"].includes(wp.state)) {
          db.prepare(`UPDATE mission_waypoint SET state='completed',outcome='success',completed_at=?,updated_at=? WHERE id=?`)
            .run(now, now, wp.id);
          recordEvent(missionId, "waypoint.completed", { waypointId: wp.id, roverBootId: report.boot_id, actor, before: publicWaypoint(wp), after: { state: "completed", outcome: "success" } });
        } else if (wp.state !== "completed") {
          throw httpError(409, "A skipped waypoint cannot be completed.");
        }
      }
      if (report.event === "waypoint_failed" && report.waypoint_id) {
        const wp = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?").get(report.waypoint_id, missionId);
        if (!wp || !["pending", "active"].includes(wp.state)) {
          throw httpError(409, "The failed waypoint is not a pending waypoint of this mission.");
        }
        db.prepare(`UPDATE mission_waypoint SET state='pending',outcome=?,updated_at=? WHERE id=?`)
          .run(report.outcome || "failed", now, wp.id);
        db.prepare(`UPDATE mission SET lifecycle_state='paused',status='paused',hold_reason='waypoint_failed',updated_at=? WHERE id=?`)
          .run(now, missionId);
        recordEvent(missionId, "waypoint.failed", { waypointId: wp.id, roverBootId: report.boot_id, actor, before: publicWaypoint(wp), after: { state: "pending", outcome: report.outcome || "failed" } });
      }
      if (["held", "interrupted"].includes(report.event)
          && (report.reason === "dispense_outcome_uncertain"
            || report.outcome === "dispense_outcome_uncertain"
            || report.motion_state === "dispense_uncertain")
          && typeof report.active_waypoint_id === "string") {
        const wp = db.prepare("SELECT * FROM mission_waypoint WHERE id=? AND mission_id=?")
          .get(report.active_waypoint_id, missionId);
        if (!wp || !["pending", "active"].includes(wp.state)) {
          throw httpError(409, "The waypoint with an uncertain dispense is not a pending waypoint of this mission.", {
            reason: "invalid_uncertain_waypoint",
          });
        }
        db.prepare(`UPDATE mission_waypoint SET state='pending',outcome='dispense_outcome_uncertain',updated_at=?
          WHERE id=? AND mission_id=?`).run(now, wp.id, missionId);
        recordEvent(missionId, "waypoint.dispense_uncertain", {
          waypointId: wp.id, roverBootId: report.boot_id, actor,
          before: publicWaypoint(wp),
          after: { state: "pending", outcome: "dispense_outcome_uncertain" },
        });
      }
      if (report.event === "held") {
        db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
        if (pendingEnd) {
          const confirmedReason = `${ROVER_CONFIRMED_HOLD_PREFIX}${report.reason || "rover_held"}`;
          db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason=?,updated_at=?,
            last_rover_boot_id=?,active_hold_id=NULL WHERE id=?`)
            .run(confirmedReason, now, report.boot_id, missionId);
        } else {
          db.prepare(`UPDATE mission SET lifecycle_state='paused',status='paused',hold_reason=?,updated_at=?,
            last_rover_boot_id=?,active_hold_id=NULL,active_command_id=NULL WHERE id=?`)
            .run(report.reason || "rover_held", now, report.boot_id, missionId);
        }
        if (mission.active_command_id && !pendingEnd) {
          db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,reject_reason='newer_held_report'
            WHERE id=? AND state='pending'`).run(now, mission.active_command_id);
        }
        recordEvent(missionId, "mission.held", {
          roverBootId: report.boot_id, actor,
          before: { state: mission.lifecycle_state, active_hold_id: mission.active_hold_id },
          after: {
            state: pendingEnd ? "interrupted" : "paused",
            reason: report.reason || "rover_held",
            active_hold_id: null,
            active_command_id: pendingEnd?.id || null,
          },
          detail: {
            hold_id: report.hold_id || null,
            checkpoint_persisted: report.checkpoint_persisted === true,
            pending_end_preserved: !!pendingEnd,
          },
        });
      }
      if (report.event === "interrupted") {
        db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
        const confirmedReason = `${ROVER_CONFIRMED_HOLD_PREFIX}${report.reason || "rover_interrupted"}`;
        db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason=?,updated_at=?,
          last_rover_boot_id=?,active_hold_id=NULL,
          active_command_id=CASE WHEN ? THEN active_command_id ELSE NULL END WHERE id=?`)
          .run(confirmedReason, now, report.boot_id, pendingEnd ? 1 : 0, missionId);
        if (mission.active_command_id && !pendingEnd) {
          db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,reject_reason='newer_interrupted_report'
            WHERE id=? AND state='pending'`).run(now, mission.active_command_id);
        }
        recordEvent(missionId, "mission.interrupted", {
          roverBootId: report.boot_id, actor,
          before: { state: mission.lifecycle_state, active_hold_id: mission.active_hold_id },
          after: {
            state: "interrupted",
            reason: report.reason || "rover_interrupted",
            active_hold_id: null,
            active_command_id: pendingEnd?.id || null,
          },
          detail: {
            hold_id: report.hold_id || null,
            checkpoint_persisted: report.checkpoint_persisted === true,
            pending_end_preserved: !!pendingEnd,
          },
        });
      }
      if (report.event === "mission_completed") {
        const remaining = db.prepare(`SELECT COUNT(*) AS n FROM mission_waypoint WHERE mission_id=? AND state IN ('pending','active')`).get(missionId).n;
        if (remaining > 0) {
          throw httpError(409, `Cannot complete the mission with ${remaining} waypoint(s) still pending.`, {
            reason: "pending_waypoints",
          });
        }
        if (mission.active_command_id) {
          const retired = db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,
            reject_reason='mission_completed' WHERE id=? AND mission_id=? AND state='pending'`)
            .run(now, mission.active_command_id, missionId).changes;
          if (retired) recordEvent(missionId, "command.superseded", {
            commandId: mission.active_command_id,
            roverBootId: report.boot_id,
            actor,
            before: { state: "pending" },
            after: { state: "superseded" },
            detail: { reason: "mission_completed" },
          });
        }
        db.prepare(`UPDATE mission SET lifecycle_state='completed',status='completed',ended_at=?,updated_at=?,
          active_command_id=NULL,active_hold_id=NULL,hold_reason=NULL,last_rover_boot_id=? WHERE id=?`)
          .run(now, now, report.boot_id, missionId);
        recordEvent(missionId, "mission.completed", { roverBootId: report.boot_id, actor, before: { state: mission.lifecycle_state }, after: { state: "completed" } });
      }
      if (report.start_position && mission.start_lat == null
          && Number.isFinite(report.start_position.lat) && Number.isFinite(report.start_position.lng)) {
        db.prepare(`UPDATE mission SET start_lat=?,start_lng=?,start_alt=?,updated_at=? WHERE id=? AND start_lat IS NULL`)
          .run(report.start_position.lat, report.start_position.lng,
            Number.isFinite(report.start_position.alt) ? report.start_position.alt : null, now, missionId);
      }
      return missionPublic(missionId);
    })();
  }

  function markInterrupted(missionId, reason, roverBootId = null, { confirmed = false } = {}) {
    const mission = missionRow(missionId);
    if (!mission || TERMINAL_MISSION_STATES.has(mission.lifecycle_state)) return null;
    const activeCommand = mission.active_command_id == null ? null : db.prepare(`SELECT id,action,state
      FROM mission_command WHERE id=? AND mission_id=?`).get(mission.active_command_id, missionId);
    const pendingEnd = activeCommand?.action === "end" && activeCommand.state === "pending"
      ? activeCommand : null;
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=? WHERE mission_id=? AND state='active'`).run(now, missionId);
      const persistedReason = confirmed
        ? `${ROVER_CONFIRMED_HOLD_PREFIX}${reason}`
        : (mission.active_hold_id ? "rover_rebooted" : reason);
      db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason=?,updated_at=?,
        active_command_id=CASE WHEN ? THEN active_command_id ELSE NULL END,
        active_hold_id=CASE WHEN ? THEN NULL ELSE active_hold_id END,
        last_rover_boot_id=COALESCE(?,last_rover_boot_id) WHERE id=?`)
        .run(persistedReason, now, pendingEnd ? 1 : 0, confirmed ? 1 : 0, roverBootId, missionId);
      if (mission.active_command_id && !pendingEnd) {
        db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,reject_reason=? WHERE id=? AND state='pending'`)
          .run(now, reason, mission.active_command_id);
      }
      recordEvent(missionId, "mission.interrupted", {
        roverBootId,
        before: { state: mission.lifecycle_state, active_hold_id: mission.active_hold_id },
        after: {
          state: "interrupted",
          reason: persistedReason,
          active_hold_id: confirmed ? null : mission.active_hold_id,
          active_command_id: pendingEnd?.id || null,
        },
        detail: { confirmed, pending_end_preserved: !!pendingEnd },
      });
    })();
    return missionPublic(missionId);
  }

  function markCommandDeliveryFailed(missionId, commandId, roverBootId = null) {
    const mission = missionRow(missionId);
    const command = db.prepare(`SELECT * FROM mission_command
      WHERE id=? AND mission_id=?`).get(commandId, missionId);
    if (!mission || !command || command.state !== "pending"
        || mission.active_command_id !== commandId
        || TERMINAL_MISSION_STATES.has(mission.lifecycle_state)) {
      return mission ? missionPublic(missionId) : null;
    }
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`UPDATE mission_waypoint SET state='pending',updated_at=?
        WHERE mission_id=? AND state='active'`).run(now, missionId);
      db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,
        reject_reason='command_delivery_failed' WHERE id=?`).run(now, commandId);
      db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',
        hold_reason=CASE WHEN active_hold_id IS NULL THEN 'command_delivery_failed' ELSE 'rover_rebooted' END,
        active_command_id=NULL,updated_at=?,
        last_rover_boot_id=COALESCE(?,last_rover_boot_id) WHERE id=?`)
        .run(now, roverBootId, missionId);
      recordEvent(missionId, "command.delivery_failed", {
        commandId, roverBootId,
        before: { state: mission.lifecycle_state, command_state: "pending" },
        after: { state: "interrupted", command_state: "superseded" },
        detail: { action: command.action, reason: "command_delivery_failed" },
      });
    })();
    return missionPublic(missionId);
  }

  function pendingCommands() {
    return db.prepare("SELECT * FROM mission_command WHERE state='pending' ORDER BY requested_at,id").all();
  }

  function claimRoverBootSession(bootId) {
    if (typeof bootId !== "string" || !bootId || bootId.length > 128) {
      return { accepted: false, reason: "invalid_boot_id" };
    }
    const now = Date.now();
    return db.transaction(() => {
      const latest = db.prepare("SELECT COALESCE(MAX(generation),0) AS generation FROM rover_boot_session").get().generation;
      const existing = db.prepare("SELECT * FROM rover_boot_session WHERE boot_id=?").get(bootId);
      if (existing) {
        if (!Number.isSafeInteger(existing.last_report_seq) || existing.last_report_seq < -1) {
          return { accepted: false, reason: "invalid_report_sequence" };
        }
        if (existing.generation !== latest) {
          return {
            accepted: false,
            reason: "stale_boot_session",
            generation: existing.generation,
            current_generation: latest,
          };
        }
        db.prepare("UPDATE rover_boot_session SET last_seen_at=? WHERE boot_id=?").run(now, bootId);
        return {
          accepted: true,
          generation: existing.generation,
          last_report_seq: existing.last_report_seq,
          replay: true,
        };
      }
      const generation = latest + 1;
      db.prepare(`INSERT INTO rover_boot_session
        (boot_id,generation,first_seen_at,last_seen_at) VALUES (?,?,?,?)`)
        .run(bootId, generation, now, now);
      return { accepted: true, generation, last_report_seq: -1, replay: false };
    })();
  }

  function processRoverReport(bootId, reportSeq, apply) {
    if (typeof bootId !== "string" || !bootId || bootId.length > 128
        || !Number.isSafeInteger(reportSeq) || reportSeq < 0
        || typeof apply !== "function") {
      throw httpError(400, "Invalid rover report sequence.", { reason: "invalid_report_sequence" });
    }
    const now = Date.now();
    try {
      const result = db.transaction(() => {
        const latestGeneration = db.prepare(
          "SELECT COALESCE(MAX(generation),0) AS generation FROM rover_boot_session",
        ).get().generation;
        const session = db.prepare("SELECT * FROM rover_boot_session WHERE boot_id=?").get(bootId);
        if (!session || session.generation !== latestGeneration) {
          throw httpError(409, "The report is from a superseded rover boot session.", {
            reason: "stale_boot_session",
          });
        }
        if (reportSeq <= session.last_report_seq) {
          return { duplicate: true, last_report_seq: session.last_report_seq, value: null };
        }
        const value = apply();
        const advanced = db.prepare(`UPDATE rover_boot_session
          SET last_report_seq=?,last_seen_at=?
          WHERE boot_id=? AND generation=? AND last_report_seq<?`)
          .run(reportSeq, now, bootId, latestGeneration, reportSeq).changes;
        if (advanced !== 1) {
          throw httpError(409, "The rover report sequence could not advance.", {
            reason: "report_sequence_conflict",
          });
        }
        return { duplicate: false, last_report_seq: reportSeq, value };
      })();
      rehydrateActiveSummaryCache();
      return result;
    } catch (error) {
      // missionPublic() updates the hot summary cache inside applyReport's
      // nested transaction. If the outer report-sequence write rolls back,
      // rebuild the cache from committed rows before any safety gate reads it.
      try { rehydrateActiveSummaryCache(); }
      catch { activeSummaryHydrated = false; activeSummaryCache = null; }
      throw error;
    }
  }

  function reconcileRoverBoot(bootId) {
    const now = Date.now();
    const mismatched = db.prepare(`SELECT * FROM mission_command
      WHERE state='pending' AND (rover_boot_id IS NULL OR rover_boot_id <> ?)`)
      .all(bootId);
    const activeRow = db.prepare(`SELECT * FROM mission WHERE lifecycle_state IN
      ('ready','starting','running','pausing','paused','interrupted','resuming')
      ORDER BY id DESC LIMIT 1`).get();
    const motionMayStillBeActive = activeRow && (
      ["starting", "running", "pausing", "resuming"].includes(activeRow.lifecycle_state)
      || (activeRow.lifecycle_state === "interrupted"
        && NETWORK_RECONCILE_REASONS.has(activeRow.hold_reason))
    );
    const movingMissionRebooted = motionMayStillBeActive
      && activeRow.last_rover_boot_id
      && activeRow.last_rover_boot_id !== bootId;
    if (mismatched.length === 0 && !movingMissionRebooted) return activeMission();
    return db.transaction(() => {
      const interruptedIds = new Set();
      for (const command of mismatched) {
        const mission = missionRow(command.mission_id);
        if (command.action === "end" && mission
            && !TERMINAL_MISSION_STATES.has(mission.lifecycle_state)) {
          const payload = parseJson(command.payload_json, {});
          const retargetedPayload = { ...payload, target_boot_id: bootId };
          const holdId = crypto.randomUUID();
          db.prepare(`UPDATE mission_command SET rover_boot_id=?,payload_json=?
            WHERE id=? AND state='pending'`).run(bootId, JSON.stringify(retargetedPayload), command.id);
          db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',
            hold_reason='rover_rebooted',active_command_id=?,active_hold_id=?,updated_at=?,last_rover_boot_id=?
            WHERE id=?`).run(command.id, holdId, now, bootId, mission.id);
          recordEvent(mission.id, "command.end.retargeted", {
            commandId: command.id,
            roverBootId: bootId,
            before: { state: mission.lifecycle_state, target_boot_id: command.rover_boot_id },
            after: { state: "interrupted", target_boot_id: bootId },
            detail: { reason: "rover_rebooted", hold_id: holdId },
          });
          interruptedIds.add(mission.id);
          continue;
        }
        db.prepare(`UPDATE mission_command SET state='superseded',acknowledged_at=?,reject_reason='rover_rebooted' WHERE id=?`)
          .run(now, command.id);
        if (mission && !TERMINAL_MISSION_STATES.has(mission.lifecycle_state)) {
          const holdId = crypto.randomUUID();
          db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason='rover_rebooted',
            active_command_id=NULL,active_hold_id=?,updated_at=?,last_rover_boot_id=? WHERE id=?`)
            .run(holdId, now, bootId, mission.id);
          recordEvent(mission.id, "command.superseded", {
            commandId: command.id, roverBootId: bootId,
            before: { state: mission.lifecycle_state }, after: { state: "interrupted" },
            detail: { reason: "rover_rebooted", hold_id: holdId },
          });
          interruptedIds.add(mission.id);
        } else if (mission) {
          recordEvent(mission.id, "command.superseded", {
            commandId: command.id, roverBootId: bootId,
            before: { state: mission.lifecycle_state, command_state: "pending" },
            after: { state: mission.lifecycle_state, command_state: "superseded" },
            detail: { reason: "rover_rebooted", lifecycle_unchanged: true },
          });
        }
      }
      if (movingMissionRebooted && !interruptedIds.has(activeRow.id)) {
        const holdId = crypto.randomUUID();
        db.prepare(`UPDATE mission SET lifecycle_state='interrupted',status='interrupted',hold_reason='rover_rebooted',
          active_command_id=NULL,active_hold_id=?,updated_at=?,last_rover_boot_id=? WHERE id=?`)
          .run(holdId, now, bootId, activeRow.id);
        recordEvent(activeRow.id, "mission.interrupted", {
          roverBootId: bootId,
          before: { state: activeRow.lifecycle_state, rover_boot_id: activeRow.last_rover_boot_id },
          after: { state: "interrupted", rover_boot_id: bootId },
          detail: { reason: "rover_rebooted", hold_id: holdId },
        });
      }
      return activeMission();
    })();
  }

  return {
    activeMission,
    activeMissionSummary,
    applyReport,
    claimRoverBootSession,
    createMission,
    editRemaining,
    issueCommand,
    markCommandDeliveryFailed,
    markInterrupted,
    missionPublic,
    missionRow,
    motionConfirmedHeld,
    pendingCommands,
    pendingWaypoints,
    processRoverReport,
    reconcileRoverBoot,
    recordEvent,
    waypointRows,
  };
}
