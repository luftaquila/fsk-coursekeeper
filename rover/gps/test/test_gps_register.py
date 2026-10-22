"""Unit tests for the pure logic of the GPS-registration agent."""

import threading
from types import SimpleNamespace

from pilot.lib.ubx_parser import CarrierSolution, FixType

import gps_register as gr


def _pvt(fix_type, carrier=CarrierSolution.NONE):
    return SimpleNamespace(fix_type=fix_type, carrier_solution=carrier)


class TestFixStatusString:
    def test_rtk_fixed_wins_over_fix_type(self):
        assert gr.fix_status_string(
            _pvt(FixType.FIX_3D, CarrierSolution.FIXED)) == "rtk_fixed"

    def test_rtk_float(self):
        assert gr.fix_status_string(
            _pvt(FixType.FIX_3D, CarrierSolution.FLOAT)) == "rtk_float"

    def test_plain_3d_fix(self):
        assert gr.fix_status_string(_pvt(FixType.FIX_3D)) == "3d_fix"

    def test_2d_fix(self):
        assert gr.fix_status_string(_pvt(FixType.FIX_2D)) == "2d_fix"

    def test_no_fix(self):
        assert gr.fix_status_string(_pvt(FixType.NO_FIX)) == "no_fix"

    def test_dead_reckoning_maps_to_no_fix(self):
        # No IMU on this unit — DR transitions are spurious.
        assert gr.fix_status_string(_pvt(FixType.DEAD_RECKONING)) == "no_fix"


class TestSplitHp:
    def test_roundtrip_positive_lat(self):
        deg = 37.1234567891
        main, hp = gr.split_hp(round(deg * 1e9))
        assert 0 <= hp <= 99
        assert abs((main * 1e-7 + hp * 1e-9) - deg) < 1e-9

    def test_roundtrip_negative(self):
        deg = -122.9876543219
        main, hp = gr.split_hp(round(deg * 1e9))
        assert 0 <= hp <= 99
        assert abs((main * 1e-7 + hp * 1e-9) - deg) < 1e-9

    def test_height_units(self):
        # height coarse = cm, fine = 0.1 mm
        alt_m = 41.2345
        main, hp = gr.split_hp(round(alt_m * 1e4))
        assert 0 <= hp <= 99
        assert abs((main * 0.01 + hp * 0.0001) - alt_m) < 1e-4


class TestAverageSurveySamples:
    def test_none_on_empty(self):
        assert gr.average_survey_samples([]) is None

    def test_mean_of_samples(self):
        samples = [(10.0, 20.0, 30.0, 0.02), (10.2, 20.2, 32.0, 0.04)]
        lat, lon, alt, h_acc, n = gr.average_survey_samples(samples)
        assert n == 2
        assert abs(lat - 10.1) < 1e-9 and abs(lon - 20.1) < 1e-9
        assert abs(alt - 31.0) < 1e-9 and abs(h_acc - 0.03) < 1e-9

    def test_alt_hacc_optional(self):
        samples = [(1.0, 2.0, None, None), (1.0, 2.0, None, None)]
        lat, lon, alt, h_acc, n = gr.average_survey_samples(samples)
        assert alt is None and h_acc is None and n == 2


