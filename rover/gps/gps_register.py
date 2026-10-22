#!/usr/bin/env python3
"""FSK Coursekeeper GPS unit — handheld RTK receiver for cone capture and
base-station mode.

Runs on a Raspberry Pi Zero 2 W next to a u-blox ZED-F9P. Single process, no
ROS:

  * reads the receiver over USB (UBX NAV-PVT / NAV-HPPOSLLH / NAV-DOP),
  * streams NGII NTRIP RTCM3 corrections back to the receiver for RTK,
  * serves its own HTTP API (gps_api.py) on localhost — `tailscale serve`
    publishes it on the tailnet — for status, cone capture, survey points and
    mode switching,
  * in base-station mode runs an NTRIP caster (ntrip_caster.py) that fans the
    receiver's RTCM3 out to every connected rover.

It reuses the pilot's pure, ROS-free modules (UBX parser, NTRIP client, geo
utils, RTCM framer) rather than duplicating them — see the sys.path shim below.

Capture and base station are mutually exclusive (`_mode`). Survey points, the
selected mode, and the operator's NGII login (set from the console; unset ⇒ no
RTK) persist in STATE_DIR/state.json and are re-applied on boot.

Config (environment, see systemd/fsk-coursekeeper-gps.service):
    GPS_SERIAL_PORT           default /dev/ttyGPS
    GPS_BAUD                  default 115200
    GPS_MEAS_RATE_MS          receiver fix period, default 100 (10 Hz)
    POSITION_REPORT_INTERVAL  seconds between change-driven status events (1.0)
    API_PORT                  HTTP API port on 127.0.0.1, default 10200
    CASTER_PORT               NTRIP caster port on 127.0.0.1, default 2101
    CASTER_MOUNTPOINT         caster mountpoint, default FSKBASE
    ALLOWED_ORIGINS           comma list of browser origins allowed by CORS
    DEVICE_ID                 default: hostname
    DEVICE_NAME               default: DEVICE_ID
    STATE_DIR                 default /var/lib/fsk-coursekeeper-gps
"""

import copy
import ipaddress
import json
import logging
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone

import serial

# Import the pilot's pure (ROS-free) helpers without duplicating them.
# Two layouts are supported: the in-repo tree (this file at
# rover/gps/, pilot package one dir over at ../pilot/pilot) and the
# on-unit deploy (/opt/fsk-coursekeeper-gps/ with the lib files copied to
# /opt/fsk-coursekeeper-gps/pilot/lib by the release packaging). In both, the
# package *root* that makes `import pilot.lib.*` resolve is what we add to sys.path.
_HERE = os.path.dirname(os.path.abspath(__file__))
for _cand in (_HERE, os.path.join(_HERE, os.pardir, "pilot")):
    if os.path.isdir(os.path.join(_cand, "pilot", "lib")):
        sys.path.insert(0, os.path.abspath(_cand))
        break

from pilot.lib.ubx_parser import (  # noqa: E402
    UBXParser, NavPVT, NavHPPOSLLH, NavDOP,
    CarrierSolution, FixType, build_cfg_valset,
)
from pilot.lib.ntrip_client import (  # noqa: E402
    NTRIPClient, fetch_source_table, parse_source_table, select_nearest_mountpoint,
    valid_ntrip_username,
)
from pilot.lib.rtcm_utils import RTCM3Framer  # noqa: E402
from pilot.lib.geo_utils import haversine  # noqa: E402

from gps_api import ApiError, ApiServer, EventHub, parse_allowed_origins  # noqa: E402
from ntrip_caster import NtripCaster  # noqa: E402

log = logging.getLogger("gps-register")

# Release version (a tag, edge-<sha>, or dev); the release build writes it here.
__version__ = "dev"

# NGII (국토지리정보원) caster — protocol-level constants, mirror gps_node.py.
NTRIP_HOST = "www.gnssdata.or.kr"
NTRIP_PORT = 2101
NTRIP_PASSWORD = "gnss"
NTRIP_SETUP_COOLDOWN_S = 30.0

# Cone-capture sampling: a capture only resolves after the receiver holds a
# STABLE rtk_fixed position for a short window — never on a single sample or a
# non-RTK fix (that would place a cone metres off, or while drifting).
CAPTURE_WINDOW_S = 3.0        # MAX time to reach a stable fix before giving up
CAPTURE_MIN_SAMPLES = 10      # respond as soon as this many stable rtk_fixed samples (~1 s @10Hz)
CAPTURE_MAX_DEV_M = 0.03      # reject if any sample is >3 cm from the mean (still moving)
CAPTURE_TIMEOUT_S = 5.0       # HTTP budget for one capture request (504 past this)

SURVEY_DEFAULT_DURATION_S = 120
SURVEY_MIN_DURATION_S = 10
SURVEY_MAX_DURATION_S = 1800
SURVEY_POINT_NAME_MAX = 100

# Status events: on change at most every POSITION_REPORT_INTERVAL, and at least
# this often regardless.
STATUS_MAX_INTERVAL_S = 3.0
# The receiver counts as connected while bytes arrived within this window.
RECEIVER_STALE_S = 3.0

STATE_FILE_NAME = "state.json"

# How long a `tailscale ip -4` answer is reused; a missing address is retried sooner.
TAILSCALE_IP_TTL_S = 30.0
TAILSCALE_IP_RETRY_S = 5.0


def evaluate_capture(samples, min_samples=CAPTURE_MIN_SAMPLES, max_dev_m=CAPTURE_MAX_DEV_M):
    """Given [(lat, lng, alt, h_acc)] rtk_fixed samples, return the averaged
    (lat, lng, alt) only if there are enough of them AND they are stable (max
    horizontal deviation from the mean within max_dev_m). Otherwise None —
    the capture then fails visibly."""
    n = len(samples)
    if n < min_samples:
        return None
    lat = sum(s[0] for s in samples) / n
    lng = sum(s[1] for s in samples) / n
    max_dev = max(haversine(lat, lng, s[0], s[1]) for s in samples)
    if max_dev > max_dev_m:
        return None
    alts = [s[2] for s in samples if s[2] is not None]
    alt = sum(alts) / len(alts) if alts else None
    return (lat, lng, alt)

# UBX-CFG-VALSET key IDs (USB message-output toggles + measurement rate),
# mirror gps_node.py so this unit and the rover configure the F9P identically.
CFG_RATE_MEAS = 0x30210001
CFG_MSGOUT_UBX_NAV_PVT_USB = 0x20910009
CFG_MSGOUT_UBX_NAV_HPPOSLLH_USB = 0x20910036
CFG_MSGOUT_UBX_NAV_DOP_USB = 0x20910041
CFG_MSGOUT_NMEA_GGA_USB = 0x209100BD
CFG_MSGOUT_NMEA_RMC_USB = 0x209100AE
CFG_MSGOUT_NMEA_GSV_USB = 0x209100C4
CFG_MSGOUT_NMEA_GSA_USB = 0x209100C1
CFG_MSGOUT_NMEA_GLL_USB = 0x209100CA
CFG_MSGOUT_NMEA_VTG_USB = 0x209100B3

