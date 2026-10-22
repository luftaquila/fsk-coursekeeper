const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE";
const PREFLIGHT_MAX_AGE_S = 600;

// Normalizes configured origins to the exact form browsers send in Origin
// (scheme://host[:port], no path or trailing slash).
export function normalizeOrigins(origins) {
  if (!Array.isArray(origins)) throw new Error("allowedOrigins must be an array.");
  return origins.map((value) => {
    let url;
    try {
      url = new URL(String(value).trim());
    } catch {
      throw new Error(`Invalid allowed origin: ${value}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`Invalid allowed origin: ${value}`);
    }
    return url.origin;
  });
}

// Exact-match origin allowlist for the operator API. Pages from other origins
// (FSK service, the GitHub Pages console) call it from the browser, so every
// JSON request is preflighted. Requests without Origin (curl, the rover) pass.
// A disallowed Origin is refused outright: the browser would block reading the
// response anyway, and refusing also stops simple cross-site POSTs from
// driving the rover.
export function createCors(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    res.vary("Origin");
    const preflight = req.method === "OPTIONS" && req.headers["access-control-request-method"] !== undefined;
    if (!allowed.has(origin)) return res.status(403).send("Origin not allowed.");
    res.setHeader("Access-Control-Allow-Origin", origin);
    if (!preflight) return next();
    res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", String(PREFLIGHT_MAX_AGE_S));
    // Chrome private network access: a public page reaching the tailnet
    // address asks for explicit consent in the preflight.
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    return res.status(204).end();
  };
}
