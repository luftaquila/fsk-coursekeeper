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
    ? stored.devices.filter((device) => device && DEVICE_KINDS.includes(device.kind) && typeof device.url === "string")
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

// Device APIs are reached over HTTPS on the tailnet; plain HTTP is only
// accepted for a device on this machine during development.
export function deviceUrlProblem(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "Enter a full URL, e.g. https://fsk-coursekeeper-rover.your-tailnet.ts.net";
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) return "Use an https:// URL.";
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return "Enter the device address without a path.";
  return null;
}