# UBX-CFG keys for base-station (TMODE FIXED) + RTCM3 output on USB. Key IDs +
# types verified against the u-blox F9 configuration database (pyubx2
# ubxtypes_configdb). TMODE lets a receiver at a known point emit RTCM3
# corrections; MSM7 (1077/1087/1097/1127) + 1005 (station ARP) + 1230 (GLONASS
# code-phase biases) is the standard high-precision base message set.
CFG_TMODE_MODE = 0x20030001            # E1: 0=disabled 1=survey-in 2=fixed
CFG_TMODE_POS_TYPE = 0x20030002        # E1: 0=ECEF 1=LLH
CFG_TMODE_LAT = 0x40030009             # I4, 1e-7 deg
CFG_TMODE_LON = 0x4003000A             # I4, 1e-7 deg
CFG_TMODE_HEIGHT = 0x4003000B          # I4, cm
CFG_TMODE_LAT_HP = 0x2003000C          # I1, 1e-9 deg
CFG_TMODE_LON_HP = 0x2003000D          # I1, 1e-9 deg
CFG_TMODE_HEIGHT_HP = 0x2003000E       # I1, 0.1 mm
CFG_TMODE_FIXED_POS_ACC = 0x4003000F   # U4, 0.1 mm
CFG_MSGOUT_RTCM_1005_USB = 0x209102C0
CFG_MSGOUT_RTCM_1077_USB = 0x209102CF
CFG_MSGOUT_RTCM_1087_USB = 0x209102D4
CFG_MSGOUT_RTCM_1097_USB = 0x2091031B
CFG_MSGOUT_RTCM_1127_USB = 0x209102D9
CFG_MSGOUT_RTCM_1230_USB = 0x20910306
_RTCM_MSGOUT_KEYS = (
    CFG_MSGOUT_RTCM_1005_USB, CFG_MSGOUT_RTCM_1077_USB, CFG_MSGOUT_RTCM_1087_USB,
    CFG_MSGOUT_RTCM_1097_USB, CFG_MSGOUT_RTCM_1127_USB, CFG_MSGOUT_RTCM_1230_USB,
)

# Base corrections go out at 1 Hz whatever the fix rate. CFG-MSGOUT rates count
# epochs (N = every Nth), so the divider is the number of epochs per second.
BASE_RTCM_PERIOD_MS = 1000


def rtcm_epoch_divider(meas_rate_ms):
    return max(1, min(255, round(BASE_RTCM_PERIOD_MS / meas_rate_ms)))


_SERIAL_OPEN_RETRIES = 6
_SERIAL_OPEN_BACKOFF_S = 2.0


def split_hp(scaled_fine):
    """Split an integer in *fine* units (coarse/100) into (coarse_main, hp) for
    the u-blox HP config pair. Works for lat/lon (coarse 1e-7 deg, fine 1e-9 deg)
    and height (coarse cm, fine 0.1 mm): value = main*coarse + hp*fine.

    Floor division makes hp always land in 0..99 — within u-blox's I1 HP range
    [-99, 99] — so the reconstruction main*coarse + hp*fine is EXACT in every
    hemisphere: the F9P sums the two fields linearly, with no same-sign
    requirement between main and hp. (In practice only exercised on +lat/+lon
    in Korea, but correct for negative coordinates too.)"""
    main = scaled_fine // 100
    hp = scaled_fine - main * 100
    return main, hp


def average_survey_samples(samples):
    """Mean of (lat, lng, alt, h_acc) survey samples. alt/h_acc are averaged over
    only the subset that reported them. Returns (lat, lng, alt|None, h_acc|None, n)
    or None when there are no samples."""
    n = len(samples)
    if n == 0:
        return None
    lat = sum(s[0] for s in samples) / n
    lon = sum(s[1] for s in samples) / n
    alts = [s[2] for s in samples if s[2] is not None]
    haccs = [s[3] for s in samples if s[3] is not None]
    alt = sum(alts) / len(alts) if alts else None
    h_acc = sum(haccs) / len(haccs) if haccs else None
    return lat, lon, alt, h_acc, n


# Base-station survey quality gate. A surveyed coordinate anchors EVERY RTK fix
# the rover later makes, so accept it only after enough rtk_fixed samples that
# also cluster tightly. Unlike the short cone capture (max per-sample deviation
# over ~1 s), a base survey runs for minutes: individual RTK noise averages out,
# so the gate is the horizontal RMS spread about the mean (catches a bumped
# tripod or heavy multipath) rather than a single-outlier max deviation.
SURVEY_MIN_SAMPLES = 60       # reject if fewer rtk_fixed samples than this (~6 s @10Hz)
SURVEY_MAX_STD_M = 0.10       # reject if horizontal RMS about the mean exceeds 10 cm


def evaluate_survey(samples, min_samples=SURVEY_MIN_SAMPLES, max_std_m=SURVEY_MAX_STD_M):
    """Average (lat, lng, alt, h_acc) rtk_fixed survey samples into a base
    coordinate, but only when there are enough of them AND they cluster tightly.
    Returns (lat, lng, alt|None, h_acc|None, n, std_m) on success, or a short
    error string on failure — the caller reports the reason so the operator
    knows whether to wait longer ("insufficient_samples") or re-site the
    receiver ("unstable")."""
    n = len(samples)
    if n < min_samples:
        return "insufficient_samples"
    lat, lon, alt, h_acc, _ = average_survey_samples(samples)
    std = (sum(haversine(lat, lon, s[0], s[1]) ** 2 for s in samples) / n) ** 0.5
    if std > max_std_m:
        return "unstable"
    return (lat, lon, alt, h_acc, n, std)


def fix_status_string(pvt):
    """NavPVT → human-readable fix status. RTK carrier solution wins over a
    plain 3D fix; DR variants map to no_fix (the F9P has no IMU here).
    Mirrors gps_node._fix_status_string so the UI sees identical strings."""
    if pvt.carrier_solution == CarrierSolution.FIXED:
        return "rtk_fixed"
    if pvt.carrier_solution == CarrierSolution.FLOAT:
        return "rtk_float"
    return {
        FixType.NO_FIX: "no_fix",
        FixType.DEAD_RECKONING: "no_fix",
        FixType.FIX_2D: "2d_fix",
        FixType.FIX_3D: "3d_fix",
        FixType.GNSS_DR: "no_fix",
        FixType.TIME_ONLY: "time_only",
    }.get(pvt.fix_type, "no_fix")


# Fix statuses whose position is real. Below a 2D fix the receiver reports
# (0, 0); reporting that would drag the operator map to Null Island, where the
# satellite basemap has no tiles and the whole view renders blank grey.
_POSITION_FIX_STATUSES = frozenset({"2d_fix", "3d_fix", "rtk_float", "rtk_fixed"})


# ---- persisted state ---------------------------------------------------------

