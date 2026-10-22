import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { cleanupDb, openSse, tmpDbPath, waitForCondition } from "./helpers.mjs";

const HUB_ENTRY = fileURLToPath(new URL("../../rover/hub/index.mjs", import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startProcess(env) {
  const child = spawn(process.execPath, [HUB_ENTRY], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => output };
}

describe("hub process", () => {
  it("reads its environment, listens on 127.0.0.1, and shuts down cleanly on SIGTERM", async () => {
    const dbPath = tmpDbPath();
    const devicePort = await freePort();
    const operatorPort = await freePort();
    const hub = startProcess({
      HUB_DB_PATH: dbPath,
      HUB_DEVICE_PORT: String(devicePort),
      HUB_OPERATOR_PORT: String(operatorPort),
      HUB_ALLOWED_ORIGINS: "https://a.example, https://b.example/",
      HUB_DEVICE_ID: "pi-rover",
      HUB_DEVICE_NAME: "Rover One",
      COURSEKEEPER_VERSION: "v1.2.3",
      MISSION_TELEMETRY_MAX_ROWS: "1000",
      ROVER_MAX_WAYPOINT_DIST_M: "150",
      ROVER_MAX_SEGMENT_DIST_M: "40",
    });
    try {
      const deviceUrl = `http://127.0.0.1:${devicePort}`;
      const operatorUrl = `http://127.0.0.1:${operatorPort}`;
      await waitForCondition(async () => (await fetch(`${operatorUrl}/api/health`)).ok, {
        timeoutMs: 10000, label: `hub start (${hub.output()})`,
      });
      assert.equal(await (await fetch(`${deviceUrl}/api/health`)).text(), "ok");

      const status = await fetch(`${operatorUrl}/api/rover/status`, { headers: { Origin: "https://b.example" } });
      assert.equal(status.headers.get("access-control-allow-origin"), "https://b.example");
      assert.deepEqual((await status.json()).device, { id: "pi-rover", name: "Rover One", kind: "rover", version: "v1.2.3" });
      assert.equal((await fetch(`${deviceUrl}/api/rover/status`)).status, 404);

      // Open streams must not hold the shutdown.
      const rover = await openSse(`${deviceUrl}/api/rover/stream?protocol_version=2&boot_id=process-boot`, {
        readyEvent: "connected",
      });
      const events = await openSse(`${operatorUrl}/api/events`, { readyEvent: "init" });
      hub.child.kill("SIGTERM");
      let timer;
      const exit = await Promise.race([
        hub.exited,
        new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), 8000); }),
      ]);
      clearTimeout(timer);
      assert.deepEqual(exit, { code: 0, signal: null }, hub.output());
      await rover.close();
      await events.close();

      assert.ok(fs.existsSync(dbPath));
      const db = new Database(dbPath, { readonly: true });
      try {
        assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
        assert.ok(db.prepare("SELECT 1 FROM rover_boot_session WHERE boot_id='process-boot'").get());
      } finally {
        db.close();
      }
    } finally {
      if (hub.child.exitCode === null) hub.child.kill("SIGKILL");
      cleanupDb(dbPath);
    }
  });

  it("refuses an invalid environment", async () => {
    const dbPath = tmpDbPath();
    try {
      for (const env of [
        { HUB_DEVICE_PORT: "abc" },
        { HUB_OPERATOR_PORT: "70000" },
        { HUB_ALLOWED_ORIGINS: "not a url" },
        { ROVER_MAX_SEGMENT_DIST_M: "-1" },
      ]) {
        const hub = startProcess({ HUB_DB_PATH: dbPath, ...env });
        const exit = await hub.exited;
        assert.equal(exit.code, 1, `${JSON.stringify(env)}: ${hub.output()}`);
        assert.match(hub.output(), /^hub: /m);
      }
    } finally {
      cleanupDb(dbPath);
    }
  });
});