class TestConfigureBase:
    """_configure_base must emit a UBX-CFG-VALSET setting TMODE FIXED (LLH) and
    enabling the RTCM3 output messages."""

    _SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8}

    @classmethod
    def _decode_valset(cls, msg):
        assert msg[0] == 0xB5 and msg[1] == 0x62  # UBX sync
        length = msg[4] | (msg[5] << 8)
        payload = msg[6:6 + length]
        i = 4  # skip version(1) + layer(1) + reserved(2)
        out = {}
        while i + 4 <= len(payload):
            key = int.from_bytes(payload[i:i + 4], "little"); i += 4
            size = cls._SIZE[(key >> 28) & 0x07]
            out[key] = int.from_bytes(payload[i:i + size], "little"); i += size
        return out

    def test_emits_tmode_fixed_and_rtcm(self):
        class _FakeSerial:
            def __init__(self): self.written = b""
            def write(self, data): self.written += bytes(data)

        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._serial = _FakeSerial()
        agent._meas_rate_ms = 100
        agent._configure_base(37.5, 127.0, 40.0, 0.01)

        cfg = self._decode_valset(agent._serial.written)
        assert cfg[gr.CFG_TMODE_MODE] == 2       # FIXED
        assert cfg[gr.CFG_TMODE_POS_TYPE] == 1   # LLH
        assert cfg[gr.CFG_TMODE_FIXED_POS_ACC] == 100  # 0.01 m -> 100 * 0.1mm
        for key in gr._RTCM_MSGOUT_KEYS:
            assert cfg[key] == 10                # every 10th 100 ms epoch -> 1 Hz

    def test_rtcm_divider_keeps_base_output_at_1hz(self):
        assert gr.rtcm_epoch_divider(100) == 10
        assert gr.rtcm_epoch_divider(200) == 5
        assert gr.rtcm_epoch_divider(1000) == 1
        assert gr.rtcm_epoch_divider(2000) == 1  # slower fixes: every epoch

    def test_emits_scaled_tmode_llh_main_and_hp(self):
        # The main+HP decomposition of lat/lon/height must be wired straight from
        # split_hp — a regression in the scaling or the signed format would place
        # the base ARP metres off and skew every rover fix.
        class _FakeSerial:
            def __init__(self): self.written = b""
            def write(self, data): self.written += bytes(data)

        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._serial = _FakeSerial()
        agent._meas_rate_ms = 100
        lat, lon, alt, acc = 37.5000000123, 127.0000000456, 40.1234, 0.02
        agent._configure_base(lat, lon, alt, acc)
        cfg = self._decode_valset(agent._serial.written)

        lat_main, lat_hp = gr.split_hp(int(round(lat * 1e9)))
        lon_main, lon_hp = gr.split_hp(int(round(lon * 1e9)))
        h_main, h_hp = gr.split_hp(int(round(alt * 1e4)))
        assert cfg[gr.CFG_TMODE_LAT] == lat_main
        assert cfg[gr.CFG_TMODE_LAT_HP] == lat_hp
        assert cfg[gr.CFG_TMODE_LON] == lon_main
        assert cfg[gr.CFG_TMODE_LON_HP] == lon_hp
        assert cfg[gr.CFG_TMODE_HEIGHT] == h_main
        assert cfg[gr.CFG_TMODE_HEIGHT_HP] == h_hp
        assert cfg[gr.CFG_TMODE_FIXED_POS_ACC] == 200   # 0.02 m -> 200 * 0.1mm
        # HP fields must be non-zero here (proves they aren't hard-zeroed).
        assert lat_hp != 0 and lon_hp != 0

    def test_stop_disables_tmode_and_rtcm(self):
        class _FakeSerial:
            def __init__(self): self.written = b""
            def write(self, data): self.written += bytes(data)

        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._serial = _FakeSerial()
        agent._configure_base_stop()
        cfg = self._decode_valset(agent._serial.written)
        assert cfg[gr.CFG_TMODE_MODE] == 0
        for key in gr._RTCM_MSGOUT_KEYS:
            assert cfg[key] == 0

    def test_capture_config_clears_persisted_base(self):
        # Capture-mode config runs on every serial open and must clear any
        # persisted TMODE FIXED + RTCM output (BBR survives restarts), so a
        # restart after a base session can't silently report the base coordinate.
        class _FakeSerial:
            def __init__(self): self.written = b""
            def write(self, data): self.written += bytes(data)

        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._serial = _FakeSerial()
        agent._meas_rate_ms = 1000
        agent._configure_receiver()
        cfg = self._decode_valset(agent._serial.written)
        assert cfg[gr.CFG_TMODE_MODE] == 0                  # TMODE disabled
        for key in gr._RTCM_MSGOUT_KEYS:
            assert cfg[key] == 0                            # RTCM output off
        assert cfg[gr.CFG_MSGOUT_UBX_NAV_PVT_USB] == 1      # NAV output still on


class TestNtripWorkerBaseGuard:
    """The NGII setup worker must not start a client once we are a base station
    (mirrors gps_node._ntrip_setup_worker) — else it leaks a live NGII client."""

    def test_worker_aborts_in_base_output(self, monkeypatch):
        agent = gr.GpsRegisterAgent.__new__(gr.GpsRegisterAgent)
        agent._lock = threading.Lock()
        agent._mode = "base-output"
        agent._ntrip = None
        agent._serial = object()
        agent._ntrip_username = "user"
        called = {"fetch": False}

        def _boom(*_a, **_kw):
            called["fetch"] = True
            raise AssertionError("must not fetch the source table in base mode")

        monkeypatch.setattr(gr, "fetch_source_table", _boom)
        agent._ntrip_setup_worker(37.5, 127.0, agent._serial)
        assert agent._ntrip is None
        assert called["fetch"] is False


class TestEvaluateCapture:
    """Cone capture only resolves on enough STABLE rtk_fixed samples."""

    def test_none_when_too_few(self):
        assert gr.evaluate_capture([(37.0, 127.0, 30.0, 0.01)], min_samples=15) is None

    def test_averages_when_stable(self):
        # 20 samples within ~1cm of each other -> stable, returns the mean.
        samples = [(37.5 + i * 1e-8, 127.0 + i * 1e-8, 30.0, 0.01) for i in range(20)]
        res = gr.evaluate_capture(samples, min_samples=15, max_dev_m=0.03)
        assert res is not None
        lat, lng, alt = res
        assert abs(lat - 37.5) < 1e-6 and abs(lng - 127.0) < 1e-6

    def test_none_when_moving(self):
        # 20 samples but one is ~10 m away -> not stable -> None.
        samples = [(37.5, 127.0, 30.0, 0.01) for _ in range(19)]
        samples.append((37.5001, 127.0, 30.0, 0.01))  # ~11 m north
        assert gr.evaluate_capture(samples, min_samples=15, max_dev_m=0.03) is None