def default_state():
    return {"mode": "capture", "active_base_point_id": None, "next_point_id": 1, "points": [],
            "ntrip_username": ""}


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def validate_state(state):
    """True if `state` has the shape save_state writes."""
    if not isinstance(state, dict) or state.get("mode") not in ("capture", "base"):
        return False
    points = state.get("points")
    if not isinstance(points, list) or not _is_int(state.get("next_point_id")):
        return False
    active = state.get("active_base_point_id")
    if active is not None and not _is_int(active):
        return False
    if not valid_ntrip_username(state.get("ntrip_username", "")):
        return False
    ids = set()
    for p in points:
        if not isinstance(p, dict) or not _is_int(p.get("id")) or not isinstance(p.get("name"), str):
            return False
        ids.add(p["id"])
    return len(ids) == len(points) and all(i < state["next_point_id"] for i in ids)


def load_state(path):
    """Read the persisted state. Missing file → defaults. An unreadable or
    malformed file is moved aside (never silently overwritten) and defaults
    are used."""
    try:
        with open(path, encoding="utf-8") as f:
            state = json.load(f)
    except FileNotFoundError:
        return default_state()
    except (OSError, ValueError) as exc:
        state, error = None, str(exc)
    else:
        error = "unexpected structure"
    if state is not None and validate_state(state):
        return state
    aside = f"{path}.corrupt-{int(time.time())}"
    log.error("state file %s unusable (%s) — moved to %s, starting empty", path, error, aside)
    try:
        os.replace(path, aside)
    except OSError as exc:
        log.error("could not move %s aside: %s", path, exc)
    return default_state()


def save_state(path, state):
    """Atomically replace `path` with `state` (temp file + fsync + rename)."""
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".state-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    dir_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _now_ms():
    return int(time.time() * 1000)


