"""Serves the real GPS unit API (rover/gps/gps_api.py) over a simulated receiver.

Prints "ready <port>" once listening. The receiver holds an RTK fixed position
near the console's default map view; a survey finishes after a few seconds.
"""

import argparse
import pathlib
import sys
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "rover" / "gps"))

from gps_api import ApiError, ApiServer, EventHub  # noqa: E402

POSITION = (35.29195, 126.57440, 12.1)
SURVEY_S = 3


def now_ms():
    return int(time.time() * 1000)


class FakeAgent:
    def __init__(self, events):
        self._events = events
        self._lock = threading.Lock()
        self._mode = "capture"
        self._active_base_point_id = None
        self._ntrip_username = ""
        self._points = []
        self._next_id = 1
        self._survey = None
        self._captures = 0

    def status(self):
        with self._lock:
            base_state, point_id, survey = "idle", None, None
            if self._mode == "base":
                base_state, point_id = "active", self._active_base_point_id
            elif self._survey is not None:
                base_state, point_id = "surveying", self._survey["point_id"]
                survey = {"started_at": self._survey["started_at"],
                          "duration_s": SURVEY_S, "samples": 1}
            lat, lng, alt = POSITION
            return {
                "device": {"id": "gps-e2e", "name": "gps-e2e", "kind": "gps", "version": "e2e"},
                "receiver_connected": True,
                "mode": "base" if self._mode == "base" else "capture",
                "fix_status": "rtk_fixed",
                "last_position": {"lat": lat, "lng": lng, "alt": alt, "at": now_ms()},
                "gps": {"h_acc": 0.014, "v_acc": 0.02, "altitude": alt, "speed": 0.0,
                        "num_sv": 21, "pdop": 1.1, "tdop": 0.9},
                "ntrip_connected": True,
                "ntrip": {"host": "rts1.ngii.go.kr", "port": 2101, "mountpoint": "VRS-RTCM32",
                          "fail_count": 0, "last_error": None,
                          "last_correction_at": time.time(), "bytes_received": 1024},
                "base": {"state": base_state, "point_id": point_id, "survey": survey,
                         "rtcm_bytes": 0, "clients": 0, "host": "100.64.0.5",
                         "mountpoint": "FSK", "port": 2101},
            }

    def capture(self):
        with self._lock:
            if self._mode == "base":
                raise ApiError(409, "base_mode", "The unit is a base station; switch to capture mode first.")
            self._captures += 1
            offset = self._captures * 0.00002
        lat, lng, alt = POSITION
        return {"lat": lat + offset, "lng": lng, "alt": alt}

    def list_points(self):
        with self._lock:
            return [dict(p) for p in self._points]

    def create_point(self, name, actor="unknown"):
        if not isinstance(name, str) or not name.strip():
            raise ApiError(400, "invalid_name", "Survey point name is required.")
        with self._lock:
            if any(p["name"] == name.strip() for p in self._points):
                raise ApiError(409, "duplicate_name", "A survey point with this name already exists.")
            point = {"id": self._next_id, "name": name.strip(), "lat": None, "lng": None,
                     "alt": None, "h_acc_m": None, "samples": None, "surveyed_at": None}
            self._next_id += 1
            self._points.append(point)
        return dict(point)

    def delete_point(self, point_id, actor="unknown"):
        with self._lock:
            if not any(p["id"] == point_id for p in self._points):
                raise ApiError(404, "point_not_found", "Survey point not found.")
            if self._mode == "base" and self._active_base_point_id == point_id:
                raise ApiError(409, "active_base_point",
                               "The point is the active base station; switch to capture mode first.")
            self._points = [p for p in self._points if p["id"] != point_id]
        self.publish_status()

    def start_survey(self, point_id, duration_s=None, actor="unknown"):
        with self._lock:
            if not any(p["id"] == point_id for p in self._points):
                raise ApiError(404, "point_not_found", "Survey point not found.")
            if self._survey is not None:
                raise ApiError(409, "survey_in_progress", "A survey is already running.")
            started_at = now_ms()
            self._survey = {"point_id": point_id, "started_at": started_at}
        threading.Timer(SURVEY_S, self._finish_survey, args=(point_id,)).start()
        self.publish_status()
        return {"point_id": point_id, "duration_s": SURVEY_S, "started_at": started_at}

    def _finish_survey(self, point_id):
        with self._lock:
            if self._survey is None or self._survey["point_id"] != point_id:
                return
            self._survey = None
            point = next((p for p in self._points if p["id"] == point_id), None)
            if point is None:
                return
            lat, lng, alt = POSITION
            point.update({"lat": lat + 0.0003, "lng": lng - 0.0003, "alt": alt,
                          "h_acc_m": 0.011, "samples": 60,
                          "surveyed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            name = point["name"]
        self._events.publish("gps:survey_result",
                             {"point_id": point_id, "name": name, "ok": True, "samples": 60})
        self.publish_status()

    def cancel_survey(self, point_id, actor="unknown"):
        with self._lock:
            if self._survey is not None and self._survey["point_id"] == point_id:
                self._survey = None
        self.publish_status()

    def get_config(self):
        with self._lock:
            return {"mode": self._mode, "active_base_point_id": self._active_base_point_id,
                    "ntrip_username": self._ntrip_username,
                    "caster": {"host": "100.64.0.5", "port": 2101, "mountpoint": "FSK"}}

    def set_config(self, body, actor="unknown"):
        mode = body.get("mode")
        if mode not in ("capture", "base"):
            raise ApiError(400, "invalid_mode", "mode must be 'capture' or 'base'.")
        with self._lock:
            if mode == "base":
                point_id = body.get("active_base_point_id")
                point = next((p for p in self._points if p["id"] == point_id), None)
                if point is None or point["lat"] is None:
                    raise ApiError(409, "point_not_surveyed", "Survey the point first.")
                self._mode, self._active_base_point_id = "base", point_id
            else:
                self._mode, self._active_base_point_id = "capture", None
        self.publish_status()
        return self.get_config()

    def set_ntrip_username(self, username, actor="unknown"):
        if not isinstance(username, str) or len(username) > 128:
            raise ApiError(400, "invalid_username", "username must be up to 128 characters.")
        with self._lock:
            self._ntrip_username = username
        return self.get_config()

    def publish_status(self):
        self._events.publish("gps:status", self.status())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", required=True)
    args = parser.parse_args()
    events = EventHub()
    agent = FakeAgent(events)
    server = ApiServer(agent, events, port=0, allowed_origins={args.origin})
    server.start()
    print(f"ready {server.port}", flush=True)
    try:
        while True:
            time.sleep(1)
            agent.publish_status()
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()


if __name__ == "__main__":
    main()
