// Operator event stream (GET /api/events). Every connection receives every
// event: access is tailnet-only, so there is no per-connection filter.
export function createSSEManager({ maxClients = 100, heartbeatMs = 15000, logger = null } = {}) {
  const clients = new Set();
  let closed = false;
  let lastRejectWarnAt = 0;
  // A client whose socket buffer backs up this far is slow or half-open. It is
  // dropped; EventSource reconnects and the console resynchronizes.
  const BACKPRESSURE_BYTES = 4 * 1024 * 1024;

  function writeTo(res, message) {
    try {
      if (res.writableLength > BACKPRESSURE_BYTES) {
        clients.delete(res);
        res.destroy();
        return;
      }
      res.write(message);
    } catch {
      clients.delete(res);
    }
  }

  function broadcast(event, data) {
    if (closed) return;
    const message = `event: ${String(event).replace(/[\r\n]/g, "")}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) writeTo(res, message);
  }

  const heartbeat = setInterval(() => {
    for (const res of clients) writeTo(res, ": heartbeat\n\n");
  }, heartbeatMs);
  heartbeat.unref?.();

  // initData(req) is sent as the first `init` event of each connection.
  function handler(initData) {
    return (req, res) => {
      if (closed) return res.status(503).send("The hub is shutting down.");
      if (clients.size >= maxClients) {
        const now = Date.now();
        if (now - lastRejectWarnAt > 60_000) {
          lastRejectWarnAt = now;
          logger?.warn(req, "events.rejected", { reason: "max_clients", clients: clients.size }, "events");
        }
        return res.status(503).send("Too many event stream connections.");
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      let init = {};
      try {
        init = initData ? initData(req) : {};
      } catch (error) {
        logger?.warn(req, "events.init_failed", { error: error?.message || String(error) }, "events");
      }
      writeTo(res, `event: init\ndata: ${JSON.stringify(init)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const res of clients) {
      try { res.end(); } catch { /* already closed */ }
    }
    clients.clear();
  }

  return { broadcast, handler, close };
}
