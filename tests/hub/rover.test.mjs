import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeHeaderWords } from "../../rover/hub/server/actor.mjs";
import {
  TEST_COURSE,
  cleanupDb,
  coneItems,
  openSse,
  startHub,
  tmpDbPath,
  waitForCondition,
} from "./helpers.mjs";

const ALLOWED_ORIGIN = "https://console.example.org";
const OTHER_ALLOWED_ORIGIN = "http://localhost:5173";

let ctx;

before(async () => {
  ctx = await startHub({ allowedOrigins: [`${ALLOWED_ORIGIN}/`, OTHER_ALLOWED_ORIGIN] });
});

after(async () => {
  await ctx.stop();
});

// Runs fn against a hub of its own so its in-memory rover state cannot leak.
async function withHub(fn, options = {}) {
  const local = await startHub(options);
  try {
    await fn(local);
  } finally {
    await local.stop();
  }
}

// Creates a mission, starts it on the given rover, and acknowledges the start.
async function runningMission(local, rover, items = coneItems([[35.0, 126.0, "left", 1]])) {
  const mission = (await local.operator.json("POST", "/api/missions", { course: TEST_COURSE, items })).data;
  const startEvent = rover.waitFor("mission-command", (data) => data.action === "start");
  const start = await local.operator.json("POST", `/api/missions/${mission.id}/start`, {
    expected_plan_hash: mission.plan_hash,
    expected_occurrence_revision: mission.occurrence_revision,
  });
  assert.equal(start.status, 202);
  const command = (await startEvent).data;
  const ack = await local.device.json("POST", "/api/rover/mission-report", {
    protocol_version: 2,
    boot_id: rover.bootId,
    report_seq: 1,
    mission_id: mission.id,
    plan_hash: mission.plan_hash,
    event: "command",
    command_id: command.command_id,
    command_seq: command.command_seq,
    command_result: "accepted",
    motion_state: "running",
  });
  assert.equal(ack.data.mission.status, "running");
  return ack.data.mission;
}