class TailscaleAddress:
    """This unit's Tailscale IPv4 address from `tailscale ip -4`, cached.

    Rovers reach the caster by IP: the pilot container pins public DNS
    resolvers and cannot resolve MagicDNS names. `get()` returns None while
    Tailscale is absent or not up. While a refresh runs, other callers get the
    previous value instead of waiting."""

    def __init__(self, command=("tailscale", "ip", "-4"), runner=subprocess.run,
                 ttl_s=TAILSCALE_IP_TTL_S, retry_s=TAILSCALE_IP_RETRY_S):
        self._command = list(command)
        self._runner = runner
        self._ttl_s = ttl_s
        self._retry_s = retry_s
        self._lock = threading.Lock()
        self._value = None
        self._expires_at = 0.0
        self._refreshing = False

    def get(self):
        with self._lock:
            if self._refreshing or time.monotonic() < self._expires_at:
                return self._value
            self._refreshing = True
        value = self._query()
        with self._lock:
            self._value = value
            self._expires_at = time.monotonic() + (self._ttl_s if value else self._retry_s)
            self._refreshing = False
        return value

    def _query(self):
        try:
            proc = self._runner(self._command, capture_output=True, text=True,
                                timeout=5, check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            log.debug("tailscale ip unavailable: %s", exc)
            return None
        if proc.returncode != 0:
            return None
        for line in (proc.stdout or "").splitlines():
            try:
                return str(ipaddress.IPv4Address(line.strip()))
            except ValueError:
                continue
        return None


class _CaptureWaiter:
    def __init__(self):
        self.event = threading.Event()
        self.result = None   # (lat, lng, alt) on success
        self.samples = 0

    def resolve(self, result, samples):
        self.result = result
        self.samples = samples
        self.event.set()


class GpsRegisterAgent:
    """Owns the receiver, the NGII NTRIP client, survey points, and the mode.

    Public methods (status, capture, *_point, *_survey, get/set_config) are the
    API service layer; they raise gps_api.ApiError for client-visible failures.
    Lock order: _api_lock → _lock. Nothing holding _lock takes _api_lock.
    """

    def __init__(self, state_dir, serial_port="/dev/ttyGPS",
                 baud=115200, meas_rate_ms=100, status_interval=1.0,
                 device_id="gps", device_name=None, caster=None, events=None,
                 tailscale=None):
        self._port = serial_port
        self._baud = baud
        self._meas_rate_ms = meas_rate_ms
        self._status_interval = status_interval
        self._device = {"id": device_id, "name": device_name or device_id, "kind": "gps",
                        "version": __version__}
        self._caster = caster
        self._events = events
        self._tailscale = tailscale

        self._parser = UBXParser()
        self._serial = None
        self._ntrip = None
        self._ntrip_last_attempt = 0.0

        self._lock = threading.Lock()
        self._api_lock = threading.RLock()
        # Last position at >= 2D fix in capture mode: {'lat','lng','alt','at'}
        # (alt = MSL height, m; at = unix ms).
        self._last_position = None
        self._last_pvt = None
        self._last_hpposllh = None
        self._last_dop = None
        self._last_rx_at = None          # monotonic time of the last serial bytes
        self._fix_status = None
        self._gps_metrics = None

        self._running = True
        self._status_wakeup = threading.Event()
        # _mode: "capture" (cone capture) | "base-survey" (averaging NGII
        # rtk_fixed position for a survey point) | "base-output" (TMODE FIXED,
        # emitting RTCM to the caster). _pending_reconfig hands serial
        # (re)configuration to the serial thread, which owns the port.
        self._mode = "capture"
        self._pending_reconfig = None   # None | ("base", params) | ("capture", None)
        self._base_params = None        # {"lat","lng","alt","acc"} while acting as a base
        self._base_point_id = None
        # None | {"point_id", "samples": [(lat,lng,alt,h_acc)], "started_at", "duration_s"}
        self._survey = None
        self._capture = None            # None | {"waiters": [...], "samples": [...]}
        self._rtcm_framer = None
        self._rtcm_bytes = 0

        self._state_path = os.path.join(state_dir, STATE_FILE_NAME)
        self._state = load_state(self._state_path)
        self._ntrip_username = self._state.get("ntrip_username", "")
        self._apply_persisted_mode()

    # ---- persisted state ----------------------------------------------

    def _commit(self, state):
        """Persist `state`, then make it current. On a write error the
        in-memory state is untouched and the request fails with 500."""
        try:
            save_state(self._state_path, state)
        except OSError as exc:
            log.error("state save failed: %s", exc)
            raise ApiError(500, "storage_error", "Could not save the unit state.")
        self._state = state

    def _find_point(self, point_id, state=None):
        for p in (state or self._state)["points"]:
            if p["id"] == point_id:
                return p
        return None

    def _apply_persisted_mode(self):
        """Boot: re-enter base mode if the persisted config says so."""
        state = self._state
        if state["mode"] != "base":
            return
        point = self._find_point(state["active_base_point_id"])
        if point is None or point.get("lat") is None or point.get("lng") is None:
            log.warning("persisted base point %r missing or unsurveyed — staying in capture mode",
                        state["active_base_point_id"])
            new_state = copy.deepcopy(state)
            new_state["mode"] = "capture"
            new_state["active_base_point_id"] = None
            try:
                save_state(self._state_path, new_state)
            except OSError as exc:
                log.error("state save failed: %s", exc)
            self._state = new_state
            return
        self._activate_base(point)

    # ---- receiver ------------------------------------------------------

    def _open_serial(self):
        last_exc = None
        for attempt in range(1, _SERIAL_OPEN_RETRIES + 1):
            try:
                self._serial = serial.Serial(self._port, self._baud, timeout=0.1)
                log.info("opened GPS serial %s @ %d", self._port, self._baud)
                return
            except serial.SerialException as exc:
                last_exc = exc
                log.warning("GPS serial open failed (%s, %d/%d): %s",
                            self._port, attempt, _SERIAL_OPEN_RETRIES, exc)
                if attempt < _SERIAL_OPEN_RETRIES:
                    time.sleep(_SERIAL_OPEN_BACKOFF_S)
        raise last_exc

    def _configure_receiver(self):
        """Configure the F9P for capture (roving) mode: UBX NAV output on, NMEA
        off, fix rate set, and — critically — TMODE + RTCM output DISABLED.

        This runs unconditionally on every serial open, so it must be
        authoritative: build_cfg_valset persists to RAM+BBR, so a base session
        leaves CFG-TMODE-MODE=FIXED in battery-backed RAM. Without clearing it
        here, a restart in capture mode (power loss / systemd restart) would
        leave the receiver in TMODE FIXED, silently reporting the stale base
        coordinate for every cone. Clearing it here makes capture always start
        clean; the base re-assert on open (see _serial_loop) re-enables TMODE
        right after when we really are a base."""
        cfg = build_cfg_valset([
            (CFG_RATE_MEAS, self._meas_rate_ms, "H"),
            (CFG_MSGOUT_UBX_NAV_PVT_USB, 1, "B"),
            (CFG_MSGOUT_UBX_NAV_HPPOSLLH_USB, 1, "B"),
            (CFG_MSGOUT_UBX_NAV_DOP_USB, 1, "B"),
            (CFG_MSGOUT_NMEA_GGA_USB, 0, "B"),
            (CFG_MSGOUT_NMEA_RMC_USB, 0, "B"),
            (CFG_MSGOUT_NMEA_GSV_USB, 0, "B"),
            (CFG_MSGOUT_NMEA_GSA_USB, 0, "B"),
            (CFG_MSGOUT_NMEA_GLL_USB, 0, "B"),
            (CFG_MSGOUT_NMEA_VTG_USB, 0, "B"),
            # Clear any persisted base-station config (TMODE FIXED + RTCM output).
            (CFG_TMODE_MODE, 0, "B"),
        ] + [(k, 0, "B") for k in _RTCM_MSGOUT_KEYS])
        self._serial.write(cfg)
        log.info("ZED-F9P configured for UBX output @ %d ms (capture mode)", self._meas_rate_ms)

    def _configure_base(self, lat, lon, alt, acc):
        """Put the F9P into TMODE FIXED (LLH) at the surveyed point and enable
        RTCM3 (MSM7 + 1005 + 1230) on USB at 1 Hz. From then the receiver
        generates its own corrections from its known position — no NGII needed."""
        lat_main, lat_hp = split_hp(int(round(lat * 1e9)))     # 1e-9 deg units
        lon_main, lon_hp = split_hp(int(round(lon * 1e9)))
        h = alt if alt is not None else 0.0
        h_main, h_hp = split_hp(int(round(h * 1e4)))           # 0.1 mm units
        acc_01mm = max(1, int(round((acc if acc else 0.1) * 1e4)))
        cfg = build_cfg_valset([
            (CFG_TMODE_MODE, 2, "B"),          # FIXED
            (CFG_TMODE_POS_TYPE, 1, "B"),      # LLH
            (CFG_TMODE_LAT, lat_main, "i"),
            (CFG_TMODE_LAT_HP, lat_hp, "b"),
            (CFG_TMODE_LON, lon_main, "i"),
            (CFG_TMODE_LON_HP, lon_hp, "b"),
            (CFG_TMODE_HEIGHT, h_main, "i"),
            (CFG_TMODE_HEIGHT_HP, h_hp, "b"),
            (CFG_TMODE_FIXED_POS_ACC, acc_01mm, "I"),
        ] + [(k, rtcm_epoch_divider(self._meas_rate_ms), "B") for k in _RTCM_MSGOUT_KEYS])
        self._serial.write(cfg)
        log.info("ZED-F9P TMODE FIXED @ (%.7f, %.7f, %.2fm) — RTCM3 out enabled", lat, lon, h)

    def _configure_base_stop(self):
        """Disable TMODE + RTCM3 output — returns the F9P to a moving-rover role."""
        cfg = build_cfg_valset(
            [(CFG_TMODE_MODE, 0, "B")] + [(k, 0, "B") for k in _RTCM_MSGOUT_KEYS]
        )
        self._serial.write(cfg)
        log.info("ZED-F9P TMODE disabled — RTCM3 out off")

    def _apply_base_output(self, payload):
        """Serial-thread: stop NGII and switch the F9P to base (RTCM) output."""
        if self._ntrip is not None:
            try:
                self._ntrip.stop()
            except Exception:
                pass
            self._ntrip = None
        self._ntrip_last_attempt = time.monotonic()  # block NGII auto-restart
        with self._lock:
            self._mode = "base-output"
            self._survey = None
            self._rtcm_framer = RTCM3Framer()
            self._rtcm_bytes = 0
        self._configure_base(payload["lat"], payload["lng"], payload.get("alt"), payload.get("acc"))

    def _apply_capture(self):
        """Serial-thread: leave base mode, restore NAV output, resume NGII."""
        self._configure_base_stop()
        self._configure_receiver()
        with self._lock:
            self._mode = "capture"
            self._survey = None
            self._rtcm_framer = None
        self._ntrip_last_attempt = 0.0  # allow NGII to re-init on next 3D fix

    def _teardown_serial(self):
        if self._ntrip is not None:
            try:
                self._ntrip.stop()
            except Exception:
                pass
            self._ntrip = None
            self._ntrip_last_attempt = 0.0
        try:
            if self._serial is not None:
                self._serial.close()
        except Exception:
            pass
        self._serial = None

    def _maybe_setup_ntrip(self, lat, lon, fix_type):
        """Start NTRIP once a 3D fix lets us pick the nearest base station.
        No-op without an operator NGII login (runs without RTK then). Also a
        no-op while acting as a base — a TMODE-FIXED base makes its own
        corrections and must not pull NGII (capture + base-survey still do)."""
        if self._mode == "base-output":
            return
        if self._ntrip is not None or not self._ntrip_username:
            return
        if fix_type < FixType.FIX_3D:
            return
        now = time.monotonic()
        if now - self._ntrip_last_attempt < NTRIP_SETUP_COOLDOWN_S:
            return
        self._ntrip_last_attempt = now
        threading.Thread(target=self._ntrip_setup_worker,
                         args=(lat, lon, self._serial), daemon=True).start()

    def _ntrip_setup_worker(self, lat, lon, serial_ref):
        # We may have switched to base-output while this worker was queued or
        # during the slow fetch below. Bail early so we never pull NGII in base
        # mode; re-checked under the lock too (mirrors gps_node._ntrip_setup_worker).
        if self._mode == "base-output":
            return
        try:
            table = fetch_source_table(NTRIP_HOST, NTRIP_PORT)
        except Exception as exc:
            log.warning("NTRIP source table fetch failed: %s — retry in %.0fs",
                        exc, NTRIP_SETUP_COOLDOWN_S)
            return
        entries = parse_source_table(table)
        mount = select_nearest_mountpoint(lat, lon, entries) if entries else None
        if not mount:
            log.warning("NTRIP: no RTCM 3.2 mount near (%.5f, %.5f) — retry in %.0fs",
                        lat, lon, NTRIP_SETUP_COOLDOWN_S)
            return
        with self._lock:
            if (self._ntrip is not None or self._serial is not serial_ref
                    or self._mode == "base-output" or not self._ntrip_username):
                return
            log.info('NTRIP: auto-selected "%s" for (%.5f, %.5f)', mount, lat, lon)
            client = NTRIPClient(
                host=NTRIP_HOST, port=NTRIP_PORT, mountpoint=mount,
                username=self._ntrip_username, password=NTRIP_PASSWORD,
                serial_port=serial_ref, lat=lat, lon=lon, logger=log,
            )
            self._ntrip = client
            # start() only spawns a daemon thread (non-blocking), so keep it under
            # the lock: releasing before start() lets a racing base activation
            # stop()+null our reference, after which we'd start an orphaned NGII
            # client feeding the F9P while it is a TMODE-FIXED base.
            client.start()

    def _on_nav_pvt(self, pvt):
        metrics = self._metrics_from(pvt)
        with self._lock:
            self._last_pvt = pvt
            self._fix_status = fix_status_string(pvt)
            self._gps_metrics = metrics
            # NAV-PVT position is the fallback until the first HPPOSLLH.
            if self._last_hpposllh is None:
                self._record_position_locked(pvt.lat, pvt.lon, pvt.h_msl)
        self._maybe_setup_ntrip(pvt.lat, pvt.lon, pvt.fix_type)
        # One read: set_ntrip_username may drop the client from the API thread.
        ntrip = self._ntrip
        if ntrip:
            ntrip.update_position(pvt.lat, pvt.lon)

    def _record_position_locked(self, lat, lng, alt):
        # Hold the last position until at least a 2D fix: a no-fix / time-only
        # solution reports (0, 0), which would jump the operator map to Null
        # Island. A TMODE-FIXED base reports its own ARP, never a live position.
        if self._fix_status in _POSITION_FIX_STATUSES and self._mode != "base-output":
            self._last_position = {"lat": lat, "lng": lng, "alt": alt, "at": _now_ms()}

    def _on_hpposllh(self, hp):
        with self._lock:
            self._last_hpposllh = hp
            self._record_position_locked(hp.lat, hp.lon, hp.h_msl)
            # During a base survey, average only RTK-fixed samples — this is the
            # whole point of surveying "while NTRIP is alive". Use ELLIPSOIDAL
            # height (hp.height), not MSL: this coordinate feeds CFG-TMODE-HEIGHT
            # with POS_TYPE=LLH, which u-blox defines as height above the WGS84
            # ellipsoid. Using h_msl would bias the base ARP by the geoid
            # separation (~24 m in Korea) and skew every rover absolute altitude.
            if self._survey is not None and self._fix_status == "rtk_fixed":
                self._survey["samples"].append((hp.lat, hp.lon, hp.height, hp.h_acc))
            # Cone-capture also averages only rtk_fixed samples, but stores MSL
            # height (h_msl) — cones carry MSL altitude, unlike a base's ellipsoidal
            # ARP. Never collect while acting as a base (base-output): TMODE FIXED
            # emits the stationary ARP as rtk_fixed, which would return the base
            # coordinate as a cone.
            if (self._capture is not None and self._fix_status == "rtk_fixed"
                    and self._mode == "capture"):
                self._capture["samples"].append((hp.lat, hp.lon, hp.h_msl, hp.h_acc))

    def _metrics_from(self, pvt):
        """Build the status `gps` block, preferring HPPOSLLH/DOP detail."""
        hp = self._last_hpposllh
        dop = self._last_dop
        h_acc = hp.h_acc if hp else pvt.h_acc
        v_acc = hp.v_acc if hp else pvt.v_acc
        altitude = hp.h_msl if hp else pvt.h_msl
        return {
            "h_acc": h_acc,
            "v_acc": v_acc,
            "altitude": altitude,
            "speed": pvt.ground_speed,
            "heading": pvt.heading if pvt.ground_speed >= 1.5 else None,
            "num_sv": pvt.num_sv,
            "pdop": dop.p_dop if dop else pvt.p_dop,
            "tdop": dop.t_dop if dop else None,
        }

    def _serial_loop(self):
        """Read + parse UBX; extract RTCM for the caster in base mode.
        Reopens on drop. All serial (re)configuration happens on this thread."""
        while self._running:
            if self._serial is None:
                try:
                    self._open_serial()
                    self._configure_receiver()
                    # Re-assert base output after a reopen (BBR usually survives a
                    # USB re-enumerate, but re-applying is cheap and authoritative).
                    # Read mode+params atomically under the lock and snapshot the
                    # dict, so a concurrent _deactivate_base can't leave us queuing
                    # ("base", None) → _apply_base_output(None) → crash.
                    with self._lock:
                        if self._mode == "base-output" and self._base_params:
                            self._pending_reconfig = ("base", dict(self._base_params))
                except (serial.SerialException, OSError) as exc:
                    log.warning("GPS serial (re)open failed: %s", exc)
                    time.sleep(_SERIAL_OPEN_BACKOFF_S)
                    continue
                self.notify_status()

            # Apply any pending base/capture reconfiguration here so all serial +
            # NTRIP lifecycle stays on the single serial-owning thread. Read+clear
            # under the lock so a concurrent _activate_base/_deactivate_base write
            # can't be lost between the read and the clear. Apply OUTSIDE the lock
            # (_apply_* re-acquire it; the Lock is non-reentrant).
            with self._lock:
                pending = self._pending_reconfig
                self._pending_reconfig = None
            if pending is not None:
                kind, payload = pending
                try:
                    if kind == "base":
                        self._apply_base_output(payload)
                    else:
                        self._apply_capture()
                except (serial.SerialException, OSError) as exc:
                    log.warning("reconfigure(%s) failed: %s", kind, exc)
                except Exception:
                    # Never let an unexpected reconfig error kill the serial thread
                    # (that would exit the whole process); log and keep running.
                    log.exception("reconfigure(%s) crashed", kind)
                self.notify_status()

            try:
                data = self._serial.read(self._serial.in_waiting or 1)
            except (serial.SerialException, OSError) as exc:
                log.error("serial read error: %s — closing for reopen", exc)
                self._teardown_serial()
                self.notify_status()
                continue
            if data:
                self._feed(data)

    def _feed(self, data):
        """Route received bytes: RTCM3 frames to the caster (base mode), UBX
        to the position handlers."""
        with self._lock:
            self._last_rx_at = time.monotonic()
            framer = self._rtcm_framer if self._mode == "base-output" else None
        if framer is not None:
            frames = framer.feed(data)
            if frames:
                with self._lock:
                    self._rtcm_bytes += sum(len(f) for f in frames)
                if self._caster is not None:
                    for f in frames:
                        self._caster.publish(f)
        for msg in self._parser.feed(data):
            if isinstance(msg, NavPVT):
                self._on_nav_pvt(msg)
            elif isinstance(msg, NavHPPOSLLH):
                self._on_hpposllh(msg)
            elif isinstance(msg, NavDOP):
                with self._lock:
                    self._last_dop = msg

    # ---- status ----------------------------------------------------------

    def notify_status(self):
        """Push a status event now instead of at the next interval."""
        self._status_wakeup.set()

    def _ntrip_detail_locked(self):
        if not self._ntrip:
            return None
        n = self._ntrip
        return {
            "host": n.host, "port": n.port, "mountpoint": n.mountpoint,
            "fail_count": n.fail_count, "last_error": n.last_error,
            "last_correction_at": n.last_correction_at,
            "bytes_received": n.bytes_received,
        }

    def _caster_host(self):
        return self._tailscale.get() if self._tailscale is not None else None

    def status(self):
        caster = self._caster
        clients = caster.client_count if caster is not None else 0
        caster_host = self._caster_host()
        with self._lock:
            if self._mode == "base-output":
                base_state, point_id = "active", self._base_point_id
            elif self._survey is not None:
                base_state, point_id = "surveying", self._survey["point_id"]
            else:
                base_state, point_id = "idle", None
            survey = None
            if self._survey is not None:
                survey = {
                    "started_at": self._survey["started_at"],
                    "duration_s": self._survey["duration_s"],
                    "samples": len(self._survey["samples"]),
                }
            receiver_connected = (
                self._serial is not None and self._last_rx_at is not None
                and time.monotonic() - self._last_rx_at < RECEIVER_STALE_S
            )
            return {
                "device": dict(self._device),
                "receiver_connected": receiver_connected,
                "mode": "base" if self._mode == "base-output" else "capture",
                "fix_status": self._fix_status,
                "last_position": dict(self._last_position) if self._last_position else None,
                "gps": dict(self._gps_metrics) if self._gps_metrics else None,
                "ntrip_connected": bool(self._ntrip.connected) if self._ntrip else False,
                "ntrip": self._ntrip_detail_locked(),
                "base": {
                    "state": base_state,
                    "point_id": point_id,
                    "survey": survey,
                    "rtcm_bytes": self._rtcm_bytes,
                    "clients": clients,
                    "host": caster_host,
                    "mountpoint": caster.mountpoint if caster is not None else None,
                    "port": caster.port if caster is not None else None,
                },
            }

    def _status_loop(self):
        last_sent = None
        last_sent_at = 0.0
        while self._running:
            forced = self._status_wakeup.wait(self._status_interval)
            self._status_wakeup.clear()
            if not self._running:
                return
            snapshot = self.status()
            now = time.monotonic()
            if forced or snapshot != last_sent or now - last_sent_at >= STATUS_MAX_INTERVAL_S:
                self._publish("gps:status", snapshot)
                last_sent, last_sent_at = snapshot, now

    def _publish(self, event, data):
        if self._events is not None:
            self._events.publish(event, data)

    # ---- cone capture --------------------------------------------------

    def capture(self, timeout=CAPTURE_TIMEOUT_S):
        """Average a stable rtk_fixed window into one cone coordinate."""
        with self._lock:
            mode = self._mode
        if mode == "base-output":
            raise ApiError(409, "base_mode", "The unit is a base station; switch to capture mode first.")
        if mode == "base-survey":
            raise ApiError(409, "survey_in_progress", "A survey is running; capture is unavailable.")
        waiter = self._start_capture()
        if not waiter.event.wait(timeout):
            raise ApiError(504, "capture_timeout", "Position capture timed out.")
        if waiter.result is None:
            raise ApiError(422, "capture_failed",
                           "No stable RTK fixed position.", samples=waiter.samples)
        lat, lng, alt = waiter.result
        return {"lat": lat, "lng": lng, "alt": alt}

    def _start_capture(self):
        """Begin (or join) a cone-capture sampling window."""
        waiter = _CaptureWaiter()
        with self._lock:
            if self._capture is not None:
                # A capture is already running — answer this request from it too.
                self._capture["waiters"].append(waiter)
                return waiter
            self._capture = {"waiters": [waiter], "samples": []}
        threading.Thread(target=self._capture_worker, daemon=True).start()
        return waiter

    def _capture_worker(self):
        """Resolve as soon as there is a STABLE rtk_fixed window
        (>= CAPTURE_MIN_SAMPLES within CAPTURE_MAX_DEV_M) — no need to wait the
        full window. If CAPTURE_WINDOW_S elapses without stabilizing, resolve
        as a failure (no bad cone)."""
        deadline = time.monotonic() + CAPTURE_WINDOW_S
        result = None
        while time.monotonic() < deadline and self._running:
            with self._lock:
                samples = list(self._capture["samples"]) if self._capture else []
            result = evaluate_capture(samples)
            if result is not None:
                break  # stable enough → respond now
            time.sleep(0.1)
        with self._lock:
            cap = self._capture
            self._capture = None
        if not cap:
            return
        n = len(cap["samples"])
        if result is None:
            result = evaluate_capture(cap["samples"])  # final check on the last samples
        if result is None:
            log.warning("cone capture failed: %d rtk_fixed samples (need stable %d)",
                        n, CAPTURE_MIN_SAMPLES)
        else:
            log.info("cone capture: %d samples -> (%.7f, %.7f)", n, result[0], result[1])
        for waiter in cap["waiters"]:
            waiter.resolve(result, n)

    # ---- survey points ---------------------------------------------------

    def list_points(self):
        with self._api_lock:
            return copy.deepcopy(self._state["points"])

    def create_point(self, name, actor="unknown"):
        if not isinstance(name, str) or not name.strip():
            raise ApiError(400, "invalid_name", "Survey point name is required.")
        name = name.strip()
        if len(name) > SURVEY_POINT_NAME_MAX:
            raise ApiError(400, "invalid_name",
                           f"Survey point name is longer than {SURVEY_POINT_NAME_MAX} characters.")
        with self._api_lock:
            if any(p["name"] == name for p in self._state["points"]):
                raise ApiError(409, "duplicate_name", "A survey point with this name already exists.")
            state = copy.deepcopy(self._state)
            now = _now_iso()
            point = {
                "id": state["next_point_id"], "name": name,
                "lat": None, "lng": None, "alt": None, "h_acc_m": None, "samples": None,
                "surveyed_at": None, "created_at": now, "updated_at": now,
            }
            state["next_point_id"] += 1
            state["points"].append(point)
            self._commit(state)
        log.info("survey point %d %r created by %s", point["id"], name, actor)
        return dict(point)

    def delete_point(self, point_id, actor="unknown"):
        with self._api_lock:
            point = self._find_point(point_id)
            if point is None:
                raise ApiError(404, "point_not_found", "Survey point not found.")
            if self._state["mode"] == "base" and self._state["active_base_point_id"] == point_id:
                raise ApiError(409, "active_base_point",
                               "The point is the active base station; switch to capture mode first.")
            state = copy.deepcopy(self._state)
            state["points"] = [p for p in state["points"] if p["id"] != point_id]
            self._commit(state)
            with self._lock:
                surveying = self._survey is not None and self._survey["point_id"] == point_id
            if surveying:
                self._cancel_survey()
        log.info("survey point %d %r deleted by %s", point_id, point["name"], actor)
        self.notify_status()

    def start_survey(self, point_id, duration_s=None, actor="unknown"):
        """Average NGII rtk_fixed HPPOSLLH for `duration_s` into the point."""
        if duration_s is None:
            duration = SURVEY_DEFAULT_DURATION_S
        elif _is_int(duration_s) or (isinstance(duration_s, float) and duration_s.is_integer()):
            duration = int(duration_s)
        else:
            raise ApiError(400, "invalid_duration", "duration_s must be an integer number of seconds.")
        if not SURVEY_MIN_DURATION_S <= duration <= SURVEY_MAX_DURATION_S:
            raise ApiError(400, "invalid_duration",
                           f"duration_s must be between {SURVEY_MIN_DURATION_S} and {SURVEY_MAX_DURATION_S}.")
        with self._api_lock:
            point = self._find_point(point_id)
            if point is None:
                raise ApiError(404, "point_not_found", "Survey point not found.")
            if not self._ntrip_username:
                raise ApiError(409, "ntrip_not_configured",
                               "Surveying needs NGII RTK corrections; set the NGII login first.")
            with self._lock:
                if self._mode == "base-output":
                    raise ApiError(409, "base_mode",
                                   "The unit is a base station; switch to capture mode first.")
                if self._survey is not None:
                    raise ApiError(409, "survey_in_progress", "A survey is already running.",
                                   point_id=self._survey["point_id"])
                started_at = _now_ms()
                self._mode = "base-survey"
                self._survey = {"point_id": point_id, "samples": [],
                                "started_at": started_at, "duration_s": duration}
        log.info("survey of point %d %r for %ds started by %s", point_id, point["name"], duration, actor)
        threading.Thread(target=self._survey_worker, args=(point_id, duration), daemon=True).start()
        self.notify_status()
        return {"point_id": point_id, "duration_s": duration, "started_at": started_at}

    def cancel_survey(self, point_id, actor="unknown"):
        with self._api_lock:
            if self._find_point(point_id) is None:
                raise ApiError(404, "point_not_found", "Survey point not found.")
            with self._lock:
                running = self._survey is not None and self._survey["point_id"] == point_id
            if running:
                self._cancel_survey()
                log.info("survey of point %d cancelled by %s", point_id, actor)
        self.notify_status()

    def _cancel_survey(self):
        with self._lock:
            self._survey = None
            if self._mode == "base-survey":
                self._mode = "capture"

    def _survey_worker(self, point_id, duration):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline and self._running:
            surv = self._survey
            if surv is None or surv.get("point_id") != point_id:
                log.info("survey %s cancelled/superseded", point_id)
                return
            time.sleep(0.5)
        with self._lock:
            surv = self._survey
            if surv is not None and surv.get("point_id") == point_id:
                self._survey = None
                if self._mode == "base-survey":
                    self._mode = "capture"
                samples = list(surv["samples"])
            else:
                # Superseded by a newer survey (or cancelled) while we were
                # finalizing — that owner controls _survey/_mode now, so don't
                # touch them and don't report a result for a survey we no longer own.
                samples = None
        if samples is None:
            log.info("survey %s superseded before finalize — no result", point_id)
            return
        self._finish_survey(point_id, samples)

    def _finish_survey(self, point_id, samples):
        """Persist a passing survey into its point and announce the result."""
        result = evaluate_survey(samples)
        with self._api_lock:
            point = self._find_point(point_id)
            name = point["name"] if point else None
            if point is None:
                event = {"point_id": point_id, "name": None, "ok": False,
                         "error": "point_not_found", "samples": len(samples)}
            elif isinstance(result, str):
                event = {"point_id": point_id, "name": name, "ok": False,
                         "error": result, "samples": len(samples)}
            else:
                lat, lon, alt, h_acc, n, std = result
                state = copy.deepcopy(self._state)
                target = self._find_point(point_id, state)
                now = _now_iso()
                target.update({"lat": lat, "lng": lon, "alt": alt, "h_acc_m": h_acc,
                               "samples": n, "surveyed_at": now, "updated_at": now})
                try:
                    self._commit(state)
                except ApiError:
                    event = {"point_id": point_id, "name": name, "ok": False,
                             "error": "storage_error", "samples": n}
                else:
                    event = {"point_id": point_id, "name": name, "ok": True, "samples": n}
                    log.info("survey %d done: %d samples, std %.3fm -> (%.7f, %.7f)",
                             point_id, n, std, lat, lon)
        if not event["ok"]:
            log.warning("survey %d failed: %s (%d samples)", point_id, event["error"], event["samples"])
        self._publish("gps:survey_result", event)
        self.notify_status()

    # ---- mode / config ---------------------------------------------------

    def get_config(self):
        with self._api_lock:
            mode = self._state["mode"]
            active_base_point_id = self._state["active_base_point_id"]
        caster = self._caster
        return {
            "mode": mode,
            "active_base_point_id": active_base_point_id,
            "ntrip_username": self._ntrip_username,
            "caster": {
                "host": self._caster_host(),
                "port": caster.port if caster is not None else None,
                "mountpoint": caster.mountpoint if caster is not None else None,
            },
        }

    def set_config(self, body, actor="unknown"):
        mode = body.get("mode")
        if mode not in ("capture", "base"):
            raise ApiError(400, "invalid_mode", "mode must be 'capture' or 'base'.")
        with self._api_lock:
            if mode == "capture":
                self._select_capture(actor)
            else:
                self._select_base(body.get("active_base_point_id"), actor)
        return self.get_config()

    def set_ntrip_username(self, username, actor="unknown"):
        """Store the NGII login ("" clears it). A running NGII client is
        stopped so the next 3D fix reconnects with the new login."""
        if not valid_ntrip_username(username):
            raise ApiError(400, "invalid_username",
                           "username must be up to 128 printable ASCII characters without spaces or colons.")
        with self._api_lock:
            if username == self._ntrip_username:
                return self.get_config()
            state = copy.deepcopy(self._state)
            state["ntrip_username"] = username
            self._commit(state)
            with self._lock:
                self._ntrip_username = username
                client = self._ntrip if self._mode != "base-output" else None
                if client is not None:
                    self._ntrip = None
                self._ntrip_last_attempt = 0.0
            if client is not None:
                try:
                    client.stop()
                except Exception:
                    pass
        log.info("NGII login %s by %s", "set" if username else "cleared", actor)
        self.notify_status()
        return self.get_config()

    def _select_capture(self, actor):
        if self._state["mode"] == "capture":
            return
        state = copy.deepcopy(self._state)
        state["mode"] = "capture"
        state["active_base_point_id"] = None
        self._commit(state)
        self._deactivate_base()
        log.info("capture mode selected by %s", actor)

    def _select_base(self, point_id, actor):
        if not _is_int(point_id):
            raise ApiError(400, "invalid_point_id", "Base mode needs active_base_point_id.")
        point = self._find_point(point_id)
        if point is None:
            raise ApiError(404, "point_not_found", "Survey point not found.")
        if point.get("lat") is None or point.get("lng") is None:
            raise ApiError(409, "point_not_surveyed", "The point has not been surveyed yet.")
        if self._state["mode"] == "base" and self._state["active_base_point_id"] == point_id:
            return
        state = copy.deepcopy(self._state)
        state["mode"] = "base"
        state["active_base_point_id"] = point_id
        self._commit(state)
        self._activate_base(point)
        log.info("base mode at point %d %r selected by %s", point_id, point["name"], actor)

    def _activate_base(self, point):
        """Latch base intent (so NGII stops auto-starting and captures stop
        sampling); the serial thread does the actual TMODE/RTCM reconfiguration
        via _pending_reconfig. _mode/_base_params/_pending_reconfig are set
        together under the lock so the serial reopen path can never read a
        half-updated ('base', None). A running survey is cancelled."""
        params = {
            "lat": point["lat"], "lng": point["lng"],
            "alt": point.get("alt"), "acc": point.get("h_acc_m"),
        }
        with self._lock:
            self._base_params = params
            self._base_point_id = point["id"]
            self._mode = "base-output"
            self._survey = None
            self._pending_reconfig = ("base", params)
        if self._caster is not None:
            self._caster.set_active(True, params["lat"], params["lng"])
        log.info("base activation requested at (%.7f, %.7f)", params["lat"], params["lng"])
        self.notify_status()

    def _deactivate_base(self):
        with self._lock:
            self._base_params = None
            self._base_point_id = None
            self._mode = "capture"
            self._pending_reconfig = ("capture", None)
        if self._caster is not None:
            self._caster.set_active(False)
        log.info("base deactivation requested")
        self.notify_status()

    # ---- lifecycle -----------------------------------------------------

    def run(self):
        threading.Thread(target=self._status_loop, daemon=True).start()
        try:
            self._serial_loop()
        finally:
            self.stop()

    def stop(self):
        self._running = False
        self._status_wakeup.set()
        if self._ntrip:
            try:
                self._ntrip.stop()
            except Exception:
                pass
        if self._serial:
            try:
                self._serial.close()
            except Exception:
                pass


_MOUNTPOINT_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def load_config(env):
    """Environment → validated settings dict. Raises ValueError on bad input."""
    def port(name, default):
        raw = env.get(name, "").strip() or str(default)
        try:
            value = int(raw)
        except ValueError:
            raise ValueError(f"{name} must be an integer (got {raw!r})")
        if not 1 <= value <= 65535:
            raise ValueError(f"{name} must be 1-65535 (got {value})")
        return value

    mountpoint = env.get("CASTER_MOUNTPOINT", "").strip() or "FSKBASE"
    if not _MOUNTPOINT_RE.match(mountpoint):
        raise ValueError(f"CASTER_MOUNTPOINT must match {_MOUNTPOINT_RE.pattern} (got {mountpoint!r})")
    try:
        interval = float(env.get("POSITION_REPORT_INTERVAL", "").strip() or "1.0")
        meas_rate_ms = int(env.get("GPS_MEAS_RATE_MS", "").strip() or "100")
        baud = int(env.get("GPS_BAUD", "").strip() or "115200")
    except ValueError as exc:
        raise ValueError(f"invalid numeric setting: {exc}")
    if not 0.1 <= interval <= STATUS_MAX_INTERVAL_S:
        raise ValueError(f"POSITION_REPORT_INTERVAL must be 0.1-{STATUS_MAX_INTERVAL_S} s (got {interval})")
    device_id = env.get("DEVICE_ID", "").strip() or socket.gethostname()
    return {
        "serial_port": env.get("GPS_SERIAL_PORT", "").strip() or "/dev/ttyGPS",
        "baud": baud,
        "meas_rate_ms": meas_rate_ms,
        "status_interval": interval,
        "api_port": port("API_PORT", 10200),
        "caster_port": port("CASTER_PORT", 2101),
        "caster_mountpoint": mountpoint,
        "allowed_origins": parse_allowed_origins(env.get("ALLOWED_ORIGINS", "")),
        "device_id": device_id,
        "device_name": env.get("DEVICE_NAME", "").strip() or device_id,
        "state_dir": env.get("STATE_DIR", "").strip() or "/var/lib/fsk-coursekeeper-gps",
    }


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        cfg = load_config(os.environ)
    except ValueError as exc:
        log.error("%s", exc)
        raise SystemExit(2)
    if not cfg["allowed_origins"]:
        log.warning("ALLOWED_ORIGINS unset — browsers on other origins are refused")
    os.makedirs(cfg["state_dir"], exist_ok=True)

    caster = NtripCaster(host="127.0.0.1", port=cfg["caster_port"],
                         mountpoint=cfg["caster_mountpoint"])
    events = EventHub()
    agent = GpsRegisterAgent(
        state_dir=cfg["state_dir"],
        serial_port=cfg["serial_port"],
        baud=cfg["baud"],
        meas_rate_ms=cfg["meas_rate_ms"],
        status_interval=cfg["status_interval"],
        device_id=cfg["device_id"],
        device_name=cfg["device_name"],
        caster=caster,
        events=events,
        tailscale=TailscaleAddress(),
    )
    api = ApiServer(agent, events, host="127.0.0.1", port=cfg["api_port"],
                    allowed_origins=cfg["allowed_origins"])
    caster.start()
    api.start()
    log.info("GPS unit %s starting (api=:%d, caster=:%d/%s)",
             cfg["device_id"], cfg["api_port"], cfg["caster_port"], cfg["caster_mountpoint"])
    try:
        agent.run()
    except KeyboardInterrupt:
        agent.stop()
    finally:
        api.stop()
        caster.stop()


if __name__ == "__main__":
    main()