class TestEvaluateSurvey:
    """Base survey accepts a coordinate only with enough tightly-clustered
    rtk_fixed samples; otherwise it returns a reason string."""

    def test_insufficient_when_too_few(self):
        samples = [(37.5, 127.0, 30.0, 0.01) for _ in range(5)]
        assert gr.evaluate_survey(samples, min_samples=60) == "insufficient_samples"

    def test_unstable_when_scattered(self):
        # 100 samples but spread over ~100 m → RMS far exceeds the threshold.
        samples = [(37.5 + i * 1e-5, 127.0, 30.0, 0.01) for i in range(100)]
        assert gr.evaluate_survey(samples, min_samples=60, max_std_m=0.10) == "unstable"

    def test_mean_when_enough_and_tight(self):
        samples = [(37.5 + i * 1e-9, 127.0 + i * 1e-9, 30.0, 0.01) for i in range(80)]
        res = gr.evaluate_survey(samples, min_samples=60, max_std_m=0.10)
        assert not isinstance(res, str)
        lat, lon, alt, h_acc, n, std = res
        assert n == 80 and std < 0.10
        assert abs(lat - 37.5) < 1e-6 and abs(lon - 127.0) < 1e-6


# ---- agent (constructed without hardware via the make_agent fixture) --------

from conftest import tight_samples  # noqa: E402
from gps_api import ApiError  # noqa: E402
from pilot.lib.rtcm_utils import build_frame  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import subprocess  # noqa: E402

import pytest  # noqa: E402


def _hp(lat=37.5, lon=127.0, height=65.0, h_msl=40.0, h_acc=0.01):
    return SimpleNamespace(lat=lat, lon=lon, height=height, h_msl=h_msl, h_acc=h_acc)


def _surveyed_point(agent, name="BASE"):
    point = agent.create_point(name)
    agent._finish_survey(point["id"], tight_samples())
    return next(p for p in agent.list_points() if p["id"] == point["id"])


def _api_error(fn, *args, **kwargs):
    with pytest.raises(ApiError) as exc:
        fn(*args, **kwargs)
    return exc.value


class TestSurveySampleHeight:
    """Survey must record ELLIPSOIDAL height (feeds TMODE LLH), not MSL."""

    def test_on_hpposllh_collects_ellipsoidal_height(self, make_agent):
        agent, _, _ = make_agent()
        agent._survey = {"point_id": 1, "samples": [], "started_at": 0, "duration_s": 60}
        agent._fix_status = "rtk_fixed"
        agent._on_hpposllh(_hp())
        # The sampled altitude must be the ellipsoidal height (65.0), never MSL (40.0).
        assert agent._survey["samples"] == [(37.5, 127.0, 65.0, 0.01)]

    def test_no_sample_unless_rtk_fixed(self, make_agent):
        agent, _, _ = make_agent()
        agent._survey = {"point_id": 1, "samples": [], "started_at": 0, "duration_s": 60}
        agent._fix_status = "rtk_float"
        agent._on_hpposllh(_hp(h_acc=0.5))
        assert agent._survey["samples"] == []

    def test_capture_collects_msl_height_in_capture_mode(self, make_agent):
        agent, _, _ = make_agent()
        agent._capture = {"waiters": [], "samples": []}
        agent._fix_status = "rtk_fixed"
        agent._on_hpposllh(_hp())
        # Cones carry MSL altitude (40.0), not ellipsoidal (65.0).
        assert agent._capture["samples"] == [(37.5, 127.0, 40.0, 0.01)]

    def test_capture_does_not_collect_in_base_output_mode(self, make_agent):
        # A capture left running when base output activates must not absorb the
        # fixed base ARP (which the F9P emits as rtk_fixed) as a cone.
        agent, _, _ = make_agent()
        agent._capture = {"waiters": [], "samples": []}
        agent._fix_status = "rtk_fixed"
        agent._mode = "base-output"
        agent._on_hpposllh(_hp())
        assert agent._capture["samples"] == []


