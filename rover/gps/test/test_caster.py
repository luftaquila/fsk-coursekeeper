"""NTRIP caster: fan-out, mountpoint/activation errors, and interop with the
rover's real NTRIPClient."""

import socket
import threading
import time

import pytest

from pilot.lib.ntrip_client import NTRIPClient, parse_source_table
from pilot.lib.rtcm_utils import build_frame

from ntrip_caster import NtripCaster, _Client, build_sourcetable, parse_request


def _wait(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


class _CapturingSerial:
    def __init__(self):
        self._lock = threading.Lock()
        self.data = bytearray()

    def write(self, data):
        with self._lock:
            self.data.extend(data)
        return len(data)

    def snapshot(self):
        with self._lock:
            return bytes(self.data)


@pytest.fixture
def caster():
    c = NtripCaster(host="127.0.0.1", port=0, mountpoint="FSKBASE")
    c.start()
    yield c
    c.stop()


def _request(port, path, v2=True, read_body=True):
    sock = socket.create_connection(("127.0.0.1", port), timeout=3)
    headers = f"GET {path} HTTP/1.1\r\nHost: unit\r\n"
    if v2:
        headers += "Ntrip-Version: Ntrip/2.0\r\n"
    sock.sendall((headers + "Authorization: Basic dTpw\r\n\r\n").encode())
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    if read_body:
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        sock.close()
        return data, None
    return data, sock


def _client(caster, mountpoint="FSKBASE"):
    return NTRIPClient(host="127.0.0.1", port=caster.port, mountpoint=mountpoint,
                       username="", password="", serial_port=_CapturingSerial(),
                       lat=37.5, lon=127.0)


FRAMES = [build_frame(b"\x3e\xd0" + bytes(17)), build_frame(b"\x43\x50" + bytes(40)),
          build_frame(b"\x44\x70" + bytes(33))]


class TestParseRequest:
    def test_v2_request(self):
        method, path, version, headers = parse_request(
            b"GET /FSKBASE?x=1 HTTP/1.1\r\nNtrip-Version: Ntrip/2.0\r\nHost: a")
        assert (method, path, version) == ("GET", "/FSKBASE", "HTTP/1.1")
        assert headers["ntrip-version"] == "Ntrip/2.0"

    @pytest.mark.parametrize("raw", [b"GET /x", b"GET x HTTP/1.1", b"GET /x FTP/1", b"GET /x HTTP/1.1\r\nbad"])
    def test_malformed(self, raw):
        assert parse_request(raw) is None


class TestSourcetable:
    def test_parses_with_the_pilot_parser(self):
        entries = parse_source_table(build_sourcetable("FSKBASE", 37.123, 127.456))
        assert entries == [{"mount": "FSKBASE", "format": "RTCM 3.3", "lat": 37.12, "lon": 127.46}]

    def test_served_at_root(self, caster):
        data, _ = _request(caster.port, "/")
        head, body = data.split(b"\r\n\r\n", 1)
        assert head.startswith(b"HTTP/1.1 200")
        assert b"gnss/sourcetable" in head
        assert body.endswith(b"ENDSOURCETABLE\r\n")

    def test_v1_sourcetable_status(self, caster):
        data, _ = _request(caster.port, "/", v2=False)
        assert data.startswith(b"SOURCETABLE 200 OK")


class TestErrors:
    def test_wrong_mountpoint_is_404(self, caster):
        caster.set_active(True)
        data, _ = _request(caster.port, "/OTHER")
        assert data.startswith(b"HTTP/1.1 404")

    def test_inactive_is_503(self, caster):
        data, _ = _request(caster.port, "/FSKBASE")
        assert data.startswith(b"HTTP/1.1 503")
        assert caster.client_count == 0

    def test_non_get_is_405(self, caster):
        sock = socket.create_connection(("127.0.0.1", caster.port), timeout=3)
        sock.sendall(b"POST /FSKBASE HTTP/1.1\r\nNtrip-Version: Ntrip/2.0\r\n\r\n")
        assert sock.recv(4096).startswith(b"HTTP/1.1 405")
        sock.close()


class TestStreaming:
    def test_raw_client_gets_unchunked_rtcm(self, caster):
        caster.set_active(True, 37.5, 127.0)
        head, sock = _request(caster.port, "/FSKBASE", read_body=False)
        assert head.startswith(b"HTTP/1.1 200 OK")
        assert b"chunked" not in head.lower()
        assert _wait(lambda: caster.client_count == 1)
        for f in FRAMES:
            caster.publish(f)
        expected = b"".join(FRAMES)
        body = head.split(b"\r\n\r\n", 1)[1]
        while len(body) < len(expected):
            body += sock.recv(4096)
        assert body == expected
        sock.close()

    def test_v1_client_gets_icy_status(self, caster):
        caster.set_active(True)
        head, sock = _request(caster.port, "/FSKBASE", v2=False, read_body=False)
        assert head.startswith(b"ICY 200 OK")
        sock.close()

    def test_two_ntrip_clients_receive_the_same_frames(self, caster):
        caster.set_active(True, 37.5, 127.0)
        clients = [_client(caster), _client(caster)]
        for c in clients:
            c.start()
        try:
            assert _wait(lambda: caster.client_count == 2 and all(c.connected for c in clients))
            for f in FRAMES:
                caster.publish(f)
            expected = b"".join(FRAMES)
            assert _wait(lambda: all(c._serial.snapshot() == expected for c in clients))
            assert all(c.bytes_received == len(expected) for c in clients)
        finally:
            for c in clients:
                c.stop()
        assert _wait(lambda: caster.client_count == 0)

    def test_ntrip_client_rejected_on_wrong_mountpoint(self, caster):
        caster.set_active(True)
        client = _client(caster, mountpoint="NOPE")
        with pytest.raises(ConnectionError, match="404"):
            client._connect()
        client._sock.close()

    def test_ntrip_client_rejected_while_inactive(self, caster):
        client = _client(caster)
        with pytest.raises(ConnectionError, match="503"):
            client._connect()
        client._sock.close()

    def test_client_gga_is_drained(self, caster):
        caster.set_active(True)
        head, sock = _request(caster.port, "/FSKBASE", read_body=False)
        assert _wait(lambda: caster.client_count == 1)
        sock.sendall(b"$GPGGA,000000.00,3730.0000000,N,12700.0000000,E,1,12,1.0,0.0,M,0.0,M,,*00\r\n")
        caster.publish(FRAMES[0])
        body = head.split(b"\r\n\r\n", 1)[1]
        while len(body) < len(FRAMES[0]):
            body += sock.recv(4096)
        assert body == FRAMES[0]
        assert caster.client_count == 1
        sock.close()
        assert _wait(lambda: caster.client_count == 0)

    def test_deactivation_disconnects_clients(self, caster):
        caster.set_active(True)
        head, sock = _request(caster.port, "/FSKBASE", read_body=False)
        assert _wait(lambda: caster.client_count == 1)
        caster.set_active(False)
        assert caster.client_count == 0
        sock.settimeout(3)
        assert sock.recv(4096) == b""
        sock.close()

    def test_slow_client_is_dropped(self, caster):
        # A client whose queue is full (its writer is stuck sending) is closed
        # and removed instead of blocking the fan-out to everyone else.
        caster.set_active(True)
        a, b = socket.socketpair()
        stuck = _Client(a, "stuck", max_queue=1)
        stuck.queue.put_nowait(b"pending")
        healthy = _Client(b, "healthy", max_queue=8)
        with caster._lock:
            caster._clients.update({stuck, healthy})
        caster.publish(FRAMES[0])
        assert stuck.closed.is_set()
        assert caster.client_count == 1
        assert healthy.queue.get_nowait() == FRAMES[0]
        caster.set_active(False)
        a.close()
        b.close()

    def test_publish_while_inactive_is_dropped(self, caster):
        caster.publish(FRAMES[0])  # no clients, not active: no error
        assert caster.client_count == 0
