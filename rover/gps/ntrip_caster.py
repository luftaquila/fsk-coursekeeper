"""Minimal NTRIP caster for the GPS unit's base-station mode.

Serves one mountpoint. Each accepted client gets every complete RTCM3 frame the
receiver emits while the base station is active. Rovers connect with the pilot's
`NTRIPClient`: an NTRIP v2 (`Ntrip-Version: Ntrip/2.0`) or v1 GET, a status line
containing `200`, then raw RTCM bytes until the connection closes. The body is
never chunked. Credentials are ignored; access control is the tailnet.

Responses:
    GET /               source table (one STR record)
    GET /<mountpoint>   200 + RTCM stream while active, 503 while inactive
    GET /<other>        404
"""

import logging
import queue
import select
import socket
import threading

_log = logging.getLogger("gps-register.caster")

SERVER_NAME = "NTRIP FSKCoursekeeper/1.0"
_MAX_REQUEST_BYTES = 8192
_HANDSHAKE_TIMEOUT_S = 10.0
# A client whose socket accepts nothing for this long is dead.
_SEND_TIMEOUT_S = 10.0
# Frames buffered per client before it counts as slow and is dropped. The
# base emits ~6 frames per navigation epoch, so this is several seconds.
DEFAULT_CLIENT_QUEUE = 512
# RTCM MSM7 + ARP + GLONASS biases enabled by the unit's base configuration.
_SOURCETABLE_FORMAT_DETAILS = "1005(1),1077(1),1087(1),1097(1),1127(1),1230(1)"


class _Client:
    def __init__(self, sock, addr, max_queue):
        self.sock = sock
        self.addr = addr
        self.queue = queue.Queue(maxsize=max_queue)
        self.closed = threading.Event()

    def close(self):
        if self.closed.is_set():
            return
        self.closed.set()
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def parse_request(raw):
    """Parse an NTRIP request header block (bytes up to the blank line).

    Returns (method, path, http_version, headers) with lower-cased header
    names, or None when the request line is malformed."""
    lines = raw.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3:
        return None
    method, target, version = parts
    if not target.startswith("/") or not version.startswith("HTTP/"):
        return None
    headers = {}
    for line in lines[1:]:
        if not line:
            continue
        name, sep, value = line.partition(":")
        if not sep:
            return None
        headers[name.strip().lower()] = value.strip()
    path = target.split("?", 1)[0]
    return method, path, version, headers


def build_sourcetable(mountpoint, lat=None, lng=None):
    """NTRIP source table with the single base mountpoint."""
    lat_s = f"{lat:.2f}" if lat is not None else "0.00"
    lng_s = f"{lng:.2f}" if lng is not None else "0.00"
    record = ";".join([
        "STR", mountpoint, mountpoint, "RTCM 3.3", _SOURCETABLE_FORMAT_DETAILS,
        "2", "GPS+GLO+GAL+BDS", "FSK", "KOR", lat_s, lng_s,
        "0", "0", "FSK Coursekeeper", "none", "N", "N", "0", "",
    ])
    return f"{record}\r\nENDSOURCETABLE\r\n"