class TestLastPosition:
    """last_position must never carry a no-fix (0, 0) — that jumps the
    operator map to Null Island — nor the base's own ARP."""

    @pytest.mark.parametrize("fix", [None, "no_fix", "time_only"])
    def test_no_fix_is_not_recorded(self, make_agent, fix):
        agent, _, _ = make_agent()
        agent._fix_status = fix
        agent._on_hpposllh(_hp(lat=0.0, lon=0.0))
        assert agent.status()["last_position"] is None

    @pytest.mark.parametrize("fix", ["2d_fix", "3d_fix", "rtk_float", "rtk_fixed"])
    def test_valid_fix_is_recorded_with_timestamp(self, make_agent, fix):
        agent, _, _ = make_agent()
        agent._fix_status = fix
        agent._on_hpposllh(_hp())
        pos = agent.status()["last_position"]
        assert pos["lat"] == 37.5 and pos["lng"] == 127.0 and pos["alt"] == 40.0
        assert isinstance(pos["at"], int) and pos["at"] > 0

    def test_base_output_does_not_record(self, make_agent):
        agent, _, _ = make_agent()
        agent._fix_status = "rtk_fixed"
        agent._mode = "base-output"
        agent._on_hpposllh(_hp())
        assert agent.status()["last_position"] is None


class TestStatus:
    def test_shape_in_capture_mode(self, make_agent):
        agent, _, _ = make_agent()
        status = agent.status()
        assert status["device"] == {"id": "fsk-coursekeeper-gps", "name": "fsk-coursekeeper-gps",
                                    "kind": "gps", "version": "dev"}
        assert status["receiver_connected"] is False  # no serial opened
        assert status["mode"] == "capture"
        assert status["fix_status"] is None and status["gps"] is None
        assert status["ntrip_connected"] is False and status["ntrip"] is None
        assert status["base"] == {
            "state": "idle", "point_id": None, "survey": None, "rtcm_bytes": 0,
            "clients": 0, "host": "100.64.0.7", "mountpoint": "FSKBASE", "port": 2101,
        }

    def test_survey_progress(self, make_agent):
        agent, _, _ = make_agent()
        point = agent.create_point("P1")
        agent._survey = {"point_id": point["id"], "samples": [(1, 2, 3, 4)] * 5,
                         "started_at": 1234, "duration_s": 60}
        base = agent.status()["base"]
        assert base["state"] == "surveying" and base["point_id"] == point["id"]
        assert base["survey"] == {"started_at": 1234, "duration_s": 60, "samples": 5}

    def test_host_is_null_without_tailscale(self, make_agent):
        agent, _, _ = make_agent(tailscale_ip=None)
        assert agent.status()["base"]["host"] is None
        assert agent.get_config()["caster"]["host"] is None

    def test_status_loop_publishes_on_notify(self, make_agent):
        agent, events, _ = make_agent(status_interval=0.05)
        thread = threading.Thread(target=agent._status_loop, daemon=True)
        thread.start()
        agent.notify_status()
        for _ in range(100):
            if events.named("gps:status"):
                break
            threading.Event().wait(0.01)
        agent.stop()
        thread.join(timeout=2)
        assert events.named("gps:status")[0]["mode"] == "capture"


class TestFeedBaseOutput:
    def test_rtcm_frames_go_to_caster(self, make_agent):
        agent, _, caster = make_agent()
        point = _surveyed_point(agent)
        agent._activate_base(point)
        agent._mode = "base-output"
        agent._rtcm_framer = gr.RTCM3Framer()
        frame_a = build_frame(b"\x43\x50" + bytes(20))
        frame_b = build_frame(b"\x3e\xd0" + bytes(10))
        agent._feed(b"\x00junk" + frame_a + frame_b[:5])
        agent._feed(frame_b[5:])
        assert caster.frames == [frame_a, frame_b]
        assert agent.status()["base"]["rtcm_bytes"] == len(frame_a) + len(frame_b)
        assert agent.status()["receiver_connected"] is False  # serial not open

    def test_capture_mode_does_not_publish_rtcm(self, make_agent):
        agent, _, caster = make_agent()
        agent._feed(build_frame(b"\x43\x50" + bytes(20)))
        assert caster.frames == []


class TestBaseActivation:
    def test_activate_then_deactivate(self, make_agent):
        agent, _, caster = make_agent()
        point = _surveyed_point(agent)
        agent._activate_base(point)
        assert agent._mode == "base-output"
        assert agent._pending_reconfig == ("base", agent._base_params)
        assert agent._base_params["lat"] == point["lat"]
        assert agent._base_params["acc"] == point["h_acc_m"]
        assert caster.active is True
        agent._deactivate_base()
        assert agent._mode == "capture"
        assert agent._pending_reconfig == ("capture", None)
        assert agent._base_params is None
        assert caster.active is False

    def test_activation_cancels_running_survey(self, make_agent):
        agent, _, _ = make_agent()
        point = _surveyed_point(agent)
        agent._mode = "base-survey"
        agent._survey = {"point_id": point["id"], "samples": [], "started_at": 0, "duration_s": 60}
        agent._activate_base(point)
        assert agent._survey is None


