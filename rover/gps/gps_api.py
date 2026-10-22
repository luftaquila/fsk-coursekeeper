"""HTTP API of the GPS unit (stdlib only).

Binds to localhost; `tailscale serve` publishes it on the tailnet as HTTPS.
Authorization is tailnet access alone. The Tailscale identity headers name the
actor in the log, never grant anything.

CORS: an exact-match origin allowlist. An allowed origin gets
`Access-Control-Allow-Origin: <origin>`; a disallowed one gets no CORS headers,
a 403 on preflight, and a 403 on state-changing methods. Requests without an
`Origin` header are allowed.
"""

import json
import logging
import queue
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_log = logging.getLogger("gps-register.api")

ALLOWED_METHODS = "GET, POST, PUT, DELETE"
SSE_HEARTBEAT_S = 10.0
_MAX_BODY_BYTES = 16 * 1024
_SSE_CLIENT_QUEUE = 64
_MUTATING_METHODS = frozenset({"POST", "PUT", "DELETE"})


class ApiError(Exception):
    """An API failure rendered as `{ "message", "reason", ...extra }`."""

    def __init__(self, status, reason, message, **extra):
        super().__init__(message)
        self.status = status
        self.reason = reason
        self.message = message
        self.extra = extra

    def body(self):
        return {"message": self.message, "reason": self.reason, **self.extra}


def parse_allowed_origins(raw):
    """Comma list → frozenset of exact origins (a trailing slash is ignored)."""
    return frozenset(
        part.strip().rstrip("/") for part in (raw or "").split(",") if part.strip()
    )


def origin_allowed(origin, allowed):
    """No Origin header (same-origin tooling, curl) counts as allowed."""
    return origin is None or origin in allowed


def cors_headers(origin, allowed):
    """Headers every response carries for `origin`."""
    headers = {"Vary": "Origin"}
    if origin is not None and origin in allowed:
        headers["Access-Control-Allow-Origin"] = origin
    return headers


def preflight_headers(origin, allowed, private_network_requested):
    """Headers for an allowed OPTIONS preflight."""
    headers = cors_headers(origin, allowed)
    headers["Access-Control-Allow-Methods"] = ALLOWED_METHODS
    headers["Access-Control-Allow-Headers"] = "Content-Type"
    headers["Access-Control-Max-Age"] = "600"
    if private_network_requested:
        headers["Access-Control-Allow-Private-Network"] = "true"
    return headers


