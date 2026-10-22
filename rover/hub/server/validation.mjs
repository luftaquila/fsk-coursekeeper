// Input validators. Each returns { valid: true, value } with the normalized
// value to store, or { valid: false, error } with a user-facing message.

const R_EARTH_M = 6371e3;
const toRad = (deg) => (deg * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(h));
}

export function validateCoordinate(lat, lng) {
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { valid: false, error: "Invalid latitude (-90 to 90)." };
  }
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { valid: false, error: "Invalid longitude (-180 to 180)." };
  }
  return { valid: true };
}

// Altitude (MSL, m) is optional: missing becomes null.
export function validateAltitude(alt) {
  if (alt === undefined || alt === null) return { valid: true, value: null };
  if (typeof alt !== "number" || !Number.isFinite(alt) || alt < -1000 || alt > 10000) {
    return { valid: false, error: "Invalid altitude (-1000 to 10000 m)." };
  }
  return { valid: true, value: alt };
}

export const CONE_SIDES = new Set(["left", "right", "center"]);

export const DEFAULT_NTRIP_SOURCE = Object.freeze({ source: "ngii" });

// The rover's RTK correction source: the NGII network (mountpoint chosen by the
// rover) or a specific caster, typically the handheld GPS unit's base station.
export function validateNtripSource(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, error: "Invalid NTRIP source." };
  }
  if (body.source === "ngii") return { valid: true, value: { source: "ngii" } };
  if (body.source !== "caster") return { valid: false, error: "source must be \"ngii\" or \"caster\"." };
  const { host, port, mountpoint } = body;
  if (typeof host !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(host)) {
    return { valid: false, error: "host must be 1-253 characters of letters, digits, dots, or hyphens." };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { valid: false, error: "port must be an integer from 1 to 65535." };
  }
  if (typeof mountpoint !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(mountpoint)) {
    return { valid: false, error: "mountpoint must be 1-64 characters of letters, digits, underscores, or hyphens." };
  }
  return { valid: true, value: { source: "caster", host, port, mountpoint } };
}
