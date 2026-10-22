// Transports carry the console's REST calls and event streams to the course
// host or to a device API. Every transport exposes the same contract:
//   request(endpoint, options) → Response; throws an Error with .status and
//     .data (the parsed JSON body, if any) for non-2xx responses
//   events(path = "/api/events") → { addEventListener(type, fn), close() }

export function httpError(status, message, data = null) {
  const error = new Error(message);
  error.status = status;
  error.data = data;
  return error;
}

export async function errorFromResponse(response) {
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const message = data && typeof data.message === "string" ? data.message : text || `Request failed (${response.status})`;
  return httpError(response.status, message, data);
}

// One EventSource per URL: the course host and a device may share an endpoint,
// and each subscription removes only its own listeners when closed.
const sharedStreams = new Map();

function openSharedEventStream(url) {
  let entry = sharedStreams.get(url);
  if (!entry) {
    entry = { source: new EventSource(url), refs: 0 };
    sharedStreams.set(url, entry);
  }
  entry.refs += 1;
  const listeners = [];
  let closed = false;
  return {
    addEventListener(type, listener) {
      if (closed) return;
      entry.source.addEventListener(type, listener);
      listeners.push([type, listener]);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [type, listener] of listeners) entry.source.removeEventListener(type, listener);
      entry.refs -= 1;
      if (entry.refs === 0) {
        entry.source.close();
        sharedStreams.delete(url);
      }
    },
  };
}

export function createHttpTransport(baseUrl, { onUnauthorized = null, credentials = "same-origin" } = {}) {
  async function request(endpoint, options = {}) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      credentials,
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    if (response.status === 401 && onUnauthorized) {
      onUnauthorized();
      throw httpError(401, "Authentication required.");
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }

  return {
    baseUrl,
    request,
    events: (path = "/api/events") => openSharedEventStream(`${baseUrl}${path}`),
  };
}