def sse_frame(event, data):
    payload = json.dumps(data, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n".encode("utf-8")


class _Subscriber:
    def __init__(self):
        self.queue = queue.Queue(maxsize=_SSE_CLIENT_QUEUE)
        self.dropped = threading.Event()


class EventHub:
    """Fans SSE frames out to every `/api/events` connection."""

    def __init__(self):
        self._lock = threading.Lock()
        self._subscribers = set()

    def subscribe(self):
        sub = _Subscriber()
        with self._lock:
            self._subscribers.add(sub)
        return sub

    def unsubscribe(self, sub):
        with self._lock:
            self._subscribers.discard(sub)

    @property
    def subscriber_count(self):
        with self._lock:
            return len(self._subscribers)

    def publish(self, event, data):
        frame = sse_frame(event, data)
        with self._lock:
            for sub in list(self._subscribers):
                try:
                    sub.queue.put_nowait(frame)
                except queue.Full:
                    # A reader that cannot keep up with ~1 event/s is gone.
                    self._subscribers.discard(sub)
                    sub.dropped.set()

    def close_all(self):
        with self._lock:
            subs = list(self._subscribers)
            self._subscribers.clear()
        for sub in subs:
            sub.dropped.set()
            try:
                sub.queue.put_nowait(None)
            except queue.Full:
                pass


# (method, pattern) → handler name on _Handler. Path parameters are integers.
_ROUTES = [
    ("GET", re.compile(r"^/api/health$"), "_health"),
    ("GET", re.compile(r"^/api/events$"), "_events"),
    ("GET", re.compile(r"^/api/gps/status$"), "_status"),
    ("POST", re.compile(r"^/api/gps/capture$"), "_capture"),
    ("GET", re.compile(r"^/api/gps/survey-points$"), "_list_points"),
    ("POST", re.compile(r"^/api/gps/survey-points$"), "_create_point"),
    ("DELETE", re.compile(r"^/api/gps/survey-points/(\d+)$"), "_delete_point"),
    ("POST", re.compile(r"^/api/gps/survey-points/(\d+)/survey$"), "_start_survey"),
    ("POST", re.compile(r"^/api/gps/survey-points/(\d+)/survey/cancel$"), "_cancel_survey"),
    ("GET", re.compile(r"^/api/gps/config$"), "_get_config"),
    ("PUT", re.compile(r"^/api/gps/config$"), "_put_config"),
    ("PUT", re.compile(r"^/api/gps/ntrip-username$"), "_put_ntrip_username"),
]


class _Handler(BaseHTTPRequestHandler):
    server_version = "FSKCoursekeeperGPS/1.0"
    # Bounds a stalled request read and a stalled SSE write alike.
    timeout = 30

    # --- plumbing -----------------------------------------------------------

    @property
    def _ctx(self):
        return self.server.ctx

    def log_message(self, fmt, *args):  # route http.server chatter to logging
        _log.debug("%s %s", self.address_string(), fmt % args)

    def _origin(self):
        return self.headers.get("Origin")

    def _actor(self):
        return (self.headers.get("Tailscale-User-Login")
                or self.headers.get("Tailscale-User-Name")
                or "unknown")

    def _send(self, status, body=None, headers=None):
        data = b""
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self._sent_status = status
        self.send_response(status)
        for name, value in cors_headers(self._origin(), self._ctx.allowed_origins).items():
            self.send_header(name, value)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        if status != 204:  # RFC 9110 §8.6: no Content-Length on 204
            self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if data and self.command != "HEAD":
            self.wfile.write(data)

    def _send_error(self, err):
        self._send(err.status, err.body())

    def _read_json(self):
        length = self.headers.get("Content-Length")
        if not length:
            return {}
        try:
            n = int(length)
        except ValueError:
            raise ApiError(400, "invalid_body", "Invalid Content-Length.")
        if n < 0 or n > _MAX_BODY_BYTES:
            raise ApiError(413, "body_too_large", "Request body is too large.")
        raw = self.rfile.read(n) if n else b""
        if not raw.strip():
            return {}
        try:
            body = json.loads(raw)
        except ValueError:
            raise ApiError(400, "invalid_json", "Request body is not valid JSON.")
        if not isinstance(body, dict):
            raise ApiError(400, "invalid_body", "Request body must be a JSON object.")
        return body

    # --- dispatch -----------------------------------------------------------

    def do_OPTIONS(self):
        origin = self._origin()
        allowed = self._ctx.allowed_origins
        if not origin_allowed(origin, allowed):
            _log.warning("preflight from disallowed origin %r", origin)
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        private = self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true"
        self.send_response(204)
        for name, value in preflight_headers(origin, allowed, private).items():
            self.send_header(name, value)
        self.end_headers()

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        path = self.path.split("?", 1)[0]
        mutating = method in _MUTATING_METHODS
        self._sent_status = None
        try:
            if mutating and not origin_allowed(self._origin(), self._ctx.allowed_origins):
                raise ApiError(403, "origin_not_allowed", "Origin is not allowed.")
            handler, args = self._route(method, path)
            handler(*args)
        except ApiError as err:
            self._send_error(err)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            _log.exception("unhandled error on %s %s", method, path)
            self._send_error(ApiError(500, "internal_error", "Internal server error."))
        if mutating:
            _log.info("%s %s -> %s (actor=%s, origin=%s)",
                      method, path, self._sent_status, self._actor(), self._origin())

    def _route(self, method, path):
        allowed = []
        for route_method, pattern, name in _ROUTES:
            match = pattern.match(path)
            if not match:
                continue
            if route_method == method:
                return getattr(self, name), [int(g) for g in match.groups()]
            allowed.append(route_method)
        if allowed:
            raise ApiError(405, "method_not_allowed", "Method not allowed.")
        raise ApiError(404, "not_found", "Not found.")

    # --- endpoints ----------------------------------------------------------

    def _health(self):
        self._send(200, {"ok": True})

    def _status(self):
        self._send(200, self._ctx.agent.status())

    def _capture(self):
        self._send(200, self._ctx.agent.capture())

    def _list_points(self):
        self._send(200, self._ctx.agent.list_points())

    def _create_point(self):
        body = self._read_json()
        self._send(201, self._ctx.agent.create_point(body.get("name"), self._actor()))

    def _delete_point(self, point_id):
        self._ctx.agent.delete_point(point_id, self._actor())
        self._send(204)

    def _start_survey(self, point_id):
        body = self._read_json()
        self._send(202, self._ctx.agent.start_survey(point_id, body.get("duration_s"), self._actor()))

    def _cancel_survey(self, point_id):
        self._ctx.agent.cancel_survey(point_id, self._actor())
        self._send(204)

    def _get_config(self):
        self._send(200, self._ctx.agent.get_config())

    def _put_config(self):
        body = self._read_json()
        self._send(200, self._ctx.agent.set_config(body, self._actor()))

    def _put_ntrip_username(self):
        body = self._read_json()
        self._send(200, self._ctx.agent.set_ntrip_username(body.get("username"), self._actor()))

    def _events(self):
        ctx = self._ctx
        sub = ctx.events.subscribe()
        try:
            self.send_response(200)
            for name, value in cors_headers(self._origin(), ctx.allowed_origins).items():
                self.send_header(name, value)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            # Current state first, so a fresh console never waits for a change.
            self.wfile.write(sse_frame("gps:status", ctx.agent.status()))
            while not sub.dropped.is_set():
                try:
                    frame = sub.queue.get(timeout=SSE_HEARTBEAT_S)
                except queue.Empty:
                    frame = b": heartbeat\n\n"
                if frame is None:
                    break
                self.wfile.write(frame)
        finally:
            ctx.events.unsubscribe(sub)
        self.close_connection = True


class _Context:
    def __init__(self, agent, events, allowed_origins):
        self.agent = agent
        self.events = events
        self.allowed_origins = allowed_origins


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, ctx):
        super().__init__(address, _Handler)
        self.ctx = ctx


class ApiServer:
    """Runs the HTTP API on a background thread."""

    def __init__(self, agent, events, host="127.0.0.1", port=10200, allowed_origins=frozenset()):
        self._events = events
        self._server = _Server((host, port), _Context(agent, events, frozenset(allowed_origins)))
        self._thread = None

    @property
    def port(self):
        return self._server.server_address[1]

    def start(self):
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        host, port = self._server.server_address[:2]
        _log.info("API listening on http://%s:%d", host, port)

    def stop(self):
        self._events.close_all()
        self._server.shutdown()
        self._server.server_close()
