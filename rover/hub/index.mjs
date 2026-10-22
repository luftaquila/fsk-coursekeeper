// Rover hub: runs on the rover Pi next to the pilot container.
//
// deviceApp  — bridge_node's existing device protocol (command SSE + reports),
//              bound to 127.0.0.1. No authentication: only the rover reaches it.
// operatorApp — the browser API, bound to 127.0.0.1 and published on the
//              tailnet by `tailscale serve`. Tailnet access is the only
//              authorization; CORS admits the configured console origins.
// Both apps share one rover link state and one SQLite database.
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";
import { ROVER_ACTOR, tailnetActor } from "./server/actor.mjs";
import { createCors, normalizeOrigins } from "./server/cors.mjs";
import { createDbRun, openDatabase } from "./server/db.mjs";
import { createLogger } from "./server/logger.mjs";
import {
  DEFAULT_MAX_SEGMENT_DIST_M,
  DEFAULT_MAX_WAYPOINT_DIST_M,
  registerRoverRoutes,
} from "./server/rover-routes.mjs";
import {
  DEFAULT_LOG_MAX_ROWS,
  DEFAULT_TELEMETRY_MAX_ROWS,
  initializeHubSchema,
} from "./server/schema.mjs";
import { createSSEManager } from "./server/sse.mjs";

export const DEFAULT_DB_PATH = "/var/lib/fsk-coursekeeper-hub/hub.db";
export const DEFAULT_DEVICE_PORT = 10100;
export const DEFAULT_OPERATOR_PORT = 10101;
// A 1,000-waypoint mission body and a full rover log upload both exceed
// Express's 100kb default.
const JSON_LIMIT = "1mb";

// req.actor labels the audit log and mission records.
function setActor(actorFor) {
  return (req, res, next) => {
    req.actor = actorFor(req);
    next();
  };
}

function createBaseApp(...middleware) {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  for (const handler of middleware) app.use(handler);
  app.use(express.json({ limit: JSON_LIMIT }));
  app.get("/api/health", (req, res) => res.send("ok"));
  return app;
}

function finishApp(app, logger) {
  app.use((req, res) => res.status(404).send("Not found."));
  // Body-parser failures carry an HTTP status; anything else is a bug.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) {
      logger.warn(req, "http.error", { error: err?.message || String(err), method: req.method, path: req.path }, "hub");
    }
    const message = err?.type === "entity.parse.failed" ? "Invalid JSON body."
      : err?.type === "entity.too.large" ? "The request body is too large."
        : status < 500 && err?.expose && err.message ? err.message
          : "Internal error.";
    res.status(status).send(message);
  });
}

export function createHubApp(options = {}) {
  const {
    dbPath,
    deviceId = os.hostname(),
    deviceName,
    allowedOrigins = [],
    deviceStaleMs,
    deviceWatchdogTickMs,
    telemetryMaxRows = DEFAULT_TELEMETRY_MAX_ROWS,
    logMaxRows = DEFAULT_LOG_MAX_ROWS,
    maxWaypointDistM = DEFAULT_MAX_WAYPOINT_DIST_M,
    maxSegmentDistM = DEFAULT_MAX_SEGMENT_DIST_M,
  } = options;
  if (typeof dbPath !== "string" || !dbPath) throw new Error("dbPath is required.");
  if (typeof deviceId !== "string" || !deviceId.trim()) throw new Error("deviceId is required.");
  const origins = normalizeOrigins(allowedOrigins);
  const device = Object.freeze({
    id: deviceId.trim(),
    name: typeof deviceName === "string" && deviceName.trim() ? deviceName.trim() : deviceId.trim(),
    kind: "rover",
  });

  const db = openDatabase(dbPath);
  try {
    initializeHubSchema(db, { telemetryMaxRows, logMaxRows });
  } catch (error) {
    db.close();
    throw error;
  }
  const logger = createLogger(db);
  const events = createSSEManager({ logger });

  const deviceApp = createBaseApp(setActor(() => ROVER_ACTOR));
  // CORS answers preflights before anything else runs.
  const operatorApp = createBaseApp(createCors(origins), setActor(tailnetActor));

  const rover = registerRoverRoutes({
    deviceApp,
    operatorApp,
    db,
    dbRun: createDbRun(),
    logger,
    broadcastEvent: events.broadcast,
    device,
    deviceStaleMs,
    deviceWatchdogTickMs,
    maxWaypointDistM,
    maxSegmentDistM,
  });
  operatorApp.get("/api/events", events.handler(() => rover.statusSnapshot()));

  finishApp(deviceApp, logger);
  finishApp(operatorApp, logger);

  // Ends every event stream so HTTP servers can drain.
  function closeStreams() {
    rover.close();
    events.close();
  }

  function close() {
    closeStreams();
    if (db.open) db.close();
  }

  return { deviceApp, operatorApp, db, device, close, closeStreams };
}

function envInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function envPositiveNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", (error) => (error ? reject(error) : resolve(server)));
  });
}

export async function main() {
  const devicePort = envInteger("HUB_DEVICE_PORT", DEFAULT_DEVICE_PORT, 1, 65535);
  const operatorPort = envInteger("HUB_OPERATOR_PORT", DEFAULT_OPERATOR_PORT, 1, 65535);
  const hub = createHubApp({
    dbPath: process.env.HUB_DB_PATH || DEFAULT_DB_PATH,
    deviceId: process.env.HUB_DEVICE_ID || os.hostname(),
    deviceName: process.env.HUB_DEVICE_NAME,
    allowedOrigins: (process.env.HUB_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean),
    telemetryMaxRows: envInteger("MISSION_TELEMETRY_MAX_ROWS", DEFAULT_TELEMETRY_MAX_ROWS, 1, Number.MAX_SAFE_INTEGER),
    maxWaypointDistM: envPositiveNumber("ROVER_MAX_WAYPOINT_DIST_M", DEFAULT_MAX_WAYPOINT_DIST_M),
    maxSegmentDistM: envPositiveNumber("ROVER_MAX_SEGMENT_DIST_M", DEFAULT_MAX_SEGMENT_DIST_M),
  });
  let servers;
  try {
    servers = [await listen(hub.deviceApp, devicePort), await listen(hub.operatorApp, operatorPort)];
  } catch (error) {
    hub.close();
    throw error;
  }
  console.log(`hub ${hub.device.id}: device API on 127.0.0.1:${devicePort}, operator API on 127.0.0.1:${operatorPort}`);

  let stopping = false;
  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`hub: ${signal} received, shutting down`);
    let open = servers.length;
    const force = setTimeout(() => {
      for (const server of servers) server.closeAllConnections();
    }, 3000);
    force.unref();
    const drained = () => {
      open -= 1;
      if (open > 0) return;
      clearTimeout(force);
      hub.close();
      process.exit(0);
    };
    for (const server of servers) server.close(drained);
    hub.closeStreams();
    for (const server of servers) server.closeIdleConnections();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(`hub: ${error?.message || error}`);
    process.exit(1);
  });
}
