import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../rover/hub/server/db.mjs";
import { createMissionV2Store } from "../../rover/hub/server/mission-v2.mjs";
import { initializeHubSchema } from "../../rover/hub/server/schema.mjs";
import {
  TEST_COURSE,
  cleanupDb,
  coneItems,
  startHub,
  tmpDbPath,
} from "./helpers.mjs";

const FIXTURE_COURSE = Object.freeze({ id: 41, name: "Fixture Course" });
const FIXTURE_POINTS = coneItems([
  [35.0, 126.0, "left", 101],
  [35.00001, 126.00001, "right", 102],
  [35.00002, 126.00002, "left", 103],
]);

// A bare store on an in-memory hub schema.
function createStoreFixture() {
  const db = openDatabase(":memory:");
  initializeHubSchema(db);
  return {
    db,
    store: createMissionV2Store(db),
    items: (indices) => indices.map((index) => ({ ...FIXTURE_POINTS[index] })),
    create(indices = [0], options = {}) {
      return this.store.createMission({ course: FIXTURE_COURSE, items: this.items(indices), ...options });
    },
    close() { db.close(); },
  };
}

let ctx;
let cones;
let reportSeq = 0;

const createMission = (items, finishBehavior = "stop") => ctx.operator.json("POST", "/api/missions", {
  course: TEST_COURSE,
  finish_behavior: finishBehavior,
  items,
});
const command = (missionId, action, body = {}) => ctx.operator.json("POST", `/api/missions/${missionId}/${action}`, body);
const report = (rover, body) => ctx.device.json("POST", "/api/rover/mission-report", {
  protocol_version: 2,
  boot_id: rover.bootId,
  ...body,
});
const telemetry = (body) => ctx.device.json("POST", "/api/rover/telemetry", body);

async function waitForActiveMission(match, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const mission = await ctx.activeMission();
    if (match(mission)) return mission;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("active mission did not reach the expected state");
}

before(async () => {
  ctx = await startHub();
  cones = coneItems([
    [35.0, 126.0, "left", 1],
    [35.00001, 126.00001, "right", 2],
    [35.00002, 126.00002, "center", 3],
  ]);
});

after(async () => {
  await ctx.stop();
});

describe("durable rover report sequence across hub restarts", () => {
  it("rejects duplicate and terminal reports through the real endpoint after process recreation", async () => {
    const dbPath = tmpDbPath();
    const bootId = "boot-http-restart-sequence";
    let instance = null;
    try {
      instance = await startHub({ dbPath });
      const created = await instance.operator.json("POST", "/api/missions", {
        course: TEST_COURSE,
        items: coneItems([[35, 126, "left", 1]]),
      });
      assert.equal(created.status, 201);
      const mission = created.data;
      await instance.openRover(bootId);
      const heldReport = {
        protocol_version: 2,
        boot_id: bootId,
        report_seq: 7,
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        event: "held",
        reason: "checkpoint_restored",
        motion_state: "held",
        completed_waypoint_ids: [],
      };
      const held = await instance.device.json("POST", "/api/rover/mission-report", heldReport);
      assert.equal(held.status, 200);
      assert.equal(held.data.duplicate, undefined);
      await instance.stop({ keepDb: true });

      instance = await startHub({ dbPath });
      const rover = await instance.openRover(bootId);
      const duplicate = await instance.device.json("POST", "/api/rover/mission-report", heldReport);
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.data.duplicate, true);

      const endEvent = rover.waitFor("mission-command", (data) => data.action === "end");
      const end = await instance.operator.json("POST", `/api/missions/${mission.id}/end`, {});
      assert.equal(end.status, 202);
      const endCommand = (await endEvent).data;
      const terminalReport = {
        protocol_version: 2,
        boot_id: bootId,
        report_seq: 8,
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        event: "command",
        command_id: endCommand.command_id,
        command_seq: endCommand.command_seq,
        command_result: "accepted",
        motion_state: "held",
      };
      const terminal = await instance.device.json("POST", "/api/rover/mission-report", terminalReport);
      assert.equal(terminal.status, 200);
      assert.equal(terminal.data.mission.status, "cancelled");
      assert.equal(terminal.data.reset_mission, true);
      await instance.stop({ keepDb: true });

      instance = await startHub({ dbPath });
      await instance.openRover(bootId);
      const terminalDuplicate = await instance.device.json("POST", "/api/rover/mission-report", terminalReport);
      assert.equal(terminalDuplicate.status, 200);
      assert.equal(terminalDuplicate.data.duplicate, true);
      assert.equal(terminalDuplicate.data.reset_mission, true);
      assert.equal(terminalDuplicate.data.mission.status, "cancelled");
    } finally {
      if (instance) await instance.stop({ keepDb: true });
      cleanupDb(dbPath);
    }
  });
});