class TestCapture:
    def test_refused_in_base_mode(self, make_agent):
        agent, _, _ = make_agent()
        agent._mode = "base-output"
        err = _api_error(agent.capture)
        assert (err.status, err.reason) == (409, "base_mode")

    def test_refused_while_surveying(self, make_agent):
        agent, _, _ = make_agent()
        agent._mode = "base-survey"
        err = _api_error(agent.capture)
        assert (err.status, err.reason) == (409, "survey_in_progress")

    def test_no_stable_fix_is_422(self, make_agent, monkeypatch):
        agent, _, _ = make_agent()
        monkeypatch.setattr(gr, "CAPTURE_WINDOW_S", 0.05)
        err = _api_error(agent.capture)
        assert (err.status, err.reason) == (422, "capture_failed")
        assert err.body()["samples"] == 0

    def test_timeout_is_504(self, make_agent, monkeypatch):
        agent, _, _ = make_agent()
        monkeypatch.setattr(agent, "_start_capture", lambda: gr._CaptureWaiter())
        err = _api_error(agent.capture, timeout=0.01)
        assert (err.status, err.reason) == (504, "capture_timeout")

    def test_stable_fix_returns_coordinate(self, make_agent):
        agent, _, _ = make_agent()
        agent._fix_status = "rtk_fixed"
        waiter = agent._start_capture()
        for i in range(gr.CAPTURE_MIN_SAMPLES):
            agent._on_hpposllh(_hp(lat=37.5 + i * 1e-9))
        assert waiter.event.wait(3.0)
        lat, lng, alt = waiter.result
        assert abs(lat - 37.5) < 1e-6 and abs(lng - 127.0) < 1e-6 and alt == 40.0

    def test_capture_maps_result(self, make_agent, monkeypatch):
        agent, _, _ = make_agent()
        waiter = gr._CaptureWaiter()
        waiter.resolve((37.5, 127.0, 40.0), 12)
        monkeypatch.setattr(agent, "_start_capture", lambda: waiter)
        assert agent.capture() == {"lat": 37.5, "lng": 127.0, "alt": 40.0}


class TestCaptureWorker:
    def test_joins_concurrent_requests_into_one_window(self, make_agent):
        agent, _, _ = make_agent()
        agent._capture = {"waiters": [gr._CaptureWaiter()], "samples": []}
        second = agent._start_capture()
        assert agent._capture["waiters"][1] is second

    def test_failure_resolves_every_waiter(self, make_agent):
        agent, _, _ = make_agent()
        agent._running = False  # skip the poll loop → finalize immediately
        waiters = [gr._CaptureWaiter(), gr._CaptureWaiter()]
        agent._capture = {"waiters": waiters, "samples": []}
        agent._capture_worker()
        assert all(w.event.is_set() and w.result is None for w in waiters)
        assert agent._capture is None


class TestSurveyPoints:
    def test_create_list_and_persist(self, make_agent, tmp_path):
        agent, _, _ = make_agent()
        a = agent.create_point("  Alpha ")
        b = agent.create_point("Beta")
        assert a["name"] == "Alpha" and b["id"] == a["id"] + 1
        assert a["lat"] is None and a["surveyed_at"] is None
        assert a["created_at"].endswith("Z") and a["updated_at"] == a["created_at"]
        reloaded, _, _ = make_agent()
        assert [p["name"] for p in reloaded.list_points()] == ["Alpha", "Beta"]
        on_disk = json.loads((tmp_path / "state.json").read_text())
        assert on_disk["next_point_id"] == b["id"] + 1

    @pytest.mark.parametrize("name", [None, "", "   ", 42, "x" * 101])
    def test_invalid_name(self, make_agent, name):
        agent, _, _ = make_agent()
        err = _api_error(agent.create_point, name)
        assert (err.status, err.reason) == (400, "invalid_name")

    def test_duplicate_name(self, make_agent):
        agent, _, _ = make_agent()
        agent.create_point("Alpha")
        err = _api_error(agent.create_point, "Alpha ")
        assert (err.status, err.reason) == (409, "duplicate_name")

    def test_ids_are_not_reused_after_delete(self, make_agent):
        agent, _, _ = make_agent()
        a = agent.create_point("A")
        agent.delete_point(a["id"])
        assert agent.create_point("B")["id"] == a["id"] + 1

    def test_delete_unknown(self, make_agent):
        agent, _, _ = make_agent()
        err = _api_error(agent.delete_point, 99)
        assert (err.status, err.reason) == (404, "point_not_found")

    def test_delete_active_base_point_refused(self, make_agent):
        agent, _, _ = make_agent()
        point = _surveyed_point(agent)
        agent.set_config({"mode": "base", "active_base_point_id": point["id"]})
        err = _api_error(agent.delete_point, point["id"])
        assert (err.status, err.reason) == (409, "active_base_point")
        agent.set_config({"mode": "capture"})
        agent.delete_point(point["id"])
        assert agent.list_points() == []

    def test_delete_cancels_its_survey(self, make_agent):
        agent, _, _ = make_agent()
        point = agent.create_point("A")
        agent._mode = "base-survey"
        agent._survey = {"point_id": point["id"], "samples": [], "started_at": 0, "duration_s": 60}
        agent.delete_point(point["id"])
        assert agent._survey is None and agent._mode == "capture"

    def test_failed_write_keeps_memory_state(self, make_agent, monkeypatch):
        agent, _, _ = make_agent()

        def _fail(*_a, **_kw):
            raise OSError("disk full")

        monkeypatch.setattr(gr, "save_state", _fail)
        err = _api_error(agent.create_point, "A")
        assert (err.status, err.reason) == (500, "storage_error")
        assert agent.list_points() == []


