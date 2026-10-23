// Per-browser view preferences of the operator console. Storage can be
// unavailable (private windows, blocked site data); reads then fall back.
const PREFIX = "mapview.";

export function loadPref(key, fallback, parse = (x) => x) {
  try {
    const raw = localStorage.getItem(`${PREFIX}${key}`);
    if (raw === null) return fallback;
    return parse(raw);
  } catch { return fallback; }
}

export function savePref(key, value) {
  try { localStorage.setItem(`${PREFIX}${key}`, String(value)); } catch {}
}
