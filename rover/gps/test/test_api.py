"""HTTP API: CORS, routing, error shape, and the endpoints over a real server."""

import http.client
import json
import socket

import pytest

import gps_register as gr
from conftest import tight_samples
from gps_api import ApiServer, EventHub, cors_headers, parse_allowed_origins, preflight_headers

ALLOWED = "https://console.example"


@pytest.fixture
def api(make_agent):
    agent, _, caster = make_agent()
    events = EventHub()
    agent._events = events
    server = ApiServer(agent, events, host="127.0.0.1", port=0,
                       allowed_origins=parse_allowed_origins(f"{ALLOWED},https://other.example"))
    server.start()
    yield server, agent, caster
    server.stop()


def call(server, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body) if not isinstance(body, (bytes, str)) else body
        hdrs.setdefault("Content-Type", "application/json")
    conn.request(method, path, body=data, headers=hdrs)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    parsed = json.loads(raw) if raw else None
    return resp.status, {k.lower(): v for k, v in resp.getheaders()}, parsed


class TestCorsHelpers:
    def test_allowed_origin_is_echoed(self):
        assert cors_headers(ALLOWED, {ALLOWED}) == {
            "Vary": "Origin", "Access-Control-Allow-Origin": ALLOWED}

    def test_disallowed_origin_gets_no_allow_header(self):
        assert cors_headers("https://evil.example", {ALLOWED}) == {"Vary": "Origin"}

    def test_private_network_only_when_requested(self):
        assert "Access-Control-Allow-Private-Network" not in preflight_headers(ALLOWED, {ALLOWED}, False)
        assert preflight_headers(ALLOWED, {ALLOWED}, True)["Access-Control-Allow-Private-Network"] == "true"