class TestSurveyStart:
    @pytest.mark.parametrize("duration", [9, 1801, "120", 12.5, True])
    def test_invalid_duration(self, make_agent, duration):
        agent, _, _ = make_agent()
        point = agent.create_point("A")
        err = _api_error(agent.start_survey, point["id"], duration)
        assert (err.status, err.reason) == (400, "invalid_duration")

    def test_default_duration(self, make_agent):
        agent, _, _ = make_agent()
        point = agent.create_point("A")
        res = agent.start_survey(point["id"])
        assert res["duration_s"] == gr.SURVEY_DEFAULT_DURATION_S
        assert agent._mode == "base-survey"
        agent.cancel_survey(point["id"])
        assert agent._mode == "capture" and agent._survey is None

    def test_unknown_point(self, make_agent):
        agent, _, _ = make_agent()
        err = _api_error(agent.start_survey, 5, 60)
        assert (err.status, err.reason) == (404, "point_not_found")

    def test_requires_ngii_login(self, make_agent):
        agent, _, _ = make_agent(ntrip_username="")
        point = agent.create_point("A")
        err = _api_error(agent.start_survey, point["id"], 60)
        assert (err.status, err.reason) == (409, "ntrip_not_configured")

    def test_refused_in_base_mode(self, make_agent):
        agent, _, _ = make_agent()
        base = _surveyed_point(agent)
        other = agent.create_point("B")
        agent.set_config({"mode": "base", "active_base_point_id": base["id"]})
        err = _api_error(agent.start_survey, other["id"], 60)
        assert (err.status, err.reason) == (409, "base_mode")

    def test_refused_while_surveying(self, make_agent):
        agent, _, _ = make_agent()
        a = agent.create_point("A")
        b = agent.create_point("B")
        agent.start_survey(a["id"], 60)
        err = _api_error(agent.start_survey, b["id"], 60)
        assert (err.status, err.reason) == (409, "survey_in_progress")
        assert err.body()["point_id"] == a["id"]
        agent.cancel_survey(a["id"])

    def test_cancel_unknown_point(self, make_agent):
        agent, _, _ = make_agent()
        err = _api_error(agent.cancel_survey, 3)
        assert err.status == 404


class TestSurveyWorkerReporting:
    """_survey_worker must announce an explicit result on completion — success
    stored on the point, or an ok:false failure when the quality gate fails."""

    @staticmethod
    def _start(agent, point_id, samples):
        agent._mode = "base-survey"
        agent._survey = {"point_id": point_id, "samples": samples, "started_at": 0, "duration_s": 0}

    def test_reports_failure_on_zero_samples(self, make_agent):
        agent, events, _ = make_agent()
        point = agent.create_point("A")
        self._start(agent, point["id"], [])
        agent._survey_worker(point["id"], 0)  # duration 0 → finalize immediately
        assert events.named("gps:survey_result") == [{
            "point_id": point["id"], "name": "A", "ok": False,
            "error": "insufficient_samples", "samples": 0,
        }]
        assert agent._mode == "capture"
        assert agent.list_points()[0]["lat"] is None

    def test_reports_failure_on_unstable(self, make_agent):
        agent, events, _ = make_agent()
        point = agent.create_point("A")
        samples = [(37.0, 127.0, 30.0, 0.01) for _ in range(80)]
        samples += [(37.0 + i * 1e-5, 127.0, 30.0, 0.01) for i in range(20)]
        self._start(agent, point["id"], samples)
        agent._survey_worker(point["id"], 0)
        result = events.named("gps:survey_result")[0]
        assert result["ok"] is False and result["error"] == "unstable"

    def test_success_is_persisted(self, make_agent):
        agent, events, _ = make_agent()
        point = agent.create_point("A")
        self._start(agent, point["id"], tight_samples(alt=65.0))
        agent._survey_worker(point["id"], 0)
        assert events.named("gps:survey_result") == [
            {"point_id": point["id"], "name": "A", "ok": True, "samples": 80}]
        stored = make_agent()[0].list_points()[0]
        assert abs(stored["lat"] - 37.1) < 1e-6 and abs(stored["lng"] - 127.1) < 1e-6
        assert stored["alt"] == 65.0 and stored["h_acc_m"] == 0.01 and stored["samples"] == 80
        assert stored["surveyed_at"] == stored["updated_at"]

    def test_superseded_survey_is_not_clobbered_or_reported(self, make_agent):
        # A finalizing worker whose survey was replaced by a NEWER one must not
        # clear it, reset the mode, or report a stale result.
        agent, events, _ = make_agent()
        newer = {"point_id": 200, "samples": [], "started_at": 0, "duration_s": 60}
        agent._mode = "base-survey"
        agent._survey = newer
        agent._survey_worker(100, 0)
        assert events.named("gps:survey_result") == []
        assert agent._survey is newer
        assert agent._mode == "base-survey"