describe("durable mission protocol", () => {
  let rover;
  let mission;
  let resumeCommand;

  it("creates a mission from supplied geometry and starts only after v2 command acknowledgement", async () => {
    rover = await ctx.openRover("boot-v2-a");
    const route = [cones[2], cones[0], cones[2]];
    const invalid = await createMission(route.map((item, position) => (position === 1 ? { ...item, side: "middle" } : item)));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.reason, "invalid_item");
    assert.equal(invalid.data.position, 1);
    assert.equal(invalid.data.cone_id, cones[0].cone_id);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM mission").get().n, 0);

    const created = await createMission(route);
    assert.equal(created.status, 201);
    mission = created.data;
    assert.equal(mission.status, "ready");
    assert.equal(mission.course_id, TEST_COURSE.id);
    assert.equal(mission.course_name, TEST_COURSE.name);
    assert.equal(mission.waypoints.length, 3);
    assert.equal(new Set(mission.waypoints.map((waypoint) => waypoint.id)).size, 3);
    assert.deepEqual(
      mission.waypoints.map(({ cone_id, lat, lng, alt, side }) => ({ cone_id, lat, lng, alt, side })),
      route,
    );

    const commandPromise = rover.waitFor("mission-command", (data) => data.action === "start");
    const start = await command(mission.id, "start", {
      expected_plan_hash: mission.plan_hash,
      expected_occurrence_revision: mission.occurrence_revision,
    });
    assert.equal(start.status, 202);
    assert.equal(start.data.mission.status, "starting");
    const startCommand = (await commandPromise).data;
    assert.equal(startCommand.mission_id, mission.id);
    assert.deepEqual(startCommand.waypoints.map((waypoint) => waypoint.id), mission.waypoints.map((waypoint) => waypoint.id));

    const malformedAck = await report(rover, {
      report_seq: reportSeq + 1,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "command",
      command_id: startCommand.command_id,
      command_seq: startCommand.command_seq,
    });
    assert.equal(malformedAck.status, 400);

    const ack = await report(rover, {
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "command",
      command_id: startCommand.command_id,
      command_seq: startCommand.command_seq,
      command_result: "accepted",
      motion_state: "running",
      start_position: { lat: 35.0, lng: 126.0 },
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.data.mission.status, "running");
  });

  it("does not complete from an uncorrelated IDLE telemetry frame", async () => {
    let response = await telemetry({ boot_id: rover.bootId, nav_state: "NAVIGATING", fix_status: "rtk_fixed" });
    assert.equal(response.status, 200);
    response = await telemetry({ boot_id: rover.bootId, nav_state: "IDLE", fix_status: "rtk_fixed" });
    assert.equal(response.status, 200);
    assert.ok(ctx.db.prepare("SELECT COUNT(*) AS count FROM mission_telemetry WHERE mission_id=?")
      .get(mission.id).count >= 2);
    const active = await ctx.activeMission();
    assert.equal(active.id, mission.id);
    assert.equal(active.status, "running");

    const manual = await ctx.operator.json("POST", "/api/rover/control", { throttle: 10, steering: 0 });
    assert.equal(manual.status, 409, "manual motion must be gated until autonomy is held");
  });

  it("keeps the same mission id while editing and resuming only pending occurrences", async () => {
    const first = mission.waypoints[0];
    const completed = await report(rover, {
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "waypoint_completed",
      waypoint_id: first.id,
    });
    assert.equal(completed.status, 200);

    const held = await report(rover, {
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "held",
      reason: "operator_pause",
    });
    assert.equal(held.data.mission.status, "paused");
    mission = held.data.mission;
    const preEditHash = mission.plan_hash;

    const pending = mission.waypoints.filter((waypoint) => waypoint.state === "pending");
    const edited = await ctx.operator.json("PUT", `/api/missions/${mission.id}/remaining`, {
      expected_plan_hash: mission.plan_hash,
      expected_occurrence_revision: mission.occurrence_revision,
      finish_behavior: "stop",
      items: [{ waypoint_id: pending[1].id }],
    });
    assert.equal(edited.status, 200);
    mission = edited.data;
    assert.equal(mission.id, completed.data.mission.id);
    assert.equal(mission.waypoints.filter((waypoint) => waypoint.state === "completed").length, 1);
    assert.equal(mission.waypoints.filter((waypoint) => waypoint.state === "skipped").length, 0);
    assert.equal(mission.skipped_waypoint_count, 1);
    assert.equal(mission.waypoints.filter((waypoint) => waypoint.state === "pending").length, 1);

    const staleEdit = await ctx.operator.json("PUT", `/api/missions/${mission.id}/remaining`, {
      expected_plan_hash: preEditHash,
      expected_occurrence_revision: mission.occurrence_revision,
      finish_behavior: "stop",
      items: [{ waypoint_id: pending[1].id }],
    });
    assert.equal(staleEdit.status, 409);

    const commandPromise = rover.waitFor("mission-command", (data) => data.action === "resume");
    const resume = await command(mission.id, "resume", {
      expected_plan_hash: mission.plan_hash,
      expected_occurrence_revision: mission.occurrence_revision,
    });
    assert.equal(resume.status, 202);
    resumeCommand = (await commandPromise).data;
    assert.equal(resumeCommand.mission_id, mission.id);
    assert.deepEqual(resumeCommand.waypoints.map((waypoint) => waypoint.id), [pending[1].id]);
  });

  it("completes only from correlated durable reports and tolerates replay", async () => {
    let result = await report(rover, {
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "command",
      command_id: resumeCommand.command_id,
      command_seq: resumeCommand.command_seq,
      command_result: "accepted",
      motion_state: "running",
    });
    assert.equal(result.data.mission.status, "running");

    const pendingId = mission.waypoints.find((waypoint) => waypoint.state === "pending").id;
    for (let replay = 0; replay < 2; replay += 1) {
      result = await report(rover, {
        report_seq: ++reportSeq,
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        event: "waypoint_completed",
        waypoint_id: pendingId,
      });
      assert.equal(result.status, 200);
    }

    result = await report(rover, {
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "mission_completed",
      completed_waypoint_ids: [pendingId],
    });
    assert.equal(result.data.mission.status, "completed");
    assert.equal(result.data.reset_mission, true);
    const duplicateCompletion = await report(rover, {
      report_seq: reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "mission_completed",
      completed_waypoint_ids: [pendingId],
    });
    assert.equal(duplicateCompletion.status, 200);
    assert.equal(duplicateCompletion.data.duplicate, true);
    assert.equal(duplicateCompletion.data.reset_mission, true);
    assert.equal(duplicateCompletion.data.mission.status, "completed");
    assert.equal(await ctx.activeMission(), null);

    const restoredAfterCrash = await report(rover, {
      report_seq: ++reportSeq,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "state",
      motion_state: "held",
      completed_waypoint_ids: [pendingId],
    });
    assert.equal(restoredAfterCrash.status, 200);
    assert.equal(restoredAfterCrash.data.reset_mission, true);
  });

  it("rejects stale boot reports", async () => {
    const stale = await ctx.device.json("POST", "/api/rover/mission-report", {
      protocol_version: 2,
      boot_id: "old-boot",
      report_seq: 999,
      mission_id: mission.id,
      plan_hash: mission.plan_hash,
      event: "mission_completed",
    });
    assert.equal(stale.status, 409);
    await rover.close();
  });

  it("holds a moving mission when a different rover boot takes over", async () => {
    const firstBoot = await ctx.openRover("boot-restart-a");
    const created = await createMission([cones[0]]);
    assert.equal(created.status, 201);
    const nextMission = created.data;

    const commandPromise = firstBoot.waitFor("mission-command", (data) => data.action === "start");
    const start = await command(nextMission.id, "start", {
      expected_plan_hash: nextMission.plan_hash,
      expected_occurrence_revision: nextMission.occurrence_revision,
    });
    assert.equal(start.status, 202);
    const startCommand = (await commandPromise).data;
    const accepted = await report(firstBoot, {
      report_seq: ++reportSeq,
      mission_id: nextMission.id,
      plan_hash: nextMission.plan_hash,
      event: "command",
      command_id: startCommand.command_id,
      command_seq: startCommand.command_seq,
      command_result: "accepted",
      motion_state: "running",
    });
    assert.equal(accepted.data.mission.status, "running");

    const replacementBoot = await ctx.openRover("boot-restart-b");
    const bootHold = await replacementBoot.waitFor("mission-safety-hold");
    assert.equal(bootHold.data.mission_id, nextMission.id);
    assert.equal(bootHold.data.reason, "rover_rebooted");
    const active = await ctx.activeMission();
    assert.equal(active.id, nextMission.id);
    assert.equal(active.status, "interrupted");
    assert.equal(active.hold_reason, "rover_rebooted");

    const estopLogCountBefore = ctx.db.prepare(
      "SELECT COUNT(*) AS count FROM logs WHERE action='mission.v2.estop_observed'",
    ).get().count;
    const originalPrepare = ctx.db.prepare;
    let fullWaypointSelectExecutions = 0;
    ctx.db.prepare = function instrumentWaypointSelect(sql) {
      const statement = originalPrepare.call(this, sql);
      if (/^\s*SELECT\s+\*\s+FROM\s+mission_waypoint\s+WHERE\s+mission_id\s*=\s*\?/i.test(sql)) {
        const originalAll = statement.all;
        statement.all = function countWaypointSelect(...args) {
          fullWaypointSelectExecutions += 1;
          return originalAll.apply(this, args);
        };
      }
      return statement;
    };
    try {
      for (let frame = 0; frame < 3; frame += 1) {
        const estopDuringRebootHold = await telemetry({
          boot_id: replacementBoot.bootId,
          nav_state: "EMERGENCY_STOP",
        });
        assert.equal(estopDuringRebootHold.status, 200);
      }
      for (let frame = 0; frame < 3; frame += 1) {
        const manualDuringUnconfirmedHold = await ctx.operator.json("POST", "/api/rover/control", {
          throttle: 10, steering: frame,
        });
        assert.equal(manualDuringUnconfirmedHold.status, 409);
      }
      assert.equal(fullWaypointSelectExecutions, 0);
    } finally {
      delete ctx.db.prepare;
    }
    const estopLogCountAfter = ctx.db.prepare(
      "SELECT COUNT(*) AS count FROM logs WHERE action='mission.v2.estop_observed'",
    ).get().count;
    assert.equal(estopLogCountAfter - estopLogCountBefore, 1);
    const afterEstop = await ctx.activeMission();
    assert.equal(afterEstop.active_hold_id, bootHold.data.hold_id);
    assert.equal(afterEstop.hold_reason, "rover_rebooted");
    assert.equal(afterEstop.motion_confirmed_held, false);
    await telemetry({ boot_id: replacementBoot.bootId, nav_state: "IDLE" });

    const strayRunning = await report(replacementBoot, {
      report_seq: ++reportSeq,
      mission_id: nextMission.id,
      plan_hash: nextMission.plan_hash,
      event: "state",
      motion_state: "running",
      completed_waypoint_ids: [],
    });
    assert.equal(strayRunning.status, 200);
    assert.equal(strayRunning.data.mission.status, "interrupted");
    assert.equal(strayRunning.data.mission.hold_reason, "rover_rebooted");

    const restoredHold = await report(replacementBoot, {
      report_seq: ++reportSeq,
      mission_id: nextMission.id,
      plan_hash: nextMission.plan_hash,
      event: "held",
      hold_id: bootHold.data.hold_id,
      checkpoint_persisted: true,
      reason: "checkpoint_restored",
      completed_waypoint_ids: [],
    });
    assert.equal(restoredHold.data.mission.status, "paused");
    assert.equal(restoredHold.data.mission.motion_confirmed_held, true);

    const delayedRunning = await report(replacementBoot, {
      report_seq: ++reportSeq,
      mission_id: nextMission.id,
      plan_hash: nextMission.plan_hash,
      event: "state",
      motion_state: "running",
      completed_waypoint_ids: [],
    });
    assert.equal(delayedRunning.data.mission.status, "paused");
    assert.equal(delayedRunning.data.mission.hold_reason, "checkpoint_restored");

    await firstBoot.close();
    const endPromise = replacementBoot.waitFor("mission-command", (data) => data.action === "end");
    const ended = await command(nextMission.id, "end");
    assert.equal(ended.status, 202);
    assert.equal(ended.data.mission.status, "paused");
    const endCommand = (await endPromise).data;
    const endAck = await report(replacementBoot, {
      report_seq: ++reportSeq,
      mission_id: nextMission.id,
      plan_hash: nextMission.plan_hash,
      event: "command",
      command_id: endCommand.command_id,
      command_seq: endCommand.command_seq,
      command_result: "accepted",
      motion_state: "held",
    });
    assert.equal(endAck.data.mission.status, "cancelled");
    await replacementBoot.close();
  });

  it("re-adopts motion only for a reconnect from the same boot", async () => {
    const firstConnection = await ctx.openRover("boot-network-reconnect");
    const reconnectMission = (await createMission([cones[2]])).data;
    const commandPromise = firstConnection.waitFor("mission-command", (data) => data.action === "start");
    await command(reconnectMission.id, "start", {
      expected_plan_hash: reconnectMission.plan_hash,
      expected_occurrence_revision: reconnectMission.occurrence_revision,
    });
    const startCommand = (await commandPromise).data;
    let result = await report(firstConnection, {
      report_seq: ++reportSeq,
      mission_id: reconnectMission.id,
      plan_hash: reconnectMission.plan_hash,
      event: "command",
      command_id: startCommand.command_id,
      command_seq: startCommand.command_seq,
      command_result: "accepted",
      motion_state: "running",
    });
    assert.equal(result.data.mission.status, "running");

    await firstConnection.close();
    let activeMission = await waitForActiveMission((candidate) => candidate?.status === "interrupted");
    assert.equal(activeMission.hold_reason, "sse_disconnect");
    assert.equal(activeMission.motion_confirmed_held, false);

    const editWhileMotionUnconfirmed = await ctx.operator.json("PUT", `/api/missions/${reconnectMission.id}/remaining`, {
      expected_plan_hash: reconnectMission.plan_hash,
      expected_occurrence_revision: activeMission.occurrence_revision,
      finish_behavior: "stop",
      items: [{ waypoint_id: reconnectMission.waypoints[0].id }],
    });
    assert.equal(editWhileMotionUnconfirmed.status, 409);

    const secondConnection = await ctx.openRover("boot-network-reconnect");
    const manualBeforeReconcile = await ctx.operator.json("POST", "/api/rover/control", { throttle: 10, steering: 0 });
    assert.equal(manualBeforeReconcile.status, 409);

    result = await report(secondConnection, {
      report_seq: ++reportSeq,
      mission_id: reconnectMission.id,
      plan_hash: reconnectMission.plan_hash,
      event: "state",
      motion_state: "running",
      completed_waypoint_ids: [],
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.mission.status, "running");

    await secondConnection.close();
    const replacementConnection = await ctx.openRover("boot-after-network-interruption");
    const hardHold = await replacementConnection.waitFor("mission-safety-hold", (data) =>
      data.mission_id === reconnectMission.id);
    assert.equal(hardHold.data.reason, "rover_rebooted");
    activeMission = await waitForActiveMission((candidate) => candidate?.hold_reason === "rover_rebooted");
    assert.equal(activeMission.status, "interrupted");
    assert.equal(activeMission.motion_confirmed_held, false);
    const holdAck = await report(replacementConnection, {
      report_seq: ++reportSeq,
      mission_id: reconnectMission.id,
      plan_hash: reconnectMission.plan_hash,
      event: "held",
      hold_id: hardHold.data.hold_id,
      checkpoint_persisted: true,
      reason: "checkpoint_restored",
    });
    assert.equal(holdAck.data.mission.status, "paused");
    const endPromise = replacementConnection.waitFor("mission-command", (data) => data.action === "end");
    const ended = await command(reconnectMission.id, "end");
    assert.equal(ended.status, 202);
    const endCommand = (await endPromise).data;
    const endAck = await report(replacementConnection, {
      report_seq: ++reportSeq,
      mission_id: reconnectMission.id,
      plan_hash: reconnectMission.plan_hash,
      event: "command",
      command_id: endCommand.command_id,
      command_seq: endCommand.command_seq,
      command_result: "accepted",
      motion_state: "held",
    });
    assert.equal(endAck.data.mission.status, "cancelled");
    await replacementConnection.close();
  });

  it("replays only the same pending action and lets end supersede it", async () => {
    const commandRover = await ctx.openRover("boot-command-conflict");
    const conflictMission = (await createMission([cones[0]])).data;
    const staleOccurrence = await command(conflictMission.id, "start", {
      expected_plan_hash: conflictMission.plan_hash,
      expected_occurrence_revision: "0".repeat(64),
    });
    assert.equal(staleOccurrence.status, 409);
    assert.equal(staleOccurrence.data.reason, "occurrence_revision_mismatch");
    assert.equal(staleOccurrence.data.current_occurrence_revision, conflictMission.occurrence_revision);
    const staleStart = await command(conflictMission.id, "start", {
      expected_plan_hash: "0".repeat(64),
      expected_occurrence_revision: conflictMission.occurrence_revision,
    });
    assert.equal(staleStart.status, 409);
    assert.equal((await ctx.activeMission()).status, "ready");
    const startPromise = commandRover.waitFor("mission-command", (data) =>
      data.mission_id === conflictMission.id && data.action === "start");
    const start = await command(conflictMission.id, "start", {
      expected_plan_hash: conflictMission.plan_hash,
      expected_occurrence_revision: conflictMission.occurrence_revision,
    });
    const startCommand = (await startPromise).data;
    assert.equal(start.status, 202);

    const conflictingPause = await command(conflictMission.id, "pause");
    assert.equal(conflictingPause.status, 409);
    assert.equal(conflictingPause.data.reason, "command_in_progress");

    const replayPromise = commandRover.waitFor("mission-command", (data) =>
      data.command_id === startCommand.command_id);
    const replay = await command(conflictMission.id, "start", {
      expected_plan_hash: conflictMission.plan_hash,
      expected_occurrence_revision: conflictMission.occurrence_revision,
    });
    assert.equal(replay.status, 202);
    assert.equal(replay.data.replay, true);
    assert.equal((await replayPromise).data.action, "start");

    const endPromise = commandRover.waitFor("mission-command", (data) =>
      data.mission_id === conflictMission.id && data.action === "end");
    const ended = await command(conflictMission.id, "end");
    const endCommand = (await endPromise).data;
    assert.equal(ended.status, 202);
    assert.equal(ended.data.mission.status, "starting");
    const successor = await createMission([cones[2]]);
    assert.equal(successor.status, 409);
    assert.equal(successor.data.reason, "active_mission");
    const manualBeforeEndAck = await ctx.operator.json("POST", "/api/rover/control", { throttle: 10, steering: 0 });
    assert.equal(manualBeforeEndAck.status, 409);
    assert.equal(endCommand.command_seq, startCommand.command_seq + 1);
    const storedStart = ctx.db.prepare("SELECT state,reject_reason FROM mission_command WHERE id=?").get(startCommand.command_id);
    assert.deepEqual({ ...storedStart }, { state: "superseded", reject_reason: "operator_end" });
    const endAck = await report(commandRover, {
      report_seq: ++reportSeq,
      mission_id: conflictMission.id,
      plan_hash: conflictMission.plan_hash,
      event: "command",
      command_id: endCommand.command_id,
      command_seq: endCommand.command_seq,
      command_result: "accepted",
      motion_state: "held",
    });
    assert.equal(endAck.data.mission.status, "cancelled");
    await commandRover.close();
  });

  it("rejects an A to B to A rover stream takeover before replacing the current session", async () => {
    const bootA = await ctx.openRover("boot-lease-a");
    const bootB = await ctx.openRover("boot-lease-b");
    const currentPosition = await ctx.device.json("POST", "/api/rover/position", {
      boot_id: bootB.bootId, lat: 35, lng: 126,
    });
    assert.equal(currentPosition.status, 200);
    const stalePosition = await ctx.device.json("POST", "/api/rover/position", {
      boot_id: bootA.bootId, lat: 0, lng: 0,
    });
    assert.equal(stalePosition.status, 409);
    const staleA = await fetch(`${ctx.deviceUrl}/api/rover/stream?protocol_version=2&boot_id=${bootA.bootId}`, {
      headers: { Accept: "text/event-stream" },
    });
    assert.equal(staleA.status, 409);
    assert.match(await staleA.text(), /superseded rover boot session/);
    const status = await ctx.status();
    assert.equal(status.mission_protocol.boot_id, bootB.bootId);
    assert.equal(status.connected, true);
    assert.equal(status.last_position.lat, 35);
    assert.equal(status.last_position.lng, 126);
    await bootA.close();
    await bootB.close();
  });

  it("binds telemetry to the current boot and confirms E-Stop hold only from authoritative telemetry", async () => {
    const estopRover = await ctx.openRover("boot-estop-current");
    const estopMission = (await createMission([cones[0]])).data;
    const startPromise = estopRover.waitFor("mission-command", (data) => data.action === "start");
    await command(estopMission.id, "start", {
      expected_plan_hash: estopMission.plan_hash,
      expected_occurrence_revision: estopMission.occurrence_revision,
    });
    const startCommand = (await startPromise).data;
    let result = await report(estopRover, {
      report_seq: ++reportSeq,
      mission_id: estopMission.id,
      plan_hash: estopMission.plan_hash,
      event: "command",
      command_id: startCommand.command_id,
      command_seq: startCommand.command_seq,
      command_result: "accepted",
      motion_state: "running",
    });
    assert.equal(result.data.mission.status, "running");

    const staleTelemetry = await telemetry({ boot_id: "boot-lease-b", nav_state: "EMERGENCY_STOP" });
    assert.equal(staleTelemetry.status, 409);
    assert.equal((await ctx.activeMission()).status, "running");

    const stopped = await ctx.operator.json("POST", "/api/rover/stop", {});
    assert.equal(stopped.status, 200);
    let active = await ctx.activeMission();
    assert.equal(active.status, "running");
    assert.equal(active.motion_confirmed_held, false);

    result = await telemetry({ boot_id: estopRover.bootId, nav_state: "EMERGENCY_STOP" });
    assert.equal(result.status, 200);
    active = await ctx.activeMission();
    assert.equal(active.status, "interrupted");
    assert.equal(active.hold_reason, "emergency_stop");
    assert.equal(active.motion_confirmed_held, true);

    const clearEvent = estopRover.waitFor("clear-emergency");
    const clear = await ctx.operator.json("POST", "/api/rover/clear-emergency", {});
    assert.equal(clear.status, 200);
    await clearEvent;
    result = await telemetry({ boot_id: estopRover.bootId, nav_state: "PAUSED" });
    assert.equal(result.status, 200);
    assert.equal((await ctx.status()).stop_requested, true);

    result = await report(estopRover, {
      report_seq: ++reportSeq,
      mission_id: estopMission.id,
      plan_hash: estopMission.plan_hash,
      event: "held",
      motion_state: "held",
      reason: "emergency_stop_cleared",
      emergency_stop_cleared: true,
      checkpoint_persisted: false,
    });
    assert.equal(result.status, 200);
    assert.equal((await ctx.status()).stop_requested, true);

    result = await report(estopRover, {
      report_seq: ++reportSeq,
      mission_id: estopMission.id,
      plan_hash: estopMission.plan_hash,
      event: "held",
      motion_state: "held",
      reason: "checkpoint_restored",
      emergency_stop_cleared: true,
      checkpoint_persisted: true,
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.mission.status, "paused");
    assert.equal((await ctx.status()).stop_requested, false);

    const resumePromise = estopRover.waitFor("mission-command", (data) => data.action === "resume");
    const resume = await command(estopMission.id, "resume", {
      expected_plan_hash: result.data.mission.plan_hash,
      expected_occurrence_revision: result.data.mission.occurrence_revision,
    });
    assert.equal(resume.status, 202);
    await resumePromise;

    const endPromise = estopRover.waitFor("mission-command", (data) => data.action === "end");
    await command(estopMission.id, "end");
    const endCommand = (await endPromise).data;
    result = await report(estopRover, {
      report_seq: ++reportSeq,
      mission_id: estopMission.id,
      plan_hash: estopMission.plan_hash,
      event: "command",
      command_id: endCommand.command_id,
      command_seq: endCommand.command_seq,
      command_result: "accepted",
      motion_state: "held",
    });
    assert.equal(result.data.mission.status, "cancelled");
    await estopRover.close();
  });

  it("makes a failed command delivery auditable and immediately resumable", () => {
    const store = createMissionV2Store(ctx.db);
    const deliveryMission = store.createMission({
      course: TEST_COURSE,
      finishBehavior: "stop",
      items: [cones[2]],
      actor: "test",
    });
    const issued = store.issueCommand({
      missionId: deliveryMission.id,
      action: "start",
      expectedPlanHash: deliveryMission.plan_hash,
      expectedOccurrenceRevision: deliveryMission.occurrence_revision,
      actor: "test",
      targetBootId: "boot-write-failure",
    });
    const failed = store.markCommandDeliveryFailed(
      deliveryMission.id, issued.command.id, "boot-write-failure",
    );
    assert.equal(failed.status, "interrupted");
    assert.equal(failed.hold_reason, "command_delivery_failed");
    assert.equal(failed.motion_confirmed_held, false);
    assert.equal(failed.active_command_id, null);
    assert.deepEqual(
      { ...ctx.db.prepare("SELECT state,reject_reason FROM mission_command WHERE id=?").get(issued.command.id) },
      { state: "superseded", reject_reason: "command_delivery_failed" },
    );
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS n FROM mission_event
      WHERE mission_id=? AND event_type='command.delivery_failed'`).get(deliveryMission.id).n, 1);
    assert.throws(() => store.issueCommand({
      missionId: deliveryMission.id,
      action: "resume",
      expectedPlanHash: failed.plan_hash,
      expectedOccurrenceRevision: failed.occurrence_revision,
    }), (error) => error.reason === "motion_not_confirmed_held");
    const roverConfirmed = store.applyReport({
      mission_id: deliveryMission.id,
      plan_hash: deliveryMission.plan_hash,
      boot_id: "boot-write-failure",
      event: "interrupted",
      reason: "dispense_outcome_uncertain",
      active_waypoint_id: deliveryMission.waypoints[0].id,
    });
    assert.equal(roverConfirmed.status, "interrupted");
    assert.equal(roverConfirmed.hold_reason, "dispense_outcome_uncertain");
    assert.equal(roverConfirmed.motion_confirmed_held, true);
    assert.equal(roverConfirmed.waypoints[0].outcome, "dispense_outcome_uncertain");
    const edited = store.editRemaining({
      missionId: deliveryMission.id,
      expectedPlanHash: roverConfirmed.plan_hash,
      expectedOccurrenceRevision: roverConfirmed.occurrence_revision,
      items: [],
      actor: "test",
    });
    assert.equal(edited.status, "interrupted");
    assert.equal(edited.hold_reason, "route_edited");
    assert.equal(edited.motion_confirmed_held, true);
    const emptyResume = store.issueCommand({
      missionId: deliveryMission.id,
      action: "resume",
      expectedPlanHash: edited.plan_hash,
      expectedOccurrenceRevision: edited.occurrence_revision,
      actor: "test",
    });
    assert.deepEqual(JSON.parse(emptyResume.command.payload_json).waypoints, []);
    const end = store.issueCommand({ missionId: deliveryMission.id, action: "end", actor: "test" });
    const endPayload = JSON.parse(end.command.payload_json);
    const cancelled = store.applyReport({
      mission_id: deliveryMission.id,
      plan_hash: edited.plan_hash,
      boot_id: "boot-write-failure",
      event: "command",
      command_id: end.command.id,
      command_seq: endPayload.command_seq,
      command_result: "accepted",
      motion_state: "held",
    });
    assert.equal(cancelled.status, "cancelled");
  });
});

describe("mission geometry supplied by the browser", () => {
  let local;
  before(async () => { local = await startHub(); });
  after(async () => { await local.stop(); });

  const valid = () => ({
    course: { id: 12, name: "  Autocross  " },
    preset_id: 5,
    finish_behavior: "return_to_start",
    items: [
      { cone_id: 10, lat: 35.1, lng: 126.1, alt: 12.5, side: "left" },
      { cone_id: null, lat: 35.10001, lng: 126.10001, alt: null, side: "center" },
      { cone_id: 10, lat: 35.1, lng: 126.1, alt: 12.5, side: "left" },
    ],
  });

  it("rejects malformed course, preset, finish behavior, and items without creating a mission", async () => {
    const cases = [
      [{ ...valid(), course: undefined }, "invalid_course"],
      [{ ...valid(), course: { id: "12", name: "Autocross" } }, "invalid_course"],
      [{ ...valid(), course: { id: 12.5, name: "Autocross" } }, "invalid_course"],
      [{ ...valid(), course: { id: 12, name: "   " } }, "invalid_course"],
      [{ ...valid(), course: { id: 12, name: "x".repeat(101) } }, "invalid_course"],
      [{ ...valid(), preset_id: "5" }, "invalid_preset_id"],
      [{ ...valid(), finish_behavior: "loop" }, null],
      [{ ...valid(), items: [] }, null],
      [{ ...valid(), items: "1,2,3" }, null],
      [{ ...valid(), items: Array.from({ length: 1001 }, () => valid().items[0]) }, null],
    ];
    for (const [body, reason] of cases) {
      const result = await local.operator.json("POST", "/api/missions", body);
      assert.equal(result.status, 400, JSON.stringify(body).slice(0, 80));
      if (reason) assert.equal(result.data.reason, reason);
      else assert.equal(typeof result.data, "string");
    }

    const itemCases = [
      [{ lat: 91 }, /latitude/],
      [{ lng: "126" }, /longitude/],
      [{ alt: "high" }, /altitude/],
      [{ alt: 20000 }, /altitude/],
      [{ side: undefined }, /side/],
      [{ side: "middle" }, /side/],
      [{ cone_id: "10" }, /cone_id/],
      [{ cone_id: 1.5 }, /cone_id/],
    ];
    for (const [patch, message] of itemCases) {
      const body = valid();
      body.items[2] = { ...body.items[2], ...patch };
      const result = await local.operator.json("POST", "/api/missions", body);
      assert.equal(result.status, 400, JSON.stringify(patch));
      assert.equal(result.data.reason, "invalid_item");
      assert.equal(result.data.position, 2);
      assert.match(result.data.message, /^Waypoint 3: /);
      assert.match(result.data.message, message);
    }
    const nonObject = await local.operator.json("POST", "/api/missions", { ...valid(), items: [valid().items[0], 7] });
    assert.equal(nonObject.status, 400);
    assert.equal(nonObject.data.position, 1);
    assert.equal(local.db.prepare("SELECT COUNT(*) AS n FROM mission").get().n, 0);
  });

  it("stores the course identity, preset id, and supplied geometry with no course tables", async () => {
    const body = valid();
    const created = await local.operator.json("POST", "/api/missions", body);
    assert.equal(created.status, 201);
    const mission = created.data;
    assert.equal(mission.course_id, 12);
    assert.equal(mission.course_name, "Autocross");
    assert.equal(mission.preset_id, 5);
    assert.equal(mission.finish_behavior, "return_to_start");
    assert.equal(mission.protocol_version, 2);
    assert.match(mission.plan_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      mission.waypoints.map(({ cone_id, lat, lng, alt, side }) => ({ cone_id, lat, lng, alt, side })),
      body.items,
    );
    assert.deepEqual(mission.waypoints.map((waypoint) => waypoint.position), [0, 1, 2]);

    const list = await local.operator.json("GET", "/api/missions");
    assert.equal(list.status, 200);
    assert.equal(list.data.total, 1);
    assert.equal(list.data.missions[0].course_name, "Autocross");
    assert.equal(list.data.missions[0].status, "ready");
    assert.equal(list.data.missions[0].sample_count, 0);
    const detail = await local.operator.json("GET", `/api/missions/${mission.id}`);
    assert.equal(detail.data.course_name, "Autocross");
    assert.equal(detail.data.events[0].event_type, "mission.created");
    assert.deepEqual(detail.data.events[0].after, {
      course_id: 12,
      course_name: "Autocross",
      preset_id: 5,
      finish_behavior: "return_to_start",
      plan_hash: mission.plan_hash,
      waypoint_count: 3,
    });
    const samples = await local.operator.json("GET", `/api/missions/${mission.id}/telemetry`);
    assert.deepEqual(samples.data, { samples: [] });

    const tables = local.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
      ('course','cone','mission_route_preset','mission_route_preset_item','survey_point','gps_config')`).all();
    assert.deepEqual(tables, []);
    for (const table of ["mission", "mission_waypoint"]) {
      const references = local.db.prepare(`PRAGMA foreign_key_list(${table})`).all().map((row) => row.table);
      assert.ok(references.every((name) => name === "mission"), `${table} references ${references}`);
    }
  });

  it("keeps remaining occurrences by waypoint id and adds new ones from supplied geometry", async () => {
    const mission = await local.activeMission();
    const eventCount = () => local.db.prepare("SELECT COUNT(*) AS n FROM mission_event WHERE mission_id=?")
      .get(mission.id).n;
    const eventsBefore = eventCount();
    const rejected = await local.operator.json("PUT", `/api/missions/${mission.id}/remaining`, {
      expected_plan_hash: mission.plan_hash,
      expected_occurrence_revision: mission.occurrence_revision,
      items: [
        { waypoint_id: mission.waypoints[1].id },
        { cone_id: 11, lat: 35.2, lng: 126.2, alt: null, side: "right" },
        { cone_id: 12, lat: -95, lng: 126.2, alt: null, side: "right" },
      ],
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.reason, "invalid_item");
    assert.equal(rejected.data.position, 2);
    assert.equal(rejected.data.cone_id, 12);
    assert.deepEqual(await local.activeMission(), mission);
    assert.equal(eventCount(), eventsBefore);

    const unknownOccurrence = await local.operator.json("PUT", `/api/missions/${mission.id}/remaining`, {
      expected_plan_hash: mission.plan_hash,
      expected_occurrence_revision: mission.occurrence_revision,
      items: [{ waypoint_id: "not-a-waypoint" }],
    });
    assert.equal(unknownOccurrence.status, 409);

    const added = { cone_id: 11, lat: 35.10002, lng: 126.10002, alt: 3.25, side: "right" };
    const edited = await local.operator.json("PUT", `/api/missions/${mission.id}/remaining`, {
      expected_plan_hash: mission.plan_hash,
      expected_occurrence_revision: mission.occurrence_revision,
      finish_behavior: "stop",
      items: [{ waypoint_id: mission.waypoints[2].id }, added, { waypoint_id: mission.waypoints[0].id }],
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.id, mission.id);
    assert.equal(edited.data.finish_behavior, "stop");
    assert.notEqual(edited.data.plan_hash, mission.plan_hash);
    assert.equal(edited.data.skipped_waypoint_count, 1);
    const [kept, inserted, keptLast] = edited.data.waypoints;
    assert.equal(kept.id, mission.waypoints[2].id);
    assert.equal(keptLast.id, mission.waypoints[0].id);
    const { cone_id, lat, lng, alt, side } = inserted;
    assert.deepEqual({ cone_id, lat, lng, alt, side }, added);
    assert.equal(edited.data.hold_reason, "route_edited");
  });
});

describe("mission v2 state-machine regressions", () => {
  it("bounds missions to hundreds-scale routes", () => {
    const fixture = createStoreFixture();
    try {
      const oversized = Array.from({ length: 1001 }, () => ({ ...FIXTURE_POINTS[0] }));
      assert.throws(() => fixture.store.createMission({ course: FIXTURE_COURSE, items: oversized }), /1,000 waypoints/);
      const mission = fixture.create();
      assert.throws(() => fixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
        items: oversized,
      }), /Invalid remaining route/);
    } finally {
      fixture.close();
    }
  });

  it("keeps the hot-path mission summary bounded and revisioned", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.create([0, 1, 2]);
      const summary = fixture.store.activeMissionSummary();
      assert.deepEqual(Object.keys(summary).sort(), [
        "active_command_id", "active_hold_id", "course_id", "course_name", "empty_plan_mode",
        "finish_behavior", "hold_reason", "id", "motion_confirmed_held",
        "occurrence_revision", "plan_hash", "protocol_version", "status",
      ]);
      assert.equal(summary.id, mission.id);
      assert.equal(summary.course_id, FIXTURE_COURSE.id);
      assert.equal(summary.course_name, FIXTURE_COURSE.name);
      assert.equal(summary.occurrence_revision, mission.occurrence_revision);
      assert.equal(Object.hasOwn(summary, "waypoints"), false);
      summary.status = "tampered-client-copy";
      assert.equal(fixture.store.activeMissionSummary().status, "ready");
    } finally {
      fixture.close();
    }
  });

  it("keeps skipped edit history out of operational mission snapshots", () => {
    const fixture = createStoreFixture();
    try {
      let mission = fixture.create([0]);
      for (let index = 0; index < 25; index += 1) {
        mission = fixture.store.editRemaining({
          missionId: mission.id,
          expectedPlanHash: mission.plan_hash,
          expectedOccurrenceRevision: mission.occurrence_revision,
          items: fixture.items([(index + 1) % FIXTURE_POINTS.length]),
        });
        assert.equal(mission.waypoints.length, 1);
      }
      assert.equal(mission.skipped_waypoint_count, 25);
      assert.equal(fixture.store.waypointRows(mission.id).length, 1);
      assert.equal(fixture.store.waypointRows(mission.id, { includeSkipped: true }).length, 26);
      assert.equal(mission.occurrence_revision,
        fixture.store.missionPublic(mission.id).occurrence_revision);
    } finally {
      fixture.close();
    }
  });

  it("reconciles completed checkpoint ids on failed, held, and interrupted reports", () => {
    for (const event of ["waypoint_failed", "held", "interrupted"]) {
      const fixture = createStoreFixture();
      try {
        const mission = fixture.create([0, 1]);
        fixture.db.prepare("UPDATE mission SET lifecycle_state='running',status='running' WHERE id=?").run(mission.id);
        const reported = {
          mission_id: mission.id,
          plan_hash: mission.plan_hash,
          boot_id: `boot-${event}`,
          event,
          completed_waypoint_ids: [mission.waypoints[0].id],
        };
        if (event === "waypoint_failed") reported.waypoint_id = mission.waypoints[1].id;
        const after = fixture.store.applyReport(reported);
        assert.equal(after.waypoints[0].state, "completed", event);
        assert.equal(after.waypoints[0].outcome, "success", event);
      } finally {
        fixture.close();
      }
    }
  });

  it("does not let a late accepted command overwrite a newer held report", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.create([0]);
      const issued = fixture.store.issueCommand({
        missionId: mission.id, action: "start", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const payload = JSON.parse(issued.command.payload_json);
      const held = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-held",
        event: "held", reason: "operator_pause",
      });
      assert.equal(held.status, "paused");
      const replay = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-held",
        event: "command", command_id: issued.command.id, command_seq: payload.command_seq,
        command_result: "accepted", motion_state: "running",
      });
      assert.equal(replay.status, "paused");
      assert.equal(fixture.db.prepare("SELECT state FROM mission_command WHERE id=?").get(issued.command.id).state, "superseded");
    } finally {
      fixture.close();
    }
  });

  it("keeps a pending resume through its pre-command held snapshot", () => {
    const fixture = createStoreFixture();
    try {
      let mission = fixture.create([0]);
      fixture.db.prepare(`UPDATE mission SET lifecycle_state='paused',status='paused',
        hold_reason='checkpoint_restored' WHERE id=?`).run(mission.id);
      mission = fixture.store.missionPublic(mission.id);
      const resume = fixture.store.issueCommand({
        missionId: mission.id,
        action: "resume",
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const payload = JSON.parse(resume.command.payload_json);
      const observed = fixture.store.applyReport({
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        boot_id: "boot-resume-order",
        event: "state",
        motion_state: "held",
        last_command_id: "older-command",
        command_seq: payload.command_seq - 1,
        last_command_result: "accepted",
        last_command_reason: null,
      });
      assert.equal(observed.status, "resuming");
      assert.equal(observed.active_command_id, resume.command.id);
      assert.equal(fixture.db.prepare("SELECT state FROM mission_command WHERE id=?")
        .get(resume.command.id).state, "pending");
      const accepted = fixture.store.applyReport({
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        boot_id: "boot-resume-order",
        event: "command",
        command_id: resume.command.id,
        command_seq: payload.command_seq,
        command_result: "accepted",
        motion_state: "running",
      });
      assert.equal(accepted.status, "running");
      assert.equal(accepted.active_command_id, null);
      const pause = fixture.store.issueCommand({ missionId: mission.id, action: "pause" });
      const pausePayload = JSON.parse(pause.command.payload_json);
      const recovered = fixture.store.applyReport({
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        boot_id: "boot-resume-order",
        event: "state",
        motion_state: "held",
        last_command_id: pause.command.id,
        command_seq: pausePayload.command_seq,
        last_command_result: "accepted",
        last_command_reason: null,
      });
      assert.equal(recovered.status, "paused");
      assert.equal(recovered.active_command_id, null);
      assert.equal(fixture.db.prepare("SELECT state FROM mission_command WHERE id=?")
        .get(pause.command.id).state, "accepted");
    } finally {
      fixture.close();
    }
  });

  it("recovers a rejected start checkpoint to the direct-report ready state", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.create([0]);
      const start = fixture.store.issueCommand({
        missionId: mission.id,
        action: "start",
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const payload = JSON.parse(start.command.payload_json);
      const recovered = fixture.store.applyReport({
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        boot_id: "boot-start-rejected",
        event: "state",
        motion_state: "held",
        last_command_id: start.command.id,
        command_seq: payload.command_seq,
        last_command_result: "rejected",
        last_command_reason: "preflight_rejected",
      });
      assert.equal(recovered.status, "ready");
      assert.equal(recovered.active_command_id, null);
      assert.deepEqual(
        { ...fixture.db.prepare("SELECT state,reject_reason FROM mission_command WHERE id=?").get(start.command.id) },
        { state: "rejected", reject_reason: "preflight_rejected" },
      );
    } finally {
      fixture.close();
    }
  });

  it("keeps terminal state immutable when a pending command result arrives late", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.create([0]);
      const issued = fixture.store.issueCommand({
        missionId: mission.id, action: "start", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const payload = JSON.parse(issued.command.payload_json);
      const completed = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-terminal",
        event: "mission_completed", completed_waypoint_ids: [mission.waypoints[0].id],
      });
      assert.equal(completed.status, "completed");
      const late = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-terminal",
        event: "command", command_id: issued.command.id, command_seq: payload.command_seq,
        command_result: "accepted", motion_state: "running",
      });
      assert.equal(late.status, "completed");
      assert.equal(late.ended_at, completed.ended_at);
    } finally {
      fixture.close();
    }
  });

  it("does not roll a confirmed held pause back to running when pause is rejected", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.create([0]);
      fixture.db.prepare("UPDATE mission SET lifecycle_state='running',status='running' WHERE id=?").run(mission.id);
      const issued = fixture.store.issueCommand({ missionId: mission.id, action: "pause" });
      const payload = JSON.parse(issued.command.payload_json);
      assert.throws(() => fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-pause",
        event: "command", command_id: issued.command.id, command_seq: payload.command_seq,
        command_result: "accepted", motion_state: "running",
      }), (error) => error.reason === "pause_motion_not_held");
      const rejected = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-pause",
        event: "command", command_id: issued.command.id, command_seq: payload.command_seq,
        command_result: "rejected", motion_state: "held", reason: "already_held",
      });
      assert.equal(rejected.status, "paused");
      assert.equal(rejected.motion_confirmed_held, true);
    } finally {
      fixture.close();
    }
  });

  it("does not label a rejected start as safely ready when the rover reports motion", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.create([0]);
      const issued = fixture.store.issueCommand({
        missionId: mission.id, action: "start", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const payload = JSON.parse(issued.command.payload_json);
      const rejected = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-start-reject",
        event: "command", command_id: issued.command.id, command_seq: payload.command_seq,
        command_result: "rejected", motion_state: "running", reason: "late_failure",
      });
      assert.equal(rejected.status, "interrupted");
      assert.equal(rejected.motion_confirmed_held, false);
      assert.throws(() => fixture.store.issueCommand({
        missionId: mission.id, action: "resume", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: rejected.occurrence_revision,
      }), (error) => error.reason === "motion_not_confirmed_held");
    } finally {
      fixture.close();
    }
  });

  it("accepts only explicit return-only or uncertainty-resolved empty plans", () => {
    const fixture = createStoreFixture();
    try {
      let mission = fixture.create([0]);
      assert.throws(() => fixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
        finishBehavior: "stop",
        items: [],
      }), (error) => error.reason === "empty_remaining_plan");
      const beforeReturnOnly = mission;
      assert.throws(() => fixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
        finishBehavior: "return_to_start",
        items: [],
      }), (error) => error.reason === "return_start_unavailable");
      const afterRejectedReturnOnly = fixture.store.missionPublic(mission.id);
      assert.equal(afterRejectedReturnOnly.plan_hash, beforeReturnOnly.plan_hash);
      assert.equal(afterRejectedReturnOnly.empty_plan_mode, null);
      assert.equal(afterRejectedReturnOnly.waypoints[0].state, "pending");
      fixture.db.prepare("UPDATE mission SET start_lat=35,start_lng=126 WHERE id=?").run(mission.id);
      mission = fixture.store.missionPublic(mission.id);
      mission = fixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
        finishBehavior: "return_to_start",
        items: [],
      });
      assert.equal(mission.empty_plan_mode, "return_only");
      const start = fixture.store.issueCommand({
        missionId: mission.id, action: "start", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      assert.deepEqual(JSON.parse(start.command.payload_json).waypoints, []);
    } finally {
      fixture.close();
    }

    const uncertainFixture = createStoreFixture();
    try {
      let mission = uncertainFixture.create([0, 1]);
      uncertainFixture.db.prepare("UPDATE mission SET lifecycle_state='running',status='running' WHERE id=?").run(mission.id);
      mission = uncertainFixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-uncertain",
        event: "held", reason: "dispense_outcome_uncertain",
        motion_state: "dispense_uncertain",
        active_waypoint_id: mission.waypoints[0].id,
      });
      assert.equal(mission.waypoints[0].outcome, "dispense_outcome_uncertain");
      assert.throws(() => uncertainFixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
        finishBehavior: "stop",
        items: [],
      }), (error) => error.reason === "empty_remaining_plan");
      mission = uncertainFixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-uncertain",
        event: "interrupted", reason: "dispense_outcome_uncertain",
        active_waypoint_id: mission.waypoints[1].id,
      });
      mission = uncertainFixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
        finishBehavior: "stop",
        items: [],
      });
      assert.equal(mission.empty_plan_mode, "uncertainty_resolved");
      const resume = uncertainFixture.store.issueCommand({
        missionId: mission.id, action: "resume", expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      assert.deepEqual(JSON.parse(resume.command.payload_json).waypoints, []);
    } finally {
      uncertainFixture.close();
    }
  });

  it("uses the occurrence revision as a value-based conditional write", () => {
    const fixture = createStoreFixture();
    try {
      let mission = fixture.create([0]);
      const staleOccurrenceRevision = mission.occurrence_revision;
      mission = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-revision",
        event: "state", motion_state: "held", completed_waypoint_ids: [],
      });
      assert.throws(() => fixture.store.editRemaining({
        missionId: mission.id,
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: staleOccurrenceRevision,
        items: [{ waypoint_id: mission.waypoints[0].id }],
      }), (error) => error.reason === "occurrence_revision_mismatch");
    } finally {
      fixture.close();
    }
  });

  it("keeps end active until ACK and makes a failed end delivery authoritative", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.create([0]);
      const end = fixture.store.issueCommand({ missionId: mission.id, action: "end" });
      assert.equal(end.mission.status, "ready");
      assert.equal(end.mission.active_command_id, end.command.id);
      assert.throws(() => fixture.create([1]), (error) => error.reason === "active_mission");
      const endPayload = JSON.parse(end.command.payload_json);
      assert.throws(() => fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-end",
        event: "command", command_id: end.command.id, command_seq: endPayload.command_seq,
        command_result: "accepted", motion_state: "running",
      }), (error) => error.reason === "end_motion_not_held");
      assert.equal(fixture.store.missionPublic(mission.id).active_command_id, end.command.id);
      assert.equal(fixture.db.prepare("SELECT state FROM mission_command WHERE id=?").get(end.command.id).state, "pending");
      const failed = fixture.store.markCommandDeliveryFailed(mission.id, end.command.id, "boot-end");
      assert.equal(failed.status, "interrupted");
      assert.equal(failed.active_command_id, null);
      assert.deepEqual(
        { ...fixture.db.prepare("SELECT state,reject_reason FROM mission_command WHERE id=?").get(end.command.id) },
        { state: "superseded", reject_reason: "command_delivery_failed" },
      );
    } finally {
      fixture.close();
    }
  });

  it("preserves a pending end when either reboot-hold ACK arrives first", () => {
    for (const event of ["held", "interrupted"]) {
      const fixture = createStoreFixture();
      try {
        fixture.store.claimRoverBootSession(`${event}-boot-a`);
        fixture.store.claimRoverBootSession(`${event}-boot-b`);
        const mission = fixture.create([0]);
        fixture.db.prepare(`UPDATE mission SET lifecycle_state='running',status='running',
          last_rover_boot_id=? WHERE id=?`).run(`${event}-boot-a`, mission.id);
        const held = fixture.store.reconcileRoverBoot(`${event}-boot-b`);
        const end = fixture.store.issueCommand({ missionId: mission.id, action: "end" });
        const endPayload = JSON.parse(end.command.payload_json);
        const holdAck = fixture.store.applyReport({
          mission_id: mission.id,
          plan_hash: mission.plan_hash,
          boot_id: `${event}-boot-b`,
          event,
          hold_id: held.active_hold_id,
          checkpoint_persisted: true,
          reason: "checkpoint_restored",
        });
        assert.equal(holdAck.status, "interrupted", event);
        assert.equal(holdAck.active_hold_id, null, event);
        assert.equal(holdAck.active_command_id, end.command.id, event);
        assert.equal(holdAck.motion_confirmed_held, true, event);
        assert.equal(fixture.db.prepare("SELECT state FROM mission_command WHERE id=?")
          .get(end.command.id).state, "pending", event);
        const terminal = fixture.store.applyReport({
          mission_id: mission.id,
          plan_hash: mission.plan_hash,
          boot_id: `${event}-boot-b`,
          event: "command",
          command_id: end.command.id,
          command_seq: endPayload.command_seq,
          command_result: "accepted",
          motion_state: "held",
        });
        assert.equal(terminal.status, "cancelled", event);
        assert.equal(terminal.active_command_id, null, event);
      } finally {
        fixture.close();
      }
    }
  });

  it("retires a pending command atomically when completion becomes terminal", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.create([0]);
      const start = fixture.store.issueCommand({
        missionId: mission.id,
        action: "start",
        expectedPlanHash: mission.plan_hash,
        expectedOccurrenceRevision: mission.occurrence_revision,
      });
      const completed = fixture.store.applyReport({
        mission_id: mission.id,
        plan_hash: mission.plan_hash,
        boot_id: "boot-completion-interleaving",
        event: "mission_completed",
        completed_waypoint_ids: [mission.waypoints[0].id],
      });
      assert.equal(completed.status, "completed");
      assert.equal(completed.active_command_id, null);
      assert.deepEqual(
        { ...fixture.db.prepare("SELECT state,reject_reason FROM mission_command WHERE id=?").get(start.command.id) },
        { state: "superseded", reject_reason: "mission_completed" },
      );
      assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM mission_command WHERE state='pending'")
        .get().n, 0);
    } finally {
      fixture.close();
    }
  });

  it("persists boot generations and allows a correlated end to terminate a reboot hold", () => {
    const fixture = createStoreFixture();
    try {
      assert.equal(fixture.store.claimRoverBootSession("boot-a").accepted, true);
      assert.equal(fixture.store.claimRoverBootSession("boot-b").accepted, true);
      assert.equal(fixture.store.claimRoverBootSession("boot-a").reason, "stale_boot_session");
      const mission = fixture.create([0]);
      fixture.db.prepare(`UPDATE mission SET lifecycle_state='running',status='running',
        last_rover_boot_id='boot-a' WHERE id=?`).run(mission.id);
      const held = fixture.store.reconcileRoverBoot("boot-b");
      assert.equal(held.motion_confirmed_held, false);
      assert.ok(held.active_hold_id);
      assert.throws(() => fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-b",
        event: "waypoint_failed", waypoint_id: mission.waypoints[0].id,
      }), (error) => error.reason === "safety_hold_pending");
      const end = fixture.store.issueCommand({ missionId: mission.id, action: "end" });
      assert.equal(end.mission.active_hold_id, held.active_hold_id);
      assert.equal(end.mission.hold_reason, "rover_rebooted");
      const payload = JSON.parse(end.command.payload_json);
      const acknowledged = fixture.store.applyReport({
        mission_id: mission.id, plan_hash: mission.plan_hash, boot_id: "boot-b",
        event: "command", command_id: end.command.id, command_seq: payload.command_seq,
        command_result: "accepted", motion_state: "held",
      });
      assert.equal(acknowledged.status, "cancelled");
      assert.equal(acknowledged.active_hold_id, null);
      assert.equal(acknowledged.active_command_id, null);
    } finally {
      fixture.close();
    }
  });

  it("persists report high-water across store recreation and advances it atomically", () => {
    const fixture = createStoreFixture();
    try {
      const marker = fixture.db.prepare("INSERT INTO hub_config (key,value,updated_at) VALUES (?,'1',0)");
      const markerCount = (key) => fixture.db.prepare("SELECT COUNT(*) AS n FROM hub_config WHERE key=?").get(key).n;
      assert.equal(fixture.store.claimRoverBootSession("boot-report-durable").last_report_seq, -1);
      let applied = 0;
      const first = fixture.store.processRoverReport("boot-report-durable", 7, () => {
        applied += 1;
        marker.run("applied");
        return "first";
      });
      assert.deepEqual(first, { duplicate: false, last_report_seq: 7, value: "first" });

      const restartedStore = createMissionV2Store(fixture.db);
      assert.equal(restartedStore.claimRoverBootSession("boot-report-durable").last_report_seq, 7);
      assert.deepEqual(restartedStore.processRoverReport("boot-report-durable", 7, () => {
        applied += 1;
      }), { duplicate: true, last_report_seq: 7, value: null });
      assert.equal(applied, 1);

      assert.throws(() => restartedStore.processRoverReport("boot-report-durable", 8, () => {
        marker.run("rolled-back");
        throw new Error("apply failed");
      }), /apply failed/);
      assert.equal(fixture.db.prepare("SELECT last_report_seq FROM rover_boot_session WHERE boot_id=?")
        .get("boot-report-durable").last_report_seq, 7);
      assert.equal(markerCount("applied"), 1);
      assert.equal(markerCount("rolled-back"), 0);
      assert.equal(restartedStore.processRoverReport("boot-report-durable", 8, () => "retry").value, "retry");

      const tableSql = fixture.db.prepare(`SELECT sql FROM sqlite_master
        WHERE type='table' AND name='rover_boot_session'`).get().sql.replace(/\s+/g, "").toLowerCase();
      assert.match(tableSql, /check\(last_report_seqbetween-1and9007199254740991\)/);
      fixture.db.pragma("ignore_check_constraints = ON");
      fixture.db.prepare("UPDATE rover_boot_session SET last_report_seq=? WHERE boot_id=?")
        .run(Number.MAX_SAFE_INTEGER + 1, "boot-report-durable");
      fixture.db.pragma("ignore_check_constraints = OFF");
      assert.equal(restartedStore.claimRoverBootSession("boot-report-durable").reason,
        "invalid_report_sequence");
    } finally {
      fixture.close();
    }
  });

  it("rehydrates mission safety authority if the report high-water write rolls back", () => {
    const fixture = createStoreFixture();
    try {
      const bootId = "boot-report-cache-rollback";
      fixture.store.claimRoverBootSession(bootId);
      const mission = fixture.create([0]);
      fixture.db.prepare("UPDATE mission SET lifecycle_state='running',status='running' WHERE id=?")
        .run(mission.id);
      fixture.store.missionPublic(mission.id);
      fixture.db.exec(`CREATE TRIGGER fail_report_high_water
        BEFORE UPDATE OF last_report_seq ON rover_boot_session
        BEGIN SELECT RAISE(ABORT, 'injected report high-water failure'); END`);
      assert.throws(() => fixture.store.processRoverReport(bootId, 1, () =>
        fixture.store.applyReport({
          mission_id: mission.id,
          plan_hash: mission.plan_hash,
          boot_id: bootId,
          event: "held",
          reason: "stale_held",
        })), /injected report high-water failure/);
      assert.equal(fixture.db.prepare("SELECT lifecycle_state FROM mission WHERE id=?")
        .get(mission.id).lifecycle_state, "running");
      const summary = fixture.store.activeMissionSummary();
      assert.equal(summary.status, "running");
      assert.equal(summary.motion_confirmed_held, false);
      assert.equal(fixture.db.prepare("SELECT last_report_seq FROM rover_boot_session WHERE boot_id=?")
        .get(bootId).last_report_seq, -1);
    } finally {
      fixture.close();
    }
  });

  it("preserves and retargets a pending end across interruptions and rover reboot", () => {
    for (const event of ["held", "interrupted"]) {
      const fixture = createStoreFixture();
      try {
        fixture.store.claimRoverBootSession(`${event}-end-boot-a`);
        const mission = fixture.create([0]);
        fixture.db.prepare(`UPDATE mission SET lifecycle_state='running',status='running',last_rover_boot_id=?
          WHERE id=?`).run(`${event}-end-boot-a`, mission.id);
        const end = fixture.store.issueCommand({
          missionId: mission.id,
          action: "end",
          targetBootId: `${event}-end-boot-a`,
        });
        const interrupted = fixture.store.markInterrupted(mission.id, "sse_disconnect", `${event}-end-boot-a`);
        assert.equal(interrupted.active_command_id, end.command.id);
        const reported = fixture.store.applyReport({
          mission_id: mission.id,
          plan_hash: mission.plan_hash,
          boot_id: `${event}-end-boot-a`,
          event,
          reason: "operator_hold",
        });
        assert.equal(reported.active_command_id, end.command.id, event);
        assert.equal(fixture.db.prepare("SELECT state FROM mission_command WHERE id=?")
          .get(end.command.id).state, "pending", event);

        fixture.store.claimRoverBootSession(`${event}-end-boot-b`);
        const rebooted = fixture.store.reconcileRoverBoot(`${event}-end-boot-b`);
        assert.equal(rebooted.active_command_id, end.command.id, event);
        assert.ok(rebooted.active_hold_id, event);
        const retargeted = fixture.db.prepare("SELECT rover_boot_id,payload_json,state FROM mission_command WHERE id=?")
          .get(end.command.id);
        assert.equal(retargeted.rover_boot_id, `${event}-end-boot-b`, event);
        assert.equal(JSON.parse(retargeted.payload_json).target_boot_id, `${event}-end-boot-b`, event);
        assert.equal(retargeted.state, "pending", event);

        const payload = JSON.parse(retargeted.payload_json);
        const terminal = fixture.store.applyReport({
          mission_id: mission.id,
          plan_hash: mission.plan_hash,
          boot_id: `${event}-end-boot-b`,
          event: "command",
          command_id: end.command.id,
          command_seq: payload.command_seq,
          command_result: "accepted",
          motion_state: "held",
        });
        assert.equal(terminal.status, "cancelled", event);
      } finally {
        fixture.close();
      }
    }
  });

  it("retargets an offline pending end with no boot target on reconnect", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.create([0]);
      fixture.db.prepare(`UPDATE mission SET lifecycle_state='running',status='running',
        last_rover_boot_id='boot-before-hub-restart' WHERE id=?`).run(mission.id);
      const end = fixture.store.issueCommand({
        missionId: mission.id,
        action: "end",
        targetBootId: null,
      });
      assert.equal(JSON.parse(end.command.payload_json).target_boot_id, null);
      fixture.store.claimRoverBootSession("boot-after-hub-restart");
      const reconciled = fixture.store.reconcileRoverBoot("boot-after-hub-restart");
      assert.equal(reconciled.active_command_id, end.command.id);
      const retargeted = fixture.db.prepare("SELECT rover_boot_id,payload_json,state FROM mission_command WHERE id=?")
        .get(end.command.id);
      assert.equal(retargeted.rover_boot_id, "boot-after-hub-restart");
      assert.equal(JSON.parse(retargeted.payload_json).target_boot_id, "boot-after-hub-restart");
      assert.equal(retargeted.state, "pending");
    } finally {
      fixture.close();
    }
  });

  it("enforces one open mission in the schema itself", () => {
    const fixture = createStoreFixture();
    try {
      const mission = fixture.create([0]);
      assert.throws(() => fixture.db.prepare(`INSERT INTO mission
        (course_id,course_name,created_at,updated_at,lifecycle_state,status,finish_behavior,plan_hash,protocol_version)
        VALUES (1,'x',0,0,'paused','paused','stop',?,2)`).run(mission.plan_hash), /UNIQUE/);
    } finally {
      fixture.close();
    }
  });
});