class NtripCaster:
    """Single-mountpoint RTCM fan-out over TCP."""

    def __init__(self, host="127.0.0.1", port=2101, mountpoint="FSKBASE",
                 max_client_queue=DEFAULT_CLIENT_QUEUE):
        self._host = host
        self._requested_port = port
        self._mountpoint = mountpoint
        self._max_client_queue = max_client_queue
        self._lock = threading.Lock()
        self._clients = set()
        self._active = False
        self._position = (None, None)
        self._sock = None
        self._thread = None
        self._running = False

    @property
    def mountpoint(self):
        return self._mountpoint

    @property
    def port(self):
        """Bound port once started (the configured port before that)."""
        if self._sock is not None:
            return self._sock.getsockname()[1]
        return self._requested_port

    @property
    def client_count(self):
        with self._lock:
            return len(self._clients)

    @property
    def active(self):
        with self._lock:
            return self._active

    def start(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self._host, self._requested_port))
        sock.listen(16)
        self._sock = sock
        self._running = True
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()
        _log.info("NTRIP caster listening on %s:%d/%s", self._host, self.port, self._mountpoint)

    def stop(self):
        self._running = False
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
        self._drop_all()

    def set_active(self, active, lat=None, lng=None):
        """Open or close the mountpoint. Closing disconnects every client."""
        with self._lock:
            self._active = bool(active)
            self._position = (lat, lng) if active else (None, None)
        if not active:
            self._drop_all()

    def publish(self, frame):
        """Queue one complete RTCM3 frame for every client; drop slow ones."""
        slow = []
        with self._lock:
            if not self._active:
                return
            for client in self._clients:
                try:
                    client.queue.put_nowait(frame)
                except queue.Full:
                    slow.append(client)
            for client in slow:
                self._clients.discard(client)
        for client in slow:
            _log.warning("NTRIP client %s too slow — dropped", client.addr)
            client.close()

    def _drop_all(self):
        with self._lock:
            clients = list(self._clients)
            self._clients.clear()
        for client in clients:
            client.close()

    def _accept_loop(self):
        while self._running:
            try:
                conn, addr = self._sock.accept()
            except OSError:
                if self._running:
                    _log.exception("NTRIP caster accept failed")
                return
            threading.Thread(target=self._serve, args=(conn, addr), daemon=True).start()

    def _serve(self, conn, addr):
        try:
            conn.settimeout(_HANDSHAKE_TIMEOUT_S)
            self._handle(conn, addr)
        except OSError as exc:
            _log.info("NTRIP client %s: %s", addr, exc)
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _handle(self, conn, addr):
        raw = bytearray()
        while b"\r\n\r\n" not in raw:
            chunk = conn.recv(4096)
            if not chunk:
                return
            raw.extend(chunk)
            if len(raw) > _MAX_REQUEST_BYTES:
                self._reply(conn, "HTTP/1.1", 400, "Bad Request")
                return
        request = parse_request(bytes(raw).split(b"\r\n\r\n", 1)[0])
        if request is None:
            self._reply(conn, "HTTP/1.1", 400, "Bad Request")
            return
        method, path, _version, headers = request
        v2 = headers.get("ntrip-version", "").lower() == "ntrip/2.0"
        proto = "HTTP/1.1" if v2 else "HTTP/1.0"
        if method != "GET":
            self._reply(conn, proto, 405, "Method Not Allowed")
            return
        mount = path[1:]
        if mount == "":
            self._send_sourcetable(conn, v2)
            return
        if mount != self._mountpoint:
            self._reply(conn, proto, 404, "Not Found")
            return
        client = _Client(conn, addr, self._max_client_queue)
        with self._lock:
            active = self._active
            if active:
                self._clients.add(client)
        if not active:
            self._reply(conn, proto, 503, "Service Unavailable")
            return
        _log.info("NTRIP client %s connected (%s)", addr, "v2" if v2 else "v1")
        try:
            if v2:
                header = (
                    "HTTP/1.1 200 OK\r\n"
                    "Ntrip-Version: Ntrip/2.0\r\n"
                    f"Server: {SERVER_NAME}\r\n"
                    "Content-Type: gnss/data\r\n"
                    "Cache-Control: no-store\r\n"
                    "Connection: close\r\n"
                    "\r\n"
                )
            else:
                header = "ICY 200 OK\r\n\r\n"
            conn.settimeout(_SEND_TIMEOUT_S)
            conn.sendall(header.encode("ascii"))
            self._stream(client)
        finally:
            with self._lock:
                self._clients.discard(client)
            client.close()
            _log.info("NTRIP client %s disconnected", addr)

    def _stream(self, client):
        conn = client.sock
        while not client.closed.is_set():
            try:
                frame = client.queue.get(timeout=1.0)
            except queue.Empty:
                frame = None
            if frame is not None and not client.closed.is_set():
                parts = [frame]
                while True:
                    try:
                        parts.append(client.queue.get_nowait())
                    except queue.Empty:
                        break
                conn.sendall(b"".join(parts))
            # Discard whatever the client sends (NMEA GGA updates); an orderly
            # close reads as an empty recv.
            readable, _, _ = select.select([conn], [], [], 0)
            if readable:
                if not conn.recv(4096):
                    return

    def _reply(self, conn, proto, status, reason):
        body = f"{status} {reason}\r\n"
        conn.sendall((
            f"{proto} {status} {reason}\r\n"
            f"Server: {SERVER_NAME}\r\n"
            "Content-Type: text/plain\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n"
            "\r\n"
            f"{body}"
        ).encode("ascii"))

    def _send_sourcetable(self, conn, v2):
        with self._lock:
            lat, lng = self._position
        body = build_sourcetable(self._mountpoint, lat, lng).encode("ascii")
        if v2:
            head = (
                "HTTP/1.1 200 OK\r\n"
                "Ntrip-Version: Ntrip/2.0\r\n"
                f"Server: {SERVER_NAME}\r\n"
                "Content-Type: gnss/sourcetable\r\n"
            )
        else:
            head = (
                "SOURCETABLE 200 OK\r\n"
                f"Server: {SERVER_NAME}\r\n"
                "Content-Type: text/plain\r\n"
            )
        conn.sendall((head + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode("ascii") + body)
