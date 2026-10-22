import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHubApp } from "../../rover/hub/index.mjs";

// The database sits in its own missing directory so every hub start also
// exercises directory creation.
export function tmpDbPath() {
  return path.join(os.tmpdir(), `fsk-hub-test-${crypto.randomUUID()}`, "hub.db");
}

export function cleanupDb(dbPath) {
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve(server)));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function waitForCondition(check, { timeoutMs = 3000, intervalMs = 10, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
}

export function createClient(baseUrl, defaultHeaders = {}) {
  function request(method, urlPath, { body, headers } = {}) {
    const init = { method, headers: { ...defaultHeaders, ...headers } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(`${baseUrl}${urlPath}`, init);
  }
  // Returns { status, data, headers } with data parsed as JSON when possible.
  async function json(method, urlPath, body, options = {}) {
    const response = await request(method, urlPath, { ...options, body });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    return { status: response.status, data, headers: response.headers };
  }
  return {
    baseUrl,
    request,
    json,
    get: (urlPath, options) => request("GET", urlPath, options),
    post: (urlPath, options) => request("POST", urlPath, options),
    put: (urlPath, options) => request("PUT", urlPath, options),
    delete: (urlPath, options) => request("DELETE", urlPath, options),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Opens an SSE stream and collects its events. readyEvent is awaited before
// returning (the rover stream sends `connected`, the operator stream `init`).
export async function openSse(url, { headers = {}, readyEvent } = {}) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { ...headers, Accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200, `SSE ${url} answered ${response.status}`);
  const events = [];
  const waiters = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          let event = null;
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!event) continue;
          const item = { event, data: data ? JSON.parse(data) : {} };
          const index = waiters.findIndex((waiter) => waiter.event === item.event && (!waiter.match || waiter.match(item.data)));
          if (index >= 0) {
            const [waiter] = waiters.splice(index, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(item);
          } else {
            events.push(item);
          }
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
      }
    }
  })();

  let closed = false;
  const stream = {
    response,
    events,
    waitFor(event, match = null, { timeoutMs = 5000 } = {}) {
      const index = events.findIndex((item) => item.event === event && (!match || match(item.data)));
      if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]);
      const waiter = { event, match, ...deferred() };
      waiter.timer = setTimeout(() => {
        const at = waiters.indexOf(waiter);
        if (at >= 0) waiters.splice(at, 1);
        waiter.reject(new Error(`timed out waiting for SSE event "${event}"`));
      }, timeoutMs);
      waiters.push(waiter);
      return waiter.promise;
    },
    has(event, match = null) {
      return events.some((item) => item.event === event && (!match || match(item.data)));
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await reader.cancel(); } catch { /* already closed */ }
      controller.abort();
      await pump;
      for (const waiter of waiters.splice(0)) clearTimeout(waiter.timer);
      // Let the server-side close handler run before the caller continues.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  if (readyEvent) await stream.waitFor(readyEvent);
  return stream;
}

// Starts a hub with both apps on ephemeral 127.0.0.1 ports.
export async function startHub(options = {}) {
  const ownsDb = options.dbPath === undefined;
  const dbPath = options.dbPath ?? tmpDbPath();
  const hub = createHubApp({
    deviceId: "rover-test",
    deviceName: "Test Rover",
    // Liveness expiry is triggered explicitly by the tests that need it.
    deviceStaleMs: 10 * 60 * 1000,
    ...options,
    dbPath,
  });
  const deviceServer = await listen(hub.deviceApp);
  const operatorServer = await listen(hub.operatorApp);
  const deviceUrl = `http://127.0.0.1:${deviceServer.address().port}`;
  const operatorUrl = `http://127.0.0.1:${operatorServer.address().port}`;
  const streams = new Set();
  const track = (stream) => {
    streams.add(stream);
    const close = stream.close;
    stream.close = async () => {
      streams.delete(stream);
      await close();
    };
    return stream;
  };
  const operator = createClient(operatorUrl);
  return {
    hub,
    db: hub.db,
    dbPath,
    deviceUrl,
    operatorUrl,
    device: createClient(deviceUrl),
    operator,
    async openRover(bootId, { protocolVersion = 2 } = {}) {
      const query = protocolVersion == null ? "" : `?protocol_version=${protocolVersion}&boot_id=${encodeURIComponent(bootId)}`;
      const stream = track(await openSse(`${deviceUrl}/api/rover/stream${query}`, { readyEvent: "connected" }));
      stream.bootId = bootId;
      return stream;
    },
    async openEvents(headers = {}) {
      return track(await openSse(`${operatorUrl}/api/events`, { headers, readyEvent: "init" }));
    },
    async status() {
      const result = await operator.json("GET", "/api/rover/status");
      assert.equal(result.status, 200);
      return result.data;
    },
    async activeMission() {
      const result = await operator.json("GET", "/api/missions/active");
      assert.equal(result.status, 200);
      return result.data.mission;
    },
    async stop({ keepDb = false } = {}) {
      await Promise.all([...streams].map((stream) => stream.close()));
      hub.closeStreams();
      deviceServer.closeAllConnections();
      operatorServer.closeAllConnections();
      await Promise.all([closeServer(deviceServer), closeServer(operatorServer)]);
      await new Promise((resolve) => setImmediate(resolve));
      hub.close();
      if (ownsDb && !keepDb) cleanupDb(dbPath);
    },
  };
}

// Route geometry the browser would send for a cone list.
export function coneItems(points) {
  return points.map(([lat, lng, side = "left", coneId = null, alt = null], index) => ({
    cone_id: coneId ?? index + 1,
    lat,
    lng,
    alt,
    side,
  }));
}

export const TEST_COURSE = Object.freeze({ id: 7, name: "Test Course" });
