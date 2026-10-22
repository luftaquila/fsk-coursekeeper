// Audit actors. Operator requests arrive through `tailscale serve`, which adds
// Tailscale-User-Login / Tailscale-User-Name for requests from user devices
// (not from tagged devices). They label logs and missions only; tailnet access
// is the sole authorization and these headers are never trusted for it.

export const SYSTEM_ACTOR = Object.freeze({ label: "system", login: null, name: null });
export const ROVER_ACTOR = Object.freeze({ label: "rover", login: null, name: null });
export const TAILNET_ACTOR = Object.freeze({ label: "tailnet", login: null, name: null });

const MAX_HEADER_LENGTH = 256;
const ENCODED_WORD = /=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=/g;

function decodeEncodedWord(charset, encoding, text) {
  let bytes;
  if (encoding.toUpperCase() === "B") {
    bytes = Buffer.from(text, "base64");
  } else {
    const out = [];
    for (let i = 0; i < text.length; i += 1) {
      const hex = text.slice(i + 1, i + 3);
      if (text[i] === "_") out.push(0x20);
      else if (text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
      } else out.push(text.charCodeAt(i) & 0xff);
    }
    bytes = Buffer.from(out);
  }
  try {
    // RFC 2231 allows a language suffix: utf-8*en.
    return new TextDecoder(charset.split("*")[0]).decode(bytes);
  } catch {
    return null;
  }
}

// Tailscale encodes non-ASCII values as RFC 2047 encoded words
// (=?utf-8?q?Ferris_B=C3=BCller?=).
export function decodeHeaderWords(value) {
  if (!value.includes("=?")) return value;
  // Whitespace between adjacent encoded words is not part of the text.
  const joined = value.replace(/\?=\s+=\?/g, "?==?");
  return joined.replace(ENCODED_WORD, (word, charset, encoding, text) =>
    decodeEncodedWord(charset, encoding, text) ?? word);
}

function headerValue(req, name) {
  const raw = req.get(name);
  if (typeof raw !== "string") return null;
  // Drop control characters so a header cannot forge log structure.
  const value = decodeHeaderWords(raw.trim()).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return value ? value.slice(0, MAX_HEADER_LENGTH) : null;
}

export function tailnetActor(req) {
  const login = headerValue(req, "Tailscale-User-Login");
  const name = headerValue(req, "Tailscale-User-Name");
  if (!login && !name) return TAILNET_ACTOR;
  const label = login && name ? `${name} <${login}>` : (login || name);
  return Object.freeze({ label, login, name });
}
