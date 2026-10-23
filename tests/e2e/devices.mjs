import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHubApp } from "../../rover/hub/index.mjs";

// The devices the console reaches in end-to-end tests: the real rover hub with
// a simulated rover on its device API, and the real GPS unit API over a
// simulated receiver (fake_gps.py).

export const ROVER_BOOT_ID = "e2e-boot";
// Near the console's default map view.
export const ROVER_POSITION = Object.freeze({ lat: 35.292, lng: 126.5742, alt: 12.3 });

const here = path.dirname(fileURLToPath(import.meta.url));

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve(server)));
  });
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

// Reads `event:`/`data:` frames from a fetch body until it ends.
async function readEvents(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

// A rover that holds an RTK fixed position, answers cone captures, E-stop and
// log requests, and reports telemetry once a second.
function startSimulatedRover(deviceUrl) {
  const controller = new AbortController();
  const post = (endpoint, body) => fetch(`${deviceUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ boot_id: ROVER_BOOT_ID, ...body }),
    signal: controller.signal,
  }).catch(() => {});
  const navState = (state) => post("/api/rover/telemetry", { nav_state: state });

  function report() {
    post("/api/rover/position", ROVER_POSITION);
    post("/api/rover/telemetry", {
      fix_status: "rtk_fixed",
      ntrip_connected: true,
      ntrip: { host: "rts1.ngii.go.kr", port: 2101, mountpoint: "VRS-RTCM32", last_correction_at: Date.now() / 1000 },
      battery: { voltage: 24.6, voltage_raw: 24.6, percent: 82, gain: 1, flags: 0 },
      gps: { h_acc: 0.012, v_acc: 0.02, altitude: ROVER_POSITION.alt, speed: 0, heading: 90, num_sv: 19, pdop: 1.2, tdop: 0.9 },
    });
  }

  const commands = {
    "request-position": ({ request_id }) => post("/api/rover/position", { ...ROVER_POSITION, request_id }),
    "emergency-stop": () => navState("EMERGENCY_STOP"),
    "clear-emergency": () => navState("IDLE"),
    "fetch-logs": () => post("/api/rover/logs", {
      entries: [{ t: Date.now(), level: "INFO", node: "navigator", msg: "Simulated rover log line" }],
    }),
  };

  const connected = (async () => {
    const response = await fetch(
      `${deviceUrl}/api/rover/stream?protocol_version=2&boot_id=${ROVER_BOOT_ID}&version=e2e`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new Error(`Rover stream refused: ${response.status}`);
    let ready;
    const opened = new Promise((resolve) => { ready = resolve; });
    readEvents(response.body, (event, data) => {
      if (event === "connected") ready();
      commands[event]?.(data);
    }).catch(() => {});
    await opened;
    await navState("IDLE");
    report();
  })();
  const timer = setInterval(report, 1000);

  return {
    connected,
    stop() {
      clearInterval(timer);
      controller.abort();
    },
  };
}

function startSimulatedGps(origin) {
  const child = spawn("python3", ["-I", path.join(here, "fake_gps.py"), "--origin", origin], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/ready (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.on("exit", (code) => reject(new Error(`fake_gps.py exited with ${code}`)));
  });
  return { ready, stop: () => child.kill() };
}

export async function startDevices({ origin }) {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "coursekeeper-e2e-"));
  const hub = createHubApp({
    dbPath: path.join(dbDir, "hub.db"),
    deviceId: "rover-e2e",
    version: "e2e",
    allowedOrigins: [origin],
    deviceStaleMs: 10 * 60 * 1000,
  });
  const deviceServer = await listen(hub.deviceApp);
  const operatorServer = await listen(hub.operatorApp);
  const deviceUrl = `http://127.0.0.1:${deviceServer.address().port}`;
  const rover = startSimulatedRover(deviceUrl);
  const gps = startSimulatedGps(origin);
  await rover.connected;
  const gpsPort = await gps.ready;

  return {
    roverUrl: `http://127.0.0.1:${operatorServer.address().port}`,
    roverDeviceUrl: deviceUrl,
    gpsUrl: `http://127.0.0.1:${gpsPort}`,
    async stop() {
      rover.stop();
      gps.stop();
      hub.closeStreams();
      await Promise.all([closeServer(deviceServer), closeServer(operatorServer)]);
      hub.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
    },
  };
}
