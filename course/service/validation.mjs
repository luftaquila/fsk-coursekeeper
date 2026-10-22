// Input validators shared by every course host. Each returns
// { valid: true, value } with the normalized value to store, or
// { valid: false, error } with a user-facing message.

export function validateCourseName(name) {
  if (typeof name !== "string" || name.trim() === "") {
    return { valid: false, error: "Course name is empty." };
  }
  const value = name.trim();
  if (value.length > 100) return { valid: false, error: "Course name is too long (max 100 characters)." };
  return { valid: true, value };
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

// Altitude (MSL, m) is optional: missing becomes null; present values must be a
// finite number within a range a ground rover can reach.
export function validateAltitude(alt) {
  if (alt === undefined || alt === null) return { valid: true, value: null };
  if (typeof alt !== "number" || !Number.isFinite(alt) || alt < -1000 || alt > 10000) {
    return { valid: false, error: "Invalid altitude (-1000 to 10000 m)." };
  }
  return { valid: true, value: alt };
}

export function validateSide(side) {
  if (side !== "left" && side !== "right" && side !== "center") {
    return { valid: false, error: "Invalid cone side (left, right, or center)." };
  }
  return { valid: true, value: side };
}

// Memo width/height in meters. Values far beyond any course scale come from a
// misoperation or a client bug.
export function validateMemoDimension(v, label) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100000) {
    return { valid: false, error: `Invalid memo ${label} (greater than 0, at most 100000 m).` };
  }
  return { valid: true, value: v };
}

// Memo rotation in degrees, normalized to [0, 360). Missing means 0.
export function validateMemoRotation(v) {
  if (v === undefined || v === null) return { valid: true, value: 0 };
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { valid: false, error: "Invalid memo rotation." };
  }
  return { valid: true, value: ((v % 360) + 360) % 360 };
}

export function validateMemoContent(content) {
  if (content === undefined || content === null) return { valid: true, value: "" };
  if (typeof content !== "string") return { valid: false, error: "Invalid memo content." };
  if (content.length > 5000) return { valid: false, error: "Memo content is too long (max 5000 characters)." };
  return { valid: true, value: content };
}

export function validateRouteMarkerLabel(label) {
  if (label === undefined || label === null) return { valid: true, value: "" };
  if (typeof label !== "string") return { valid: false, error: "Invalid route marker name." };
  const value = label.trim();
  if (value.length > 50) return { valid: false, error: "Route marker name is too long (max 50 characters)." };
  return { valid: true, value };
}
