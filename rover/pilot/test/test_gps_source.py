"""Tests for gps_node correction-source selection (NGII vs a GPS unit's caster).

Relies on the ROS/hardware stubs installed by conftest.py.
"""

import json
import threading
from types import SimpleNamespace

import pytest

from std_msgs.msg import String
import pilot.gps_node as gps_node_mod
from pilot.gps_node import GpsNode, NGII_SOURCE, ntrip_setup_due
from pilot.lib.ubx_parser import FixType

CASTER = {"source": "caster", "host": "100.64.0.7", "port": 2101, "mountpoint": "FSKBASE"}
NGII_USER = {"source": "ngii", "username": "user"}


class _CapturingSerial:
    def __init__(self):
        self.written = b""
        self.in_waiting = 0

    def write(self, data):
        self.written += bytes(data)
        return len(data)

    def read(self, *_a, **_kw):
        return b""

    def close(self):
        pass


class _FakeClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True


def _node():
    node = GpsNode()
    node._serial = _CapturingSerial()
    return node


def _msg(data):
    m = String()
    m.data = data if isinstance(data, str) else json.dumps(data)
    return m


def _pvt(fix_type=FixType.FIX_3D):
    return SimpleNamespace(fix_type=fix_type, lat=37.5, lon=127.0)


class TestSetupDecision:
    def test_waits_for_3d_fix(self):
        assert not ntrip_setup_due(CASTER, False, FixType.FIX_2D, 100.0, 0.0)
        assert ntrip_setup_due(CASTER, False, FixType.FIX_3D, 100.0, 0.0)

    def test_ngii_needs_username_caster_does_not(self):
        assert not ntrip_setup_due(NGII_SOURCE, False, FixType.FIX_3D, 100.0, 0.0)
        assert ntrip_setup_due(NGII_USER, False, FixType.FIX_3D, 100.0, 0.0)
        assert ntrip_setup_due(CASTER, False, FixType.FIX_3D, 100.0, 0.0)

    def test_existing_client_or_cooldown_blocks(self):
        assert not ntrip_setup_due(CASTER, True, FixType.FIX_3D, 100.0, 0.0)
        assert not ntrip_setup_due(CASTER, False, FixType.FIX_3D, 100.0, 90.0, cooldown_s=30.0)
        assert ntrip_setup_due(CASTER, False, FixType.FIX_3D, 100.0, 70.0, cooldown_s=30.0)


class TestSourceSwitch:
    def test_default_source_is_ngii(self):
        assert _node()._ntrip_source == {"source": "ngii", "username": ""}

    def test_switch_to_caster(self):
        node = _node()
        node._ntrip_last_attempt = 12345.0
        node._on_ntrip_source(_msg(CASTER))
        assert node._ntrip_source == CASTER
        assert node._ntrip_last_attempt == 0.0

    @pytest.mark.parametrize("data", [
        "garbage", '"ngii"', '{"source": "base"}',
        json.dumps({**CASTER, "port": "2101"}),
        json.dumps({**CASTER, "mountpoint": "A B"}),
        json.dumps({"source": "caster", "port": 2101, "mountpoint": "FSKBASE"}),
        json.dumps({"source": "ngii", "username": "a b"}),
    ])
    def test_malformed_selector_keeps_current_source(self, data):
        node = _node()
        node._on_ntrip_source(_msg(CASTER))
        node._on_ntrip_source(_msg(data))
        assert node._ntrip_source == CASTER

    def test_switch_stops_the_existing_client(self):
        node = _node()
        client = _FakeClient()
        node._ntrip = client
        node._on_ntrip_source(_msg(CASTER))
        assert client.stopped is True and node._ntrip is None

    def test_switch_between_casters_stops_the_old_one(self):
        node = _node()
        node._on_ntrip_source(_msg(CASTER))
        client = _FakeClient()
        node._ntrip = client
        node._on_ntrip_source(_msg({**CASTER, "host": "100.64.0.8"}))
        assert client.stopped is True and node._ntrip is None
        assert node._ntrip_source["host"] == "100.64.0.8"

    def test_new_ngii_login_restarts_the_client(self):
        node = _node()
        node._on_ntrip_source(_msg(NGII_USER))
        client = _FakeClient()
        node._ntrip = client
        node._on_ntrip_source(_msg({"source": "ngii", "username": "other"}))
        assert client.stopped is True and node._ntrip is None
        assert node._ntrip_source == {"source": "ngii", "username": "other"}

    def test_same_source_keeps_the_client(self):
        node = _node()
        node._on_ntrip_source(_msg(CASTER))
        client = _FakeClient()
        node._ntrip = client
        node._on_ntrip_source(_msg(dict(CASTER)))
        assert client.stopped is False and node._ntrip is client


