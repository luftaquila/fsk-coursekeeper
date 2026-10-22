import { errorFromResponse } from "fsk-coursekeeper/console/transport.mjs";

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// Starts the storage worker and resolves once it has opened the database.
export function startStorage() {
  const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data?.type === "ready") {
        worker.removeEventListener("message", onMessage);
        resolve({ transport: createWorkerTransport(worker), persistent: event.data.persistent });
      } else if (event.data?.type === "failed") {
        worker.removeEventListener("message", onMessage);
        reject(new Error(event.data.message));
      }
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", (event) => reject(new Error(event.message || "The storage worker failed.")));
  });
}

// The course transport for the console: the same contract as the HTTP
// transport, served by the storage worker.
function createWorkerTransport(worker) {
  let seq = 0;
  const pending = new Map();
  const subscriptions = new Set();

  worker.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "event") {
      for (const subscription of subscriptions) subscription.dispatch(message.name, message.payload);
      return;
    }
    const entry = pending.get(message?.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message);
  });

  function call(message, transfer = []) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...message, id }, transfer);
    });
  }

  async function request(endpoint, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const body = typeof options.body === "string" && options.body ? JSON.parse(options.body) : undefined;
    const result = await call({ type: "request", method, url: endpoint, body });
    const isJson = result.json !== undefined;
    const response = new Response(
      NULL_BODY_STATUSES.has(result.status) ? null : isJson ? JSON.stringify(result.json) : result.text ?? "",
      {
        status: result.status,
        headers: { "Content-Type": isJson ? "application/json" : "text/plain", ...result.headers },
      },
    );
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }

  // A local store never disconnects; announce the link once like EventSource.
  function events() {
    const handlers = new Map();
    const subscription = {
      dispatch(type, payload) {
        const event = { type, data: payload === undefined ? "" : JSON.stringify(payload) };
        for (const handler of handlers.get(type) || []) handler(event);
      },
    };
    subscriptions.add(subscription);
    queueMicrotask(() => subscription.dispatch("open"));
    return {
      addEventListener(type, handler) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(handler);
      },
      close() {
        subscriptions.delete(subscription);
      },
    };
  }

  return {
    request,
    events,
    exportDatabase: async () => new Uint8Array((await call({ type: "export" })).bytes),
    importDatabase: async (bytes) => {
      const copy = bytes.slice().buffer;
      await call({ type: "import", bytes: copy }, [copy]);
    },
  };
}