class TestConfig:
    def test_default(self, make_agent):
        agent, _, _ = make_agent()
        assert agent.get_config() == {
            "mode": "capture", "active_base_point_id": None, "ntrip_username": "user",
            "caster": {"host": "100.64.0.7", "port": 2101, "mountpoint": "FSKBASE"},
        }

    def test_ntrip_username_persists_and_restarts_ngii(self, make_agent, tmp_path):
        agent, _, _ = make_agent(ntrip_username="")
        assert agent.get_config()["ntrip_username"] == ""

        class _Client:
            stopped = False

            def stop(self):
                self.stopped = True

        client = _Client()
        agent._ntrip = client
        agent._ntrip_last_attempt = 123.0
        cfg = agent.set_ntrip_username("me@example.com")
        assert cfg["ntrip_username"] == "me@example.com"
        assert client.stopped and agent._ntrip is None and agent._ntrip_last_attempt == 0.0
        assert json.loads((tmp_path / "state.json").read_text())["ntrip_username"] == "me@example.com"
        rebooted, _, _ = make_agent(ntrip_username="")
        assert rebooted._ntrip_username == "me@example.com"

    @pytest.mark.parametrize("username", [None, 5, "a b", "user:pass", "user\n", "x" * 129, "로그인"])
    def test_ntrip_username_invalid(self, make_agent, username):
        agent, _, _ = make_agent()
        err = _api_error(agent.set_ntrip_username, username)
        assert (err.status, err.reason) == (400, "invalid_username")
        assert agent._ntrip_username == "user"

    @pytest.mark.parametrize("body,status,reason", [
        ({}, 400, "invalid_mode"),
        ({"mode": "rover"}, 400, "invalid_mode"),
        ({"mode": "base"}, 400, "invalid_point_id"),
        ({"mode": "base", "active_base_point_id": "1"}, 400, "invalid_point_id"),
        ({"mode": "base", "active_base_point_id": 77}, 404, "point_not_found"),
    ])
    def test_invalid(self, make_agent, body, status, reason):
        agent, _, _ = make_agent()
        err = _api_error(agent.set_config, body)
        assert (err.status, err.reason) == (status, reason)

    def test_base_requires_surveyed_point(self, make_agent):
        agent, _, caster = make_agent()
        point = agent.create_point("A")
        err = _api_error(agent.set_config, {"mode": "base", "active_base_point_id": point["id"]})
        assert (err.status, err.reason) == (409, "point_not_surveyed")
        assert agent._mode == "capture" and caster.active is False

    def test_switch_to_base_and_back(self, make_agent):
        agent, _, caster = make_agent()
        point = _surveyed_point(agent)
        cfg = agent.set_config({"mode": "base", "active_base_point_id": point["id"]})
        assert cfg["mode"] == "base" and cfg["active_base_point_id"] == point["id"]
        assert agent._pending_reconfig[0] == "base"
        assert caster.active is True and caster.position == (point["lat"], point["lng"])
        status = agent.status()
        assert status["mode"] == "base"
        assert status["base"]["state"] == "active" and status["base"]["point_id"] == point["id"]
        cfg = agent.set_config({"mode": "capture"})
        assert cfg["mode"] == "capture" and cfg["active_base_point_id"] is None
        assert agent._pending_reconfig == ("capture", None)
        assert caster.active is False

    def test_same_base_is_a_no_op(self, make_agent):
        agent, _, _ = make_agent()
        point = _surveyed_point(agent)
        agent.set_config({"mode": "base", "active_base_point_id": point["id"]})
        agent._pending_reconfig = None  # consumed by the serial thread
        agent.set_config({"mode": "base", "active_base_point_id": point["id"]})
        assert agent._pending_reconfig is None

    def test_base_reapplied_on_boot(self, make_agent):
        agent, _, _ = make_agent()
        point = _surveyed_point(agent)
        agent.set_config({"mode": "base", "active_base_point_id": point["id"]})
        rebooted, _, caster = make_agent()
        assert rebooted._mode == "base-output"
        assert rebooted._pending_reconfig == ("base", rebooted._base_params)
        assert rebooted._base_params["lat"] == point["lat"]
        assert caster.active is True
        assert rebooted.get_config()["mode"] == "base"

    def test_persisted_base_without_coordinates_falls_back(self, make_agent, tmp_path):
        state = gr.default_state()
        state.update(mode="base", active_base_point_id=1, next_point_id=2, points=[
            {"id": 1, "name": "A", "lat": None, "lng": None}])
        (tmp_path / "state.json").write_text(json.dumps(state))
        agent, _, caster = make_agent()
        assert agent._mode == "capture" and caster.active is False
        assert agent.get_config()["mode"] == "capture"
        assert json.loads((tmp_path / "state.json").read_text())["mode"] == "capture"