class TestSetupWorker:
    def test_caster_connects_without_credentials_or_sourcetable(self, monkeypatch):
        node = _node()
        node._on_ntrip_source(_msg(CASTER))

        def _boom(*_a, **_kw):
            raise AssertionError("caster source must not fetch a source table")

        monkeypatch.setattr(gps_node_mod, "fetch_source_table", _boom)
        monkeypatch.setattr(gps_node_mod, "NTRIPClient", _FakeClient)
        node._ntrip_setup_worker(37.5, 127.0, node._ntrip_source, 10.0, node._serial)
        client = node._ntrip
        assert client.started is True
        assert client.kwargs["host"] == "100.64.0.7" and client.kwargs["port"] == 2101
        assert client.kwargs["mountpoint"] == "FSKBASE"
        assert client.kwargs["username"] == "" and client.kwargs["password"] == ""
        assert client.kwargs["serial_port"] is node._serial
        assert node._ntrip_setup_in_flight is False

    def test_ngii_uses_the_nearest_mountpoint(self, monkeypatch):
        node = _node()
        node._on_ntrip_source(_msg(NGII_USER))
        table = "STR;NEAR;x;RTCM 3.2;;;;;;37.50;127.00;\r\nSTR;FAR;x;RTCM 3.2;;;;;;35.00;129.00;\r\n"
        monkeypatch.setattr(gps_node_mod, "fetch_source_table", lambda *_a, **_kw: table)
        monkeypatch.setattr(gps_node_mod, "NTRIPClient", _FakeClient)
        node._ntrip_setup_worker(37.5, 127.0, node._ntrip_source, 10.0, node._serial)
        assert node._ntrip.kwargs["mountpoint"] == "NEAR"
        assert node._ntrip.kwargs["username"] == "user"
        assert node._ntrip.kwargs["password"] == "gnss"

    def test_worker_aborts_when_source_switched(self, monkeypatch):
        # A worker started for NGII must not connect once the source moved to a
        # caster (and must return before the slow network fetch).
        node = _node()
        stale = node._ntrip_source
        node._on_ntrip_source(_msg(CASTER))

        def _boom(*_a, **_kw):
            raise AssertionError("must not fetch for a stale source")

        monkeypatch.setattr(gps_node_mod, "fetch_source_table", _boom)
        node._ntrip_setup_worker(37.5, 127.0, stale, 10.0, node._serial)
        assert node._ntrip is None

    def test_switch_during_fetch_is_not_overridden(self, monkeypatch):
        node = _node()
        stale = node._ntrip_source

        def _fetch(*_a, **_kw):
            node._on_ntrip_source(_msg(CASTER))  # switch lands mid-fetch
            return "STR;NEAR;x;RTCM 3.2;;;;;;37.50;127.00;\r\n"

        monkeypatch.setattr(gps_node_mod, "fetch_source_table", _fetch)
        monkeypatch.setattr(gps_node_mod, "NTRIPClient", _FakeClient)
        node._ntrip_setup_worker(37.5, 127.0, stale, 10.0, node._serial)
        assert node._ntrip is None

    def test_maybe_setup_spawns_caster_without_username(self, monkeypatch):
        node = _node()
        node._on_ntrip_source(_msg(CASTER))
        done = threading.Event()

        def _client(**kwargs):
            done.set()
            return _FakeClient(**kwargs)

        monkeypatch.setattr(gps_node_mod, "NTRIPClient", _client)
        node._maybe_setup_ntrip(_pvt())
        assert done.wait(2.0)

    def test_maybe_setup_skips_ngii_without_username(self):
        node = _node()
        node._maybe_setup_ntrip(_pvt())
        # No worker was spawned: the attempt bookkeeping is untouched.
        assert node._ntrip_setup_in_flight is False
        assert node._ntrip_last_attempt == 0.0
        assert node._ntrip is None
