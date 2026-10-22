import os
import sys

import pytest

# Repo layout: this agent at rover/gps/, the reused pilot package at
# the sibling rover/pilot/. Put both roots on sys.path so the tests
# can `import gps_register` and `import pilot.lib.*` in any order. (At
# runtime on the Pi, gps_register.py's own shim handles the deploy layout.)
_GPS = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
_PILOT = os.path.abspath(os.path.join(_GPS, os.pardir, "pilot"))
for _p in (_GPS, _PILOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)


class RecordingEvents:
    """EventHub stand-in that records published events."""

    def __init__(self):
        self.published = []

    def publish(self, event, data):
        self.published.append((event, data))

    def named(self, event):
        return [data for name, data in self.published if name == event]


class FakeCaster:
    """NtripCaster stand-in: records activation and published frames."""

    def __init__(self, port=2101, mountpoint="FSKBASE"):
        self.port = port
        self.mountpoint = mountpoint
        self.client_count = 0
        self.active = False
        self.position = (None, None)
        self.frames = []

    def set_active(self, active, lat=None, lng=None):
        self.active = active
        self.position = (lat, lng) if active else (None, None)

    def publish(self, frame):
        self.frames.append(frame)


class FixedAddress:
    def __init__(self, value):
        self.value = value

    def get(self):
        return self.value


@pytest.fixture
def make_agent(tmp_path):
    """Build a GpsRegisterAgent without hardware (no serial is opened until
    run()). Returns (agent, events, caster)."""
    import gps_register as gr

    def _make(ntrip_username="user", tailscale_ip="100.64.0.7", **kw):
        events = RecordingEvents()
        caster = FakeCaster()
        agent = gr.GpsRegisterAgent(
            ntrip_username=ntrip_username, state_dir=str(tmp_path),
            device_id="fsk-coursekeeper-gps", caster=caster, events=events,
            tailscale=FixedAddress(tailscale_ip), **kw)
        return agent, events, caster

    return _make


def tight_samples(n=80, lat=37.1, lng=127.1, alt=60.0):
    return [(lat + i * 1e-9, lng + i * 1e-9, alt, 0.01) for i in range(n)]
