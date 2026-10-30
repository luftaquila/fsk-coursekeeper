import { DEVICE_KINDS } from "fsk-coursekeeper/console/devices.mjs";

// Per-browser settings. Storage can be unavailable (private windows, blocked
// site data); the console then runs with defaults for this visit.
const KEY = "fsk-coursekeeper.settings";

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    return {};
  }
}

export function loadSettings() {
  const stored = read();
  const devices = Array.isArray(stored.devices)
    ? stored.devices.filter((device) => device && DEVICE_KINDS.includes(device.kind) && isDeviceHost(device.host))
    : [];
  return { devices, vworldKey: typeof stored.vworldKey === "string" ? stored.vworldKey : "" };
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

// A tailnet host name, without scheme or path.
export function isDeviceHost(s) {
  return typeof s === "string" && /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:\d{1,5})?$/.test(s);
}

export function deviceHostOf(input) {
  return String(input ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// Device APIs are reached at https://<host> on the tailnet; a device on this
// machine is reached over plain HTTP during development.
export function deviceUrl(host) {
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}