class TestStateFile:
    def test_missing_file_gives_defaults(self, tmp_path):
        assert gr.load_state(str(tmp_path / "state.json")) == gr.default_state()

    def test_roundtrip_leaves_no_temp_files(self, tmp_path):
        path = str(tmp_path / "state.json")
        state = gr.default_state()
        state["points"].append({"id": 1, "name": "A"})
        state["next_point_id"] = 2
        gr.save_state(path, state)
        assert gr.load_state(path) == state
        assert os.listdir(tmp_path) == ["state.json"]

    @pytest.mark.parametrize("content", [
        "{not json",
        json.dumps([1, 2]),
        json.dumps({"mode": "capture", "active_base_point_id": None,
                    "next_point_id": 1, "points": [{"id": 1, "name": "dup-id-past-next"}]}),
        json.dumps({"mode": "capture", "active_base_point_id": None,
                    "next_point_id": 1, "points": [], "ntrip_username": "a b"}),
    ])
    def test_unusable_file_is_moved_aside(self, tmp_path, content):
        path = tmp_path / "state.json"
        path.write_text(content)
        assert gr.load_state(str(path)) == gr.default_state()
        assert not path.exists()
        assert len(list(tmp_path.glob("state.json.corrupt-*"))) == 1


class TestLoadConfig:
    def test_defaults(self):
        cfg = gr.load_config({"DEVICE_ID": "unit-1"})
        assert cfg["api_port"] == 10200 and cfg["caster_port"] == 2101
        assert cfg["caster_mountpoint"] == "FSKBASE"
        assert cfg["allowed_origins"] == frozenset()
        assert cfg["device_id"] == "unit-1" and cfg["device_name"] == "unit-1"
        assert cfg["state_dir"] == "/var/lib/fsk-coursekeeper-gps"
        assert cfg["meas_rate_ms"] == 100 and cfg["status_interval"] == 1.0

    def test_allowed_origins_list(self):
        cfg = gr.load_config({"ALLOWED_ORIGINS": "https://a.example, https://b.example/,"})
        assert cfg["allowed_origins"] == frozenset({"https://a.example", "https://b.example"})

    @pytest.mark.parametrize("env", [
        {"API_PORT": "0"},
        {"CASTER_PORT": "abc"},
        {"CASTER_MOUNTPOINT": "BAD MOUNT"},
        {"POSITION_REPORT_INTERVAL": "10"},
    ])
    def test_invalid(self, env):
        with pytest.raises(ValueError):
            gr.load_config(env)


class TestTailscaleAddress:
    @staticmethod
    def _runner(results):
        calls = []

        def run(cmd, **kwargs):
            calls.append(cmd)
            result = results.pop(0)
            if isinstance(result, BaseException):
                raise result
            return result
        return run, calls

    def test_not_installed_is_none(self):
        run, _ = self._runner([FileNotFoundError("tailscale")])
        assert gr.TailscaleAddress(runner=run).get() is None

    def test_not_up_is_none(self):
        run, _ = self._runner([subprocess.CompletedProcess(["tailscale"], 1, "", "not running")])
        assert gr.TailscaleAddress(runner=run).get() is None

    def test_timeout_is_none(self):
        run, _ = self._runner([subprocess.TimeoutExpired("tailscale", 5)])
        assert gr.TailscaleAddress(runner=run).get() is None

    def test_address_is_cached(self):
        run, calls = self._runner([subprocess.CompletedProcess(["tailscale"], 0, "100.101.102.103\n", "")])
        addr = gr.TailscaleAddress(runner=run, ttl_s=60)
        assert addr.get() == "100.101.102.103"
        assert addr.get() == "100.101.102.103"
        assert calls == [["tailscale", "ip", "-4"]]

    def test_missing_address_is_retried(self):
        run, calls = self._runner([
            FileNotFoundError("tailscale"),
            subprocess.CompletedProcess(["tailscale"], 0, "100.64.0.9\n", ""),
        ])
        addr = gr.TailscaleAddress(runner=run, retry_s=0)
        assert addr.get() is None
        assert addr.get() == "100.64.0.9"
        assert len(calls) == 2