describe("hub apps", () => {
  it("serves /api/health on both apps", async () => {
    for (const client of [ctx.device, ctx.operator]) {
      const res = await client.get("/api/health");
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "ok");
    }
  });

  it("keeps device routes off the operator app", async () => {
    const stream = await ctx.operator.get("/api/rover/stream?protocol_version=2&boot_id=browser");
    assert.equal(stream.status, 404);
    await stream.body?.cancel();
    for (const path of [
      "/api/rover/position", "/api/rover/telemetry", "/api/rover/mission-report",
      "/api/rover/waypoint_reached", "/api/rover/waypoint_skipped", "/api/rover/spray_result",
      "/api/rover/antenna_calibration_result", "/api/rover/wheel_calibration_result", "/api/rover/logs",
    ]) {
      const res = await ctx.operator.json("POST", path, { lat: 35, lng: 126, index: 0, entries: [] });
      assert.equal(res.status, 404, `operator POST ${path}`);
    }
  });

  it("keeps operator routes off the device app", async () => {
    for (const [method, path] of [
      ["GET", "/api/rover/status"], ["GET", "/api/events"], ["GET", "/api/rover/ntrip-source"],
      ["PUT", "/api/rover/ntrip-source"], ["PUT", "/api/rover/ntrip-username"],
      ["GET", "/api/rover/logs"], ["POST", "/api/rover/logs/fetch"],
      ["POST", "/api/rover/request"], ["POST", "/api/rover/stop"], ["POST", "/api/rover/clear-emergency"],
      ["POST", "/api/rover/control"], ["POST", "/api/rover/pump"], ["POST", "/api/rover/pump-duration"],
      ["POST", "/api/rover/nav-lights"], ["POST", "/api/rover/led-brightness"],
      ["POST", "/api/rover/calibrate-battery"], ["POST", "/api/rover/calibrate-antenna"],
      ["POST", "/api/rover/set-antenna-offset"], ["POST", "/api/rover/calibrate-wheels"],
      ["POST", "/api/rover/reset-wheel-cal"], ["GET", "/api/missions"], ["GET", "/api/missions/active"],
      ["POST", "/api/missions"], ["GET", "/api/missions/1"], ["GET", "/api/missions/1/telemetry"],
      ["PUT", "/api/missions/1/remaining"], ["POST", "/api/missions/1/start"],
    ]) {
      const res = await ctx.device.json(method, path, method === "GET" ? undefined : {});
      assert.equal(res.status, 404, `device ${method} ${path}`);
    }
  });

  it("does not serve the removed legacy, GPS receiver, base-station, and preset routes", async () => {
    for (const [method, path] of [
      ["POST", "/api/rover/execute"], ["POST", "/api/rover/pause"], ["POST", "/api/rover/resume"],
      ["POST", "/api/rover/end-mission"], ["GET", "/api/gps/config"], ["GET", "/api/gps/survey-points"],
      ["GET", "/api/courses/1/mission-presets"],
    ]) {
      const res = await ctx.operator.json(method, path, method === "GET" ? undefined : {});
      assert.equal(res.status, 404, `operator ${method} ${path}`);
    }
    for (const path of ["/api/rover/base/rtcm", "/api/rover/base/survey-result"]) {
      assert.equal((await ctx.device.json("POST", path, { data: "AAAA" })).status, 404, `device ${path}`);
    }
  });

  it("answers malformed JSON with 400", async () => {
    const res = await fetch(`${ctx.operatorUrl}/api/rover/pump`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal(await res.text(), "Invalid JSON body.");
  });

  it("creates the database directory and runs SQLite in WAL mode", () => {
    assert.equal(ctx.db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(ctx.db.pragma("foreign_keys", { simple: true }), 1);
  });
});

describe("CORS on the operator app", () => {
  it("echoes an allowed origin with Vary: Origin", async () => {
    for (const origin of [ALLOWED_ORIGIN, OTHER_ALLOWED_ORIGIN]) {
      const res = await ctx.operator.get("/api/rover/status", { headers: { Origin: origin } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), origin);
      assert.match(res.headers.get("vary") || "", /Origin/);
      assert.equal(res.headers.get("access-control-allow-credentials"), null);
      await res.body?.cancel();
    }
  });

  it("refuses a disallowed origin without CORS headers", async () => {
    for (const origin of ["https://evil.example", `${ALLOWED_ORIGIN}:8443`, "null"]) {
      const res = await ctx.operator.json("POST", "/api/rover/stop", {}, { headers: { Origin: origin } });
      assert.equal(res.status, 403, origin);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    }
    const logs = ctx.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE action='rover.stop'").get().n;
    assert.equal(logs, 0, "a refused origin must not reach the route");
  });

  it("serves requests without Origin and adds no CORS headers", async () => {
    const res = await ctx.operator.get("/api/rover/status");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    await res.body?.cancel();
  });

  it("answers an allowed preflight with 204 and the allowed methods and headers", async () => {
    const res = await fetch(`${ctx.operatorUrl}/api/missions/1/remaining`, {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    const methods = res.headers.get("access-control-allow-methods").split(",").map((value) => value.trim());
    assert.deepEqual(methods.sort(), ["DELETE", "GET", "PATCH", "POST", "PUT"]);
    assert.equal(res.headers.get("access-control-allow-headers"), "Content-Type");
    assert.ok(Number(res.headers.get("access-control-max-age")) > 0);
    assert.equal(res.headers.get("access-control-allow-private-network"), null);
    assert.match(res.headers.get("vary") || "", /Origin/);
  });

  it("grants Chrome private network access when the preflight asks for it", async () => {
    const res = await fetch(`${ctx.operatorUrl}/api/rover/status`, {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-private-network"), "true");
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
  });

  it("refuses a preflight from a disallowed origin", async () => {
    const res = await fetch(`${ctx.operatorUrl}/api/rover/status`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(res.status, 403);
    for (const header of [
      "access-control-allow-origin", "access-control-allow-methods",
      "access-control-allow-headers", "access-control-allow-private-network",
    ]) {
      assert.equal(res.headers.get(header), null, header);
    }
  });

  it("streams operator events cross-origin to an allowed origin", async () => {
    const events = await openSse(`${ctx.operatorUrl}/api/events`, {
      headers: { Origin: ALLOWED_ORIGIN },
      readyEvent: "init",
    });
    try {
      assert.equal(events.response.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
      assert.match(events.response.headers.get("content-type"), /^text\/event-stream/);
      const status = events.waitFor("rover:status", (data) => data.pump_run_duration === 4.5);
      assert.equal((await ctx.operator.json("POST", "/api/rover/pump-duration", { seconds: 4.5 })).status, 200);
      assert.equal((await status).data.device.id, "rover-test");
    } finally {
      await events.close();
    }
    const refused = await fetch(`${ctx.operatorUrl}/api/events`, { headers: { Origin: "https://evil.example" } });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get("access-control-allow-origin"), null);
  });

  it("adds no CORS to the device app", async () => {
    const res = await ctx.device.get("/api/health", { headers: { Origin: ALLOWED_ORIGIN } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    await res.body?.cancel();
  });

  it("rejects a malformed allowed-origin configuration", async () => {
    await assert.rejects(startHub({ allowedOrigins: ["console.example.org"] }), /Invalid allowed origin/);
    await assert.rejects(startHub({ allowedOrigins: "https://console.example.org" }), /must be an array/);
  });
});

describe("audit actor from tailscale serve identity headers", () => {
  it("labels missions and logs with the Tailscale user", async () => {
    await withHub(async (local) => {
      const created = await local.operator.json("POST", "/api/missions", {
        course: TEST_COURSE,
        items: coneItems([[35, 126]]),
      }, {
        headers: {
          "Tailscale-User-Login": "alice@example.com",
          "Tailscale-User-Name": "=?utf-8?q?Ferris_B=C3=BCller?=",
        },
      });
      assert.equal(created.status, 201);
      assert.equal(created.data.actor, "Ferris Büller <alice@example.com>");
      const log = local.db.prepare("SELECT actor, actor_login, target FROM logs WHERE action='mission.v2.create'").get();
      assert.deepEqual({ ...log }, {
        actor: "Ferris Büller <alice@example.com>",
        actor_login: "alice@example.com",
        target: TEST_COURSE.name,
      });
      const event = local.db.prepare("SELECT actor FROM mission_event WHERE event_type='mission.created'").get();
      assert.equal(event.actor, "Ferris Büller <alice@example.com>");

      const end = await local.operator.json("POST", `/api/missions/${created.data.id}/end`, {});
      assert.equal(end.status, 202);
      const command = local.db.prepare("SELECT actor FROM mission_command WHERE mission_id=?").get(created.data.id);
      assert.equal(command.actor, "tailnet");
      const endLog = local.db.prepare("SELECT actor, actor_login FROM logs WHERE action='mission.v2.end'").get();
      assert.deepEqual({ ...endLog }, { actor: "tailnet", actor_login: null });
    });
  });

  it("labels device reports as the rover", async () => {
    await withHub(async (local) => {
      const res = await local.device.json("POST", "/api/rover/waypoint_skipped", { index: 3 }, {
        headers: { "Tailscale-User-Login": "spoofed@example.com" },
      });
      assert.equal(res.status, 200);
      const log = local.db.prepare("SELECT actor, actor_login FROM logs WHERE action='rover.waypoint_skipped'").get();
      assert.deepEqual({ ...log }, { actor: "rover", actor_login: null });
    });
  });

  it("decodes RFC 2047 encoded words and keeps plain text", () => {
    assert.equal(decodeHeaderWords("Plain Name"), "Plain Name");
    assert.equal(decodeHeaderWords("=?utf-8?q?Ferris_B=C3=BCller?="), "Ferris Büller");
    assert.equal(decodeHeaderWords("=?UTF-8?B?7ZWc6riAIOydtOumhA==?="), "한글 이름");
    assert.equal(decodeHeaderWords("=?utf-8?q?A?= =?utf-8?q?B?="), "AB");
    assert.equal(decodeHeaderWords("=?x-unknown?q?abc?="), "=?x-unknown?q?abc?=");
  });
});

describe("rover position (device)", () => {
  it("accepts a position without any device secret and ignores secret headers", async () => {
    const res = await ctx.device.json("POST", "/api/rover/position", { lat: 35.292, lng: 126.574 }, {
      headers: { "X-Internal-Service": "anything", "X-Rover-Secret": "anything" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { lat: 35.292, lng: 126.574, alt: null });
  });

  it("accepts and echoes altitude", async () => {
    const res = await ctx.device.json("POST", "/api/rover/position", { lat: 35.292, lng: 126.574, alt: 36.7 });
    assert.equal(res.status, 200);
    assert.equal(res.data.alt, 36.7);
  });

  it("rejects invalid coordinates and altitude", async () => {
    assert.equal((await ctx.device.json("POST", "/api/rover/position", { lat: 91, lng: 0 })).status, 400);
    assert.equal((await ctx.device.json("POST", "/api/rover/position", { lat: 35, lng: 126, alt: "high" })).status, 400);
    assert.equal((await ctx.device.json("POST", "/api/rover/position", {})).status, 400);
  });

  it("broadcasts the live marker with source rover", async () => {
    const events = await ctx.openEvents();
    try {
      const live = events.waitFor("rover", (data) => data.lat === 37.1);
      await ctx.device.json("POST", "/api/rover/position", { lat: 37.1, lng: 127.9, alt: 12 });
      assert.deepEqual((await live).data, { lat: 37.1, lng: 127.9, alt: 12, source: "rover" });
    } finally {
      await events.close();
    }
  });
});

describe("cone capture (POST /api/rover/request)", () => {
  it("returns 503 when the rover is not connected", async () => {
    await withHub(async (local) => {
      const res = await local.operator.json("POST", "/api/rover/request");
      assert.equal(res.status, 503);
      assert.equal(res.data, "The rover is not connected.");
    });
  });

  it("asks the rover and returns the answered position", async () => {
    await withHub(async (local) => {
      const rover = await local.openRover("boot-capture");
      const pending = local.operator.json("POST", "/api/rover/request");
      const request = await rover.waitFor("request-position");
      assert.ok(request.data.request_id);
      const answer = await local.device.json("POST", "/api/rover/position", {
        boot_id: rover.bootId, lat: 36.0, lng: 128.0, alt: 5, request_id: request.data.request_id,
      });
      assert.equal(answer.status, 200);
      const res = await pending;
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, { lat: 36.0, lng: 128.0, alt: 5, source: "rover" });
    });
  });

  it("returns 422 when the rover reports a capture failure", async () => {
    await withHub(async (local) => {
      const rover = await local.openRover("boot-capture-fail");
      const pending = local.operator.json("POST", "/api/rover/request");
      const request = await rover.waitFor("request-position");
      await local.device.json("POST", "/api/rover/position", {
        boot_id: rover.bootId,
        request_ids: [request.data.request_id],
        capture_failed: true,
        error: "no_stable_rtk_fix",
      });
      const res = await pending;
      assert.equal(res.status, 422);
    });
  });
});

describe("operator commands without a rover", () => {
  for (const [path, body] of [
    ["/api/rover/stop", {}],
    ["/api/rover/clear-emergency", {}],
    ["/api/rover/pump", { on: true }],
    ["/api/rover/calibrate-battery", { measured_v: 26.0 }],
    ["/api/rover/calibrate-antenna", {}],
    ["/api/rover/set-antenna-offset", { a_x: 0.3, a_y: 0 }],
    ["/api/rover/calibrate-wheels", {}],
    ["/api/rover/reset-wheel-cal", {}],
    ["/api/rover/logs/fetch", {}],
  ]) {
    it(`${path} returns 503`, async () => {
      await withHub(async (local) => {
        const res = await local.operator.json("POST", path, body);
        assert.equal(res.status, 503);
        const log = local.db.prepare("SELECT level, detail FROM logs ORDER BY id DESC LIMIT 1").get();
        assert.equal(log.level, "warn");
        assert.equal(JSON.parse(log.detail).error, "not_connected");
      });
    });
  }

  it("validates pump, pump duration, battery, antenna, nav-light, and LED input", async () => {
    const cases = [
      ["/api/rover/pump", {}],
      ["/api/rover/pump", { on: "banana" }],
      ["/api/rover/pump-duration", {}],
      ["/api/rover/pump-duration", { seconds: 99 }],
      ["/api/rover/pump-duration", { seconds: 0 }],
      ["/api/rover/calibrate-battery", { measured_v: "twenty-six" }],
      ...[0, 14.9, 32.1, 100].map((value) => ["/api/rover/calibrate-battery", { measured_v: value }]),
      ["/api/rover/set-antenna-offset", { a_x: "0.3", a_y: 0 }],
      ["/api/rover/set-antenna-offset", { a_x: 0.01, a_y: 0 }],
      ["/api/rover/set-antenna-offset", { a_x: 0.3, a_y: 1.5 }],
      ["/api/rover/nav-lights", { mode: 5 }],
      ["/api/rover/nav-lights", { mode: 1.5 }],
      ["/api/rover/led-brightness", { brightness: 256 }],
      ["/api/rover/control", { throttle: "fast", steering: 0 }],
    ];
    for (const [path, body] of cases) {
      const res = await ctx.operator.json("POST", path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
    }
    const noBody = await ctx.operator.post("/api/rover/pump");
    assert.equal(noBody.status, 400);
    await noBody.body?.cancel();
  });

  it("stores pump duration, nav lights, and LED brightness while the rover is offline", async () => {
    await withHub(async (local) => {
      assert.equal((await local.operator.json("POST", "/api/rover/pump-duration", { seconds: 3.5 })).data.ok, true);
      assert.equal((await local.operator.json("POST", "/api/rover/nav-lights", { mode: 4 })).status, 200);
      assert.equal((await local.operator.json("POST", "/api/rover/led-brightness", { brightness: 40 })).status, 200);
      const status = await local.status();
      assert.equal(status.pump_run_duration, 3.5);
      assert.equal(status.nav_lights_mode, 4);
      assert.equal(status.led_brightness, 40);

      const rover = await local.openRover("boot-settings");
      assert.deepEqual((await rover.waitFor("nav-lights")).data, { mode: 4 });
      assert.deepEqual((await rover.waitFor("led-brightness")).data, { brightness: 40 });
      assert.deepEqual((await rover.waitFor("pump-duration")).data, { seconds: 3.5 });
      assert.deepEqual((await rover.waitFor("ntrip-source")).data, { source: "ngii", username: "" });
      assert.deepEqual((await rover.waitFor("mission-state-request")).data, { protocol_version: 2 });
    });
  });
});

describe("operator commands with a rover", () => {
  it("relays stop, clear-emergency, pump, calibration, and log fetch to the rover", async () => {
    await withHub(async (local) => {
      const rover = await local.openRover("boot-commands");
      const relayed = [
        ["/api/rover/stop", {}, "emergency-stop", {}],
        ["/api/rover/clear-emergency", {}, "clear-emergency", {}],
        ["/api/rover/pump", { on: true }, "pump-set", { on: true }],
        ["/api/rover/calibrate-battery", { measured_v: 26 }, "calibrate-battery", { measured_v: 26 }],
        ["/api/rover/set-antenna-offset", { a_x: 0.3, a_y: -0.1 }, "set-antenna-offset", { a_x: 0.3, a_y: -0.1 }],
        ["/api/rover/logs/fetch", {}, "fetch-logs", {}],
        ["/api/rover/nav-lights", { mode: 1 }, "nav-lights", { mode: 1 }],
        ["/api/rover/led-brightness", { brightness: 10 }, "led-brightness", { brightness: 10 }],
        ["/api/rover/pump-duration", { seconds: 1.5 }, "pump-duration", { seconds: 1.5 }],
      ];
      for (const [path, body, event, data] of relayed) {
        const waiter = rover.waitFor(event, (payload) => JSON.stringify(payload) === JSON.stringify(data));
        const res = await local.operator.json("POST", path, body);
        assert.equal(res.status, 200, path);
        assert.deepEqual((await waiter).data, data);
      }
      const status = await local.status();
      assert.equal(status.stop_requested, true);
      assert.equal(status.nav_state, "EMERGENCY_STOP");
      assert.equal(status.pump_on, true);
    });
  });

  it("allows calibration drives only while IDLE", async () => {
    await withHub(async (local) => {
      const rover = await local.openRover("boot-calibration");
      await local.device.json("POST", "/api/rover/telemetry", { boot_id: rover.bootId, nav_state: "NAVIGATING" });
      for (const path of ["/api/rover/calibrate-antenna", "/api/rover/calibrate-wheels", "/api/rover/reset-wheel-cal"]) {
        const res = await local.operator.json("POST", path, {});
        assert.equal(res.status, 409, path);
        assert.match(res.data, /not IDLE/);
      }
      await local.device.json("POST", "/api/rover/telemetry", { boot_id: rover.bootId, nav_state: "IDLE" });
      for (const [path, event] of [
        ["/api/rover/calibrate-antenna", "calibrate-antenna"],
        ["/api/rover/calibrate-wheels", "calibrate-wheels"],
        ["/api/rover/reset-wheel-cal", "reset-wheel-cal"],
      ]) {
        const waiter = rover.waitFor(event);
        assert.equal((await local.operator.json("POST", path, {})).status, 200, path);
        await waiter;
      }
    });
  });
});

describe("manual control", () => {
  const login = (who) => ({ headers: { "Tailscale-User-Login": who, "Tailscale-User-Name": who.split("@")[0] } });

  it("throttles disconnected-rover warnings per operator", async () => {
    await withHub(async (local) => {
      for (let i = 0; i < 2; i += 1) {
        const res = await local.operator.json("POST", "/api/rover/control", { throttle: 25, steering: -10 }, login("driver@test.com"));
        assert.equal(res.status, 503);
      }
      const logs = local.db.prepare(
        "SELECT level, detail FROM logs WHERE action = 'rover.control' AND actor_login = ? ORDER BY id",
      ).all("driver@test.com");
      assert.equal(logs.length, 1);
      assert.equal(logs[0].level, "warn");
      assert.deepEqual(JSON.parse(logs[0].detail), { error: "not_connected", throttle: 25, steering: -10 });
    });
  });

  it("logs connected manual control once per operator session, not per packet", async () => {
    await withHub(async (local) => {
      const rover = await local.openRover("boot-control");
      for (const who of ["driver-a@test.com", "driver-a@test.com", "driver-b@test.com"]) {
        const res = await local.operator.json("POST", "/api/rover/control", { throttle: 20, steering: 5 }, login(who));
        assert.equal(res.status, 200);
        assert.deepEqual(res.data, { throttle: 20, steering: 5 });
      }
      const clamped = await local.operator.json("POST", "/api/rover/control", { throttle: 500, steering: -500 }, login("driver-b@test.com"));
      assert.deepEqual(clamped.data, { throttle: 100, steering: -100 });
      await rover.waitFor("manual-control", (data) => data.throttle === 100);
      const logs = local.db.prepare(`SELECT actor_login, detail FROM logs
        WHERE action = 'rover.control' AND level = 'info' ORDER BY id`).all();
      assert.deepEqual(logs.map((row) => row.actor_login), ["driver-a@test.com", "driver-b@test.com"]);
      assert.ok(logs.every((row) => row.detail === "{}"));
    });
  });

  it("throttles repeated rejection while an autonomous mission is moving", async () => {
    await withHub(async (local) => {
      const created = await local.operator.json("POST", "/api/missions", { course: TEST_COURSE, items: coneItems([[35, 126]]) });
      assert.equal(created.status, 201);
      local.db.prepare("UPDATE mission SET lifecycle_state = 'running', status = 'running' WHERE id = ?").run(created.data.id);
      assert.equal((await local.activeMission()).motion_confirmed_held, false);
      for (let i = 0; i < 2; i += 1) {
        const res = await local.operator.json("POST", "/api/rover/control", { throttle: 30, steering: -5 }, login("blocked@test.com"));
        assert.equal(res.status, 409);
      }
      const warnings = local.db.prepare(`SELECT detail FROM logs
        WHERE action = 'rover.control' AND level = 'warn' AND actor_login = ?`).all("blocked@test.com");
      assert.equal(warnings.length, 1);
      assert.equal(JSON.parse(warnings[0].detail).error, "autonomous_mission_not_held");
      const zero = await local.operator.json("POST", "/api/rover/control", { throttle: 0, steering: 0 });
      assert.equal(zero.status, 503, "a zero command is not motion and only fails on the missing rover");
    });
  });
});

describe("rover telemetry and status", () => {
  it("exposes telemetry in /api/rover/status", async () => {
    await withHub(async (local) => {
      let res = await local.device.json("POST", "/api/rover/telemetry", {
        nav_state: "NAVIGATING", fix_status: "rtk_fixed", ntrip_connected: true,
      });
      assert.equal(res.status, 200);
      let status = await local.status();
      assert.equal(status.nav_state, "NAVIGATING");
      assert.equal(status.fix_status, "rtk_fixed");
      assert.equal(status.ntrip_connected, true);
      assert.ok(status.fix_status_at > 0);

      await local.device.json("POST", "/api/rover/telemetry", {
        gps: { h_acc: 0.012, v_acc: 0.018, speed: 1.34, heading: 87.5, num_sv: 22, pdop: "bad" },
      });
      status = await local.status();
      assert.deepEqual(status.gps, {
        h_acc: 0.012, v_acc: 0.018, altitude: null, speed: 1.34, heading: 87.5, num_sv: 22, pdop: null, tdop: null,
      });

      const calibratedAt = 1714200000000;
      const flags = 0x80 | 0x01 | 0x04;
      await local.device.json("POST", "/api/rover/telemetry", {
        battery: {
          voltage: 26.0, voltage_raw: 25.6, percent: 47, source: "mcu", gain: 1.015625,
          measured_v: 26.0, calibrated_at: calibratedAt, flags,
        },
      });
      status = await local.status();
      assert.deepEqual(status.battery, {
        voltage: 26.0, voltage_raw: 25.6, percent: 47, source: "mcu", gain: 1.015625,
        measured_v: 26.0, calibrated_at: calibratedAt, flags,
      });

      await local.device.json("POST", "/api/rover/telemetry", { ntrip_connected: null });
      assert.equal((await local.status()).ntrip_connected, true, "null means not reported");

      await local.device.json("POST", "/api/rover/telemetry", {
        ntrip_connected: true,
        ntrip: {
          host: "www.gnssdata.or.kr", port: 2101, mountpoint: "SEJN-RTCM32",
          fail_count: 0, last_error: null, last_correction_at: 1234567890, bytes_received: 99,
        },
      });
      assert.equal((await local.status()).ntrip.mountpoint, "SEJN-RTCM32");
      await local.device.json("POST", "/api/rover/telemetry", { ntrip_connected: false });
      status = await local.status();
      assert.equal(status.ntrip_connected, false);
      assert.equal(status.ntrip, null, "a disconnected caster drops the cached detail");
    });
  });

  it("reports the device identity and NTRIP source, without the removed receiver fields", async () => {
    const status = await ctx.status();
    assert.deepEqual(status.device, { id: "rover-test", name: "Test Rover", kind: "rover" });
    assert.ok(status.ntrip_source && typeof status.ntrip_source === "object");
    assert.ok("last_disconnect_reason" in status);
    assert.ok("last_disconnect_at" in status);
    assert.ok("active_mission" in status);
    assert.deepEqual(Object.keys(status.mission_protocol).sort(), ["boot_id", "compatible", "connected", "required"]);
    for (const removed of ["receiver", "position_source", "mission_progress"]) {
      assert.equal(Object.hasOwn(status, removed), false, removed);
    }
    const events = await ctx.openEvents();
    try {
      const init = events.response.ok;
      assert.ok(init);
      const statusEvent = events.waitFor("rover:status");
      await ctx.device.json("POST", "/api/rover/telemetry", { fix_status: "3d_fix" });
      const broadcast = (await statusEvent).data;
      assert.deepEqual(broadcast.device, status.device);
      assert.ok("active_mission_summary" in broadcast);
      assert.equal(Object.hasOwn(broadcast, "active_mission"), false);
      for (const removed of ["receiver", "position_source", "mission_progress"]) {
        assert.equal(Object.hasOwn(broadcast, removed), false, removed);
      }
    } finally {
      await events.close();
    }
  });

  it("defaults the device name to its id", async () => {
    await withHub(async (local) => {
      assert.deepEqual((await local.status()).device, { id: "pi-rover-3", name: "pi-rover-3", kind: "rover" });
    }, { deviceId: "pi-rover-3", deviceName: undefined });
  });

  it("requires a valid boot_id on a protocol v2 stream", async () => {
    await withHub(async (local) => {
      for (const query of ["?protocol_version=2", `?protocol_version=2&boot_id=${"x".repeat(200)}`]) {
        const res = await fetch(`${local.deviceUrl}/api/rover/stream${query}`, {
          headers: { "X-Internal-Service": "ignored", Accept: "text/event-stream" },
        });
        if (query.includes("xxx")) {
          // Overlong boot ids are truncated to 128 characters and accepted.
          assert.equal(res.status, 200);
          await res.body.cancel();
        } else {
          assert.equal(res.status, 409);
          assert.equal(await res.text(), "A valid boot_id is required.");
        }
      }
    });
  });

  it("marks a non-v2 stream incompatible and refuses movement commands", async () => {
    await withHub(async (local) => {
      const rover = await local.openRover("legacy", { protocolVersion: null });
      const status = await local.status();
      assert.equal(status.connected, true);
      assert.deepEqual(status.mission_protocol, { required: 2, connected: 0, compatible: false, boot_id: null });
      const mission = (await local.operator.json("POST", "/api/missions", { course: TEST_COURSE, items: coneItems([[35, 126]]) })).data;
      const start = await local.operator.json("POST", `/api/missions/${mission.id}/start`, {
        expected_plan_hash: mission.plan_hash,
        expected_occurrence_revision: mission.occurrence_revision,
      });
      assert.equal(start.status, 409);
      assert.equal(start.data, "No mission protocol v2 rover is connected.");
      await rover.close();
    });
  });
});

describe("device reports", () => {
  it("relays waypoint index events and validates indices", async () => {
    const events = await ctx.openEvents();
    try {
      const reached = events.waitFor("rover:waypoint", (data) => data.index === 2);
      assert.equal((await ctx.device.json("POST", "/api/rover/waypoint_reached", { index: 2 })).status, 200);
      await reached;
      const skipped = events.waitFor("rover:skipped", (data) => data.index === 4);
      assert.equal((await ctx.device.json("POST", "/api/rover/waypoint_skipped", { index: 4 })).status, 200);
      await skipped;
      for (const path of ["/api/rover/waypoint_reached", "/api/rover/waypoint_skipped"]) {
        assert.equal((await ctx.device.json("POST", path, { index: -1 })).status, 400);
        assert.equal((await ctx.device.json("POST", path, { index: "abc" })).status, 400);
      }
    } finally {
      await events.close();
    }
  });

  it("stores and broadcasts spray results", async () => {
    const events = await ctx.openEvents();
    try {
      const spray = events.waitFor("rover:spray", (data) => data.waypoint === 2);
      const res = await ctx.device.json("POST", "/api/rover/spray_result", { waypoint: 2, outcome: "success" });
      assert.equal(res.status, 200);
      assert.equal((await spray).data.outcome, "success");
      const status = await ctx.status();
      assert.equal(status.last_spray_result.waypoint, 2);
      assert.equal(status.last_spray_result.outcome, "success");
    } finally {
      await events.close();
    }
    assert.equal((await ctx.device.json("POST", "/api/rover/spray_result", { waypoint: 0, outcome: "exploded" })).status, 400);
    assert.equal((await ctx.device.json("POST", "/api/rover/spray_result", { waypoint: -1, outcome: "success" })).status, 400);
  });

  it("stores and broadcasts calibration results", async () => {
    await withHub(async (local) => {
      const events = await local.openEvents();
      const antennaEvent = events.waitFor("rover:antenna_calibration");
      await local.device.json("POST", "/api/rover/antenna_calibration_result", {
        ok: true, a_x: 0.31, a_y: -0.02, rms_residual_m: 0.03, samples: 400, drive_distance_m: 12.5,
        calibrated_at: 1714200000, source: "auto", extra: "ignored",
      });
      const antenna = (await antennaEvent).data;
      assert.deepEqual(antenna, {
        ok: true, a_x: 0.31, a_y: -0.02, rms_residual_m: 0.03, samples: 400, drive_distance_m: 12.5,
        calibrated_at: 1714200000, reason: null, source: "auto",
      });
      await local.device.json("POST", "/api/rover/wheel_calibration_result", {
        ok: false, reason: "chord_too_short", scale_l: 1.01,
      });
      const status = await local.status();
      assert.deepEqual(status.antenna_calibration, antenna);
      assert.equal(status.wheel_calibration.ok, false);
      assert.equal(status.wheel_calibration.reason, "chord_too_short");
      assert.equal(status.wheel_calibration.scale_l, 1.01);
      const levels = local.db.prepare(`SELECT action, level FROM logs
        WHERE action IN ('rover.antenna_calibration','rover.wheel_calibration') ORDER BY id`).all();
      assert.deepEqual(levels.map((row) => row.level), ["info", "warn"]);
    });
  });

  it("caches uploaded rover logs in memory", async () => {
    const events = await ctx.openEvents();
    try {
      const uploaded = events.waitFor("rover:logs", (data) => data.count === 2);
      const up = await ctx.device.json("POST", "/api/rover/logs", {
        entries: [
          { t: 1700000000000, level: "INFO", node: "gps_node", msg: "GPS locked" },
          { t: 1700000001000, level: "WARN", node: "ntrip", msg: "reconnecting" },
          "not-an-entry",
        ],
      });
      assert.equal(up.status, 200);
      assert.equal(up.data.stored, 2);
      await uploaded;
    } finally {
      await events.close();
    }
    const cache = await ctx.operator.json("GET", "/api/rover/logs");
    assert.equal(cache.data.entries.length, 2);
    assert.equal(cache.data.entries[0].node, "gps_node");
    assert.ok(cache.data.uploaded_at > 0);
    assert.equal((await ctx.device.json("POST", "/api/rover/logs", { entries: "notanarray" })).status, 400);
  });

  it("accepts a 500-entry log upload larger than the default body limit", async () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({
      t: index, level: "INFO", node: "navigator_node", msg: "x".repeat(400),
    }));
    const res = await ctx.device.json("POST", "/api/rover/logs", { entries });
    assert.equal(res.status, 200);
    assert.equal(res.data.stored, 500);
  });
});

describe("missions API", () => {
  it("lists missions with pagination", async () => {
    let res = await ctx.operator.json("GET", "/api/missions");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.missions));
    assert.ok("total" in res.data);
    res = await ctx.operator.json("GET", "/api/missions?limit=5&offset=10");
    assert.equal(res.data.limit, 5);
    assert.equal(res.data.offset, 10);
    res = await ctx.operator.json("GET", "/api/missions?limit=999999");
    assert.equal(res.data.limit, 500);
  });

  it("answers 404 and 400 for missing or malformed mission ids", async () => {
    assert.equal((await ctx.operator.json("GET", "/api/missions/999999")).status, 404);
    assert.equal((await ctx.operator.json("GET", "/api/missions/abc")).status, 400);
    assert.equal((await ctx.operator.json("GET", "/api/missions/999999/telemetry")).status, 404);
    assert.equal((await ctx.operator.json("PUT", "/api/missions/abc/remaining", { items: [] })).status, 400);
    assert.equal((await ctx.operator.json("POST", "/api/missions/abc/end", {})).status, 400);
    const missing = await ctx.operator.json("POST", "/api/missions/999999/end", {});
    assert.equal(missing.status, 404);
    assert.equal(missing.data, "Mission not found.");
  });
});

describe("mission interruption on the rover link", () => {
  it("interrupts a moving mission on a stream drop and keeps it after an IDLE reconnect", async () => {
    await withHub(async (local) => {
      let rover = await local.openRover("boot-drop");
      const mission = await runningMission(local, rover);
      await rover.close();
      await waitForCondition(async () => !(await local.status()).connected, { label: "rover disconnect" });
      let active = await local.activeMission();
      assert.equal(active.id, mission.id);
      assert.equal(active.status, "interrupted");
      assert.equal(active.hold_reason, "sse_disconnect");
      assert.equal(active.ended_at, null);
      assert.equal((await local.status()).last_disconnect_reason, "sse_closed");

      rover = await local.openRover("boot-drop");
      await local.device.json("POST", "/api/rover/telemetry", { boot_id: rover.bootId, nav_state: "IDLE" });
      active = await local.activeMission();
      assert.equal(active.status, "interrupted", "IDLE telemetry must not complete or resume the mission");
    });
  });

  it("reconciles a rover-local hold to paused and ignores a stray running state afterwards", async () => {
    await withHub(async (local) => {
      const rover = await local.openRover("boot-local-hold");
      const mission = await runningMission(local, rover);
      const report = (seq, body) => local.device.json("POST", "/api/rover/mission-report", {
        protocol_version: 2, boot_id: rover.bootId, report_seq: seq, mission_id: mission.id,
        plan_hash: mission.plan_hash, ...body,
      });
      let res = await report(2, { event: "held", motion_state: "held", reason: "operator_button" });
      assert.equal(res.data.mission.status, "paused");
      assert.equal(res.data.mission.motion_confirmed_held, true);
      res = await report(3, { event: "state", motion_state: "running", completed_waypoint_ids: [] });
      assert.equal(res.data.mission.status, "paused");
      res = await report(3, { event: "state", motion_state: "running", completed_waypoint_ids: [] });
      assert.equal(res.data.duplicate, true);
    });
  });
});

describe("mission telemetry samples", () => {
  it("records NTRIP link health and fix quality per sample", async () => {
    await withHub(async (local) => {
      const rover = await local.openRover("boot-telemetry");
      const mission = await runningMission(local, rover);
      const corrAtSec = Date.now() / 1000 - 1.5;
      let res = await local.device.json("POST", "/api/rover/telemetry", {
        boot_id: rover.bootId,
        nav_state: "NAVIGATING",
        fix_status: "rtk_float",
        ntrip_connected: true,
        ntrip: { host: "ntrip.example", port: 2101, mountpoint: "SEJN-RTCM32", fail_count: 3, last_correction_at: corrAtSec, bytes_received: 4096 },
        gps: { h_acc: 0.021 },
      });
      assert.equal(res.status, 200);
      const samples = async () => (await local.operator.json("GET", `/api/missions/${mission.id}/telemetry`)).data.samples;
      let last = (await samples()).at(-1);
      assert.equal(last.ntrip_connected, 1);
      assert.equal(last.ntrip_fail_count, 3);
      assert.equal(last.h_acc_m, 0.021);
      assert.equal(last.fix_status, "rtk_float");
      assert.equal(last.nav_state, "NAVIGATING");
      assert.ok(last.corr_age_ms >= 1000 && last.corr_age_ms <= 6000, `corr_age_ms=${last.corr_age_ms}`);

      await local.device.json("POST", "/api/rover/telemetry", {
        boot_id: rover.bootId, nav_state: "ERROR", fix_status: "3d_fix", ntrip_connected: false,
      });
      last = (await samples()).at(-1);
      assert.equal(last.ntrip_connected, 0);
      assert.equal(last.corr_age_ms, null);
      assert.equal(last.fix_status, "3d_fix");

      await local.device.json("POST", "/api/rover/telemetry", {
        boot_id: rover.bootId, nav_state: "NAVIGATING", fix_status: "rtk_fixed", ntrip_connected: true,
        gps: { h_acc: 0.014, v_acc: 0.022, altitude: 47.35 },
      });
      await local.device.json("POST", "/api/rover/position", { boot_id: rover.bootId, lat: 35.00001, lng: 126.00001 });
      const all = await samples();
      last = all.at(-1);
      assert.equal(last.lat, 35.00001);
      assert.equal(all.at(-2).altitude_m, 47.35);
      assert.equal(all.at(-2).v_acc_m, 0.022);
      const list = await local.operator.json("GET", "/api/missions");
      assert.equal(list.data.missions[0].sample_count, all.length);
    });
  });

  it("caps the telemetry and log tables", async () => {
    await withHub(async (local) => {
      const rover = await local.openRover("boot-cap");
      const mission = await runningMission(local, rover);
      for (let i = 0; i < 6; i += 1) {
        await local.device.json("POST", "/api/rover/telemetry", { boot_id: rover.bootId, nav_state: "NAVIGATING", fix_status: `f${i}` });
      }
      const rows = local.db.prepare("SELECT fix_status FROM mission_telemetry WHERE mission_id=? ORDER BY id").all(mission.id);
      assert.deepEqual(rows.map((row) => row.fix_status), ["f3", "f4", "f5"]);
      for (let i = 0; i < 10; i += 1) await local.device.json("POST", "/api/rover/waypoint_skipped", { index: i });
      assert.equal(local.db.prepare("SELECT COUNT(*) AS n FROM logs").get().n, 5);
    }, { telemetryMaxRows: 3, logMaxRows: 5 });
  });
});

describe("rover liveness watchdog", () => {
  it("flips a silent rover offline, interrupts the moving mission, and logs as the system", async () => {
    await withHub(async (local) => {
      const rover = await local.openRover("boot-stale");
      const mission = await runningMission(local, rover);
      const offline = await waitForCondition(async () => {
        const status = await local.status();
        return status.connected === false ? status : null;
      }, { label: "stale watchdog" });
      assert.equal(offline.last_disconnect_reason, "stale");
      assert.equal(offline.mission_protocol.connected, 0);
      const active = await local.activeMission();
      assert.equal(active.id, mission.id);
      assert.equal(active.status, "interrupted");
      assert.equal(active.hold_reason, "telemetry_stale");
      const rows = local.db.prepare(`SELECT action, actor, actor_login FROM logs
        WHERE action IN ('mission.v2.interrupted', 'rover.stream.stale') ORDER BY id`).all();
      assert.deepEqual(rows.map((row) => row.action), ["mission.v2.interrupted", "rover.stream.stale"]);
      for (const row of rows) assert.deepEqual({ actor: row.actor, login: row.actor_login }, { actor: "system", login: null });
      await rover.close();
    }, { deviceStaleMs: 1000, deviceWatchdogTickMs: 30 });
  });

  it("keeps the rover online while telemetry keeps arriving", async () => {
    await withHub(async (local) => {
      const rover = await local.openRover("boot-alive");
      for (let i = 0; i < 6; i += 1) {
        await local.device.json("POST", "/api/rover/telemetry", { boot_id: rover.bootId, fix_status: "rtk_fixed" });
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      assert.equal((await local.status()).connected, true);
    }, { deviceStaleMs: 300, deviceWatchdogTickMs: 30 });
  });
});

describe("rover NTRIP correction source", () => {
  it("validates the source", async () => {
    const bad = [
      undefined,
      [],
      {},
      { source: "base" },
      { source: "caster", host: "", port: 2101, mountpoint: "BASE" },
      { source: "caster", host: "caster example", port: 2101, mountpoint: "BASE" },
      { source: "caster", host: "a".repeat(254), port: 2101, mountpoint: "BASE" },
      { source: "caster", host: "caster.example", port: 0, mountpoint: "BASE" },
      { source: "caster", host: "caster.example", port: 65536, mountpoint: "BASE" },
      { source: "caster", host: "caster.example", port: "2101", mountpoint: "BASE" },
      { source: "caster", host: "caster.example", port: 2101.5, mountpoint: "BASE" },
      { source: "caster", host: "caster.example", port: 2101, mountpoint: "" },
      { source: "caster", host: "caster.example", port: 2101, mountpoint: "BASE/1" },
      { source: "caster", host: "caster.example", port: 2101, mountpoint: "M".repeat(65) },
      { source: "caster", host: "caster.example", mountpoint: "BASE" },
    ];
    for (const body of bad) {
      const res = await ctx.operator.json("PUT", "/api/rover/ntrip-source", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const host253 = await ctx.operator.json("PUT", "/api/rover/ntrip-source", {
      source: "caster", host: "a".repeat(253), port: 65535, mountpoint: "M".repeat(64),
    });
    assert.equal(host253.status, 200);
    const back = await ctx.operator.json("PUT", "/api/rover/ntrip-source", { source: "ngii", host: "ignored" });
    assert.deepEqual(back.data, { source: "ngii" });
  });

  it("persists the source, reports it in status, and pushes it to the rover on connect and on change", async () => {
    const dbPath = tmpDbPath();
    let local = await startHub({ dbPath });
    try {
      assert.deepEqual((await local.operator.json("GET", "/api/rover/ntrip-source")).data, { source: "ngii" });
      assert.deepEqual((await local.status()).ntrip_source, { source: "ngii" });

      const rover = await local.openRover("boot-ntrip");
      assert.deepEqual((await rover.waitFor("ntrip-source")).data, { source: "ngii", username: "" });
      const events = await local.openEvents();
      const caster = { source: "caster", host: "gps-unit.tail1234.ts.net", port: 2101, mountpoint: "FSK_BASE-1" };
      const pushed = rover.waitFor("ntrip-source", (data) => data.source === "caster");
      const broadcast = events.waitFor("rover:status", (data) => data.ntrip_source.source === "caster");
      const put = await local.operator.json("PUT", "/api/rover/ntrip-source", { ...caster, extra: true });
      assert.equal(put.status, 200);
      assert.deepEqual(put.data, caster);
      assert.deepEqual((await pushed).data, caster);
      assert.deepEqual((await broadcast).data.ntrip_source, caster);
      assert.deepEqual((await local.operator.json("GET", "/api/rover/ntrip-source")).data, caster);
      assert.deepEqual((await local.status()).ntrip_source, caster);
      const log = local.db.prepare("SELECT detail FROM logs WHERE action='rover.ntrip_source.update' AND level='info'").get();
      assert.deepEqual(JSON.parse(log.detail), { before: { source: "ngii" }, after: caster, delivered: true });

      const reconnect = await local.openRover("boot-ntrip-2");
      assert.deepEqual((await reconnect.waitFor("ntrip-source")).data, caster);
      await local.stop({ keepDb: true });

      local = await startHub({ dbPath });
      assert.deepEqual((await local.operator.json("GET", "/api/rover/ntrip-source")).data, caster);
      const afterRestart = await local.openRover("boot-ntrip-3");
      assert.deepEqual((await afterRestart.waitFor("ntrip-source")).data, caster);
    } finally {
      await local.stop({ keepDb: true });
      cleanupDb(dbPath);
    }
  });

  it("saves the source while the rover is offline", async () => {
    await withHub(async (local) => {
      const caster = { source: "caster", host: "10.0.0.5", port: 2102, mountpoint: "BASE" };
      const put = await local.operator.json("PUT", "/api/rover/ntrip-source", caster);
      assert.equal(put.status, 200);
      const log = local.db.prepare("SELECT detail FROM logs WHERE action='rover.ntrip_source.update'").get();
      assert.equal(JSON.parse(log.detail).delivered, false);
      const rover = await local.openRover("boot-offline-ntrip");
      assert.deepEqual((await rover.waitFor("ntrip-source")).data, caster);
    });
  });
});

describe("rover NGII login", () => {
  it("rejects logins the NTRIP client cannot send", async () => {
    await withHub(async (local) => {
      for (const body of [{}, { username: 5 }, { username: "a b" }, { username: "user:pass" }, { username: "user\n" },
        { username: "x".repeat(129) }, { username: "로그인" }, []]) {
        const res = await local.operator.json("PUT", "/api/rover/ntrip-username", body);
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      const longest = await local.operator.json("PUT", "/api/rover/ntrip-username", { username: "x".repeat(128) });
      assert.equal(longest.status, 200);
    });
  });

  it("persists the login, reports it in status, and sends it with the NGII source", async () => {
    const dbPath = tmpDbPath();
    let local = await startHub({ dbPath });
    try {
      assert.equal((await local.status()).ntrip_username, "");
      const rover = await local.openRover("boot-login");
      assert.deepEqual((await rover.waitFor("ntrip-source")).data, { source: "ngii", username: "" });

      const events = await local.openEvents();
      const pushed = rover.waitFor("ntrip-source", (data) => data.username === "me@example.com");
      const broadcast = events.waitFor("rover:status", (data) => data.ntrip_username === "me@example.com");
      const put = await local.operator.json("PUT", "/api/rover/ntrip-username", { username: "me@example.com" });
      assert.equal(put.status, 200);
      assert.deepEqual(put.data, { username: "me@example.com" });
      assert.deepEqual((await pushed).data, { source: "ngii", username: "me@example.com" });
      await broadcast;
      assert.equal((await local.operator.json("GET", "/api/rover/status")).data.ntrip_username, "me@example.com");
      // The NGII source the operator sees carries no login; the log records only that one is set.
      assert.deepEqual((await local.operator.json("GET", "/api/rover/ntrip-source")).data, { source: "ngii" });
      const log = local.db.prepare("SELECT detail FROM logs WHERE action='rover.ntrip_username.update' AND level='info'").get();
      assert.deepEqual(JSON.parse(log.detail), { set: true, changed: true, delivered: true });
      await local.stop({ keepDb: true });

      local = await startHub({ dbPath });
      assert.equal((await local.status()).ntrip_username, "me@example.com");
      const afterRestart = await local.openRover("boot-login-2");
      assert.deepEqual((await afterRestart.waitFor("ntrip-source")).data, { source: "ngii", username: "me@example.com" });
    } finally {
      await local.stop({ keepDb: true });
      cleanupDb(dbPath);
    }
  });

  it("keeps the login while a caster is the source and sends none to it", async () => {
    await withHub(async (local) => {
      const caster = { source: "caster", host: "10.0.0.5", port: 2101, mountpoint: "BASE" };
      assert.equal((await local.operator.json("PUT", "/api/rover/ntrip-source", caster)).status, 200);
      const rover = await local.openRover("boot-login-caster");
      assert.deepEqual((await rover.waitFor("ntrip-source")).data, caster);
      const put = await local.operator.json("PUT", "/api/rover/ntrip-username", { username: "user" });
      assert.equal(put.status, 200);
      const log = local.db.prepare("SELECT detail FROM logs WHERE action='rover.ntrip_username.update' AND level='info'").get();
      assert.equal(JSON.parse(log.detail).delivered, false);

      const pushed = rover.waitFor("ntrip-source", (data) => data.source === "ngii");
      assert.equal((await local.operator.json("PUT", "/api/rover/ntrip-source", { source: "ngii" })).status, 200);
      assert.deepEqual((await pushed).data, { source: "ngii", username: "user" });
    });
  });
});