class TestCors:
    def test_allowed_origin(self, api):
        server, _, _ = api
        status, headers, _ = call(server, "GET", "/api/health", headers={"Origin": ALLOWED})
        assert status == 200
        assert headers["access-control-allow-origin"] == ALLOWED
        assert headers["vary"] == "Origin"

    def test_disallowed_origin_read_has_no_cors_headers(self, api):
        server, _, _ = api
        status, headers, _ = call(server, "GET", "/api/health", headers={"Origin": "https://evil.example"})
        assert status == 200
        assert "access-control-allow-origin" not in headers

    def test_no_origin_is_allowed(self, api):
        server, _, _ = api
        status, headers, _ = call(server, "POST", "/api/gps/survey-points", {"name": "A"})
        assert status == 201
        assert "access-control-allow-origin" not in headers

    def test_disallowed_origin_cannot_mutate(self, api):
        server, agent, _ = api
        status, headers, body = call(server, "POST", "/api/gps/survey-points", {"name": "A"},
                                     headers={"Origin": "https://evil.example"})
        assert status == 403 and body["reason"] == "origin_not_allowed"
        assert "access-control-allow-origin" not in headers
        assert agent.list_points() == []

    def test_preflight_allowed(self, api):
        server, _, _ = api
        status, headers, body = call(server, "OPTIONS", "/api/gps/config", headers={
            "Origin": ALLOWED, "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "content-type"})
        assert status == 204 and body is None
        assert headers["access-control-allow-origin"] == ALLOWED
        assert headers["access-control-allow-methods"] == "GET, POST, PUT, DELETE"
        assert headers["access-control-allow-headers"] == "Content-Type"
        assert "access-control-allow-private-network" not in headers

    def test_preflight_private_network(self, api):
        server, _, _ = api
        status, headers, _ = call(server, "OPTIONS", "/api/gps/status", headers={
            "Origin": ALLOWED, "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Private-Network": "true"})
        assert status == 204
        assert headers["access-control-allow-private-network"] == "true"

    def test_preflight_disallowed(self, api):
        server, _, _ = api
        status, headers, _ = call(server, "OPTIONS", "/api/gps/status", headers={
            "Origin": "https://evil.example", "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Private-Network": "true"})
        assert status == 403
        assert not any(k.startswith("access-control-") for k in headers)


class TestRouting:
    def test_unknown_path(self, api):
        server, _, _ = api
        status, _, body = call(server, "GET", "/api/nope")
        assert status == 404 and body == {"message": "Not found.", "reason": "not_found"}

    def test_wrong_method(self, api):
        server, _, _ = api
        status, _, body = call(server, "DELETE", "/api/gps/status")
        assert status == 405 and body["reason"] == "method_not_allowed"

    def test_invalid_json(self, api):
        server, _, _ = api
        status, _, body = call(server, "POST", "/api/gps/survey-points", "{nope")
        assert status == 400 and body["reason"] == "invalid_json"

    def test_non_object_body(self, api):
        server, _, _ = api
        status, _, body = call(server, "PUT", "/api/gps/config", [1])
        assert status == 400 and body["reason"] == "invalid_body"


class TestEndpoints:
    def test_status(self, api):
        server, _, _ = api
        status, _, body = call(server, "GET", "/api/gps/status")
        assert status == 200
        assert body["device"]["kind"] == "gps" and body["mode"] == "capture"
        assert body["base"]["host"] == "100.64.0.7" and body["base"]["mountpoint"] == "FSKBASE"

    def test_survey_point_crud(self, api, make_agent):
        server, _, _ = api
        status, _, point = call(server, "POST", "/api/gps/survey-points", {"name": "Alpha"})
        assert status == 201 and point["name"] == "Alpha"
        status, _, body = call(server, "POST", "/api/gps/survey-points", {"name": "Alpha"})
        assert status == 409 and body["reason"] == "duplicate_name"
        status, _, body = call(server, "POST", "/api/gps/survey-points", {"name": "x" * 101})
        assert status == 400 and body["reason"] == "invalid_name"
        status, _, points = call(server, "GET", "/api/gps/survey-points")
        assert status == 200 and [p["id"] for p in points] == [point["id"]]
        # Persisted: a fresh agent on the same state dir sees the point.
        assert [p["name"] for p in make_agent()[0].list_points()] == ["Alpha"]
        status, _, body = call(server, "DELETE", f"/api/gps/survey-points/{point['id']}")
        assert status == 204 and body is None
        status, _, body = call(server, "DELETE", f"/api/gps/survey-points/{point['id']}")
        assert status == 404 and body["reason"] == "point_not_found"
        assert make_agent()[0].list_points() == []

    def test_survey_start_and_cancel(self, api):
        server, _, _ = api
        _, _, point = call(server, "POST", "/api/gps/survey-points", {"name": "A"})
        path = f"/api/gps/survey-points/{point['id']}/survey"
        status, _, body = call(server, "POST", path, {"duration_s": 5})
        assert status == 400 and body["reason"] == "invalid_duration"
        status, _, body = call(server, "POST", path, {"duration_s": 30})
        assert status == 202 and body["duration_s"] == 30 and body["point_id"] == point["id"]
        _, _, st = call(server, "GET", "/api/gps/status")
        assert st["base"]["state"] == "surveying" and st["base"]["survey"]["duration_s"] == 30
        status, _, body = call(server, "POST", "/api/gps/capture")
        assert status == 409 and body["reason"] == "survey_in_progress"
        status, _, _ = call(server, "POST", path + "/cancel")
        assert status == 204
        _, _, st = call(server, "GET", "/api/gps/status")
        assert st["base"]["state"] == "idle"

    def test_config_switching_guard(self, api):
        server, agent, caster = api
        _, _, point = call(server, "POST", "/api/gps/survey-points", {"name": "BASE"})
        status, _, body = call(server, "PUT", "/api/gps/config",
                               {"mode": "base", "active_base_point_id": point["id"]})
        assert status == 409 and body["reason"] == "point_not_surveyed"
        agent._finish_survey(point["id"], tight_samples())
        status, _, cfg = call(server, "PUT", "/api/gps/config",
                              {"mode": "base", "active_base_point_id": point["id"]})
        assert status == 200
        assert cfg == {"mode": "base", "active_base_point_id": point["id"],
                       "caster": {"host": "100.64.0.7", "port": 2101, "mountpoint": "FSKBASE"}}
        assert caster.active is True
        status, _, body = call(server, "DELETE", f"/api/gps/survey-points/{point['id']}")
        assert status == 409 and body["reason"] == "active_base_point"
        status, _, body = call(server, "POST", "/api/gps/capture")
        assert status == 409 and body["reason"] == "base_mode"
        status, _, cfg = call(server, "PUT", "/api/gps/config", {"mode": "capture"})
        assert status == 200 and cfg["mode"] == "capture" and cfg["active_base_point_id"] is None
        assert caster.active is False
        status, _, cfg = call(server, "GET", "/api/gps/config")
        assert cfg["mode"] == "capture"

    def test_capture_failure_is_422(self, api, monkeypatch):
        server, _, _ = api
        monkeypatch.setattr(gr, "CAPTURE_WINDOW_S", 0.05)
        status, _, body = call(server, "POST", "/api/gps/capture")
        assert status == 422
        assert body["reason"] == "capture_failed" and body["samples"] == 0 and body["message"]


class TestEvents:
    @staticmethod
    def _read_event(f):
        name, data = None, None
        while True:
            line = f.readline().decode().rstrip("\n")
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
            elif line == "" and name:
                return name, data

    def test_stream_sends_status_then_published_events(self, api):
        server, agent, _ = api
        sock = socket.create_connection(("127.0.0.1", server.port), timeout=5)
        sock.sendall(f"GET /api/events HTTP/1.1\r\nHost: x\r\nOrigin: {ALLOWED}\r\n\r\n".encode())
        f = sock.makefile("rb")
        head = b""
        while not head.endswith(b"\r\n\r\n"):
            head += f.readline()
        assert head.startswith(b"HTTP/1.0 200")
        assert b"Content-Type: text/event-stream" in head
        assert f"Access-Control-Allow-Origin: {ALLOWED}".encode() in head
        name, data = self._read_event(f)
        assert name == "gps:status" and data["device"]["kind"] == "gps"
        point = agent.create_point("A")
        agent._finish_survey(point["id"], [])
        assert self._read_event(f) == ("gps:survey_result", {
            "point_id": point["id"], "name": "A", "ok": False,
            "error": "insufficient_samples", "samples": 0})
        sock.close()


def test_mutations_are_audited_with_actor_and_status(api, caplog):
    server, _, _ = api
    with caplog.at_level("INFO", logger="gps-register.api"):
        call(server, "POST", "/api/gps/survey-points", {"name": "A"},
             headers={"Tailscale-User-Login": "alice@example.com", "Origin": ALLOWED})
        call(server, "POST", "/api/gps/survey-points", {"name": "A"},
             headers={"Tailscale-User-Name": "Bob"})
    lines = [r.getMessage() for r in caplog.records if r.name == "gps-register.api"]
    assert any("-> 201" in m and "actor=alice@example.com" in m for m in lines)
    assert any("-> 409" in m and "actor=Bob" in m for m in lines)
