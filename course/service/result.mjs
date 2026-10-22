// Service results. Hosts translate them into responses: `events` are the change
// notifications to fan out, `detail`/`subject` the audit context, and `audited`
// marks results a host records as successful operations.
export function ok(value, { status = 200 } = {}) {
  return { ok: true, status, value, audited: false, events: [], warnings: [] };
}

export function changed(value, { status = 200, detail = null, subject = null, events = [], warnings = [] } = {}) {
  return { ok: true, status, value, audited: true, detail, subject, events, warnings };
}

export function fail(status, error, { detail = {}, subject = null, body = null } = {}) {
  return { ok: false, status, error, detail, subject, body };
}

export function parseId(raw) {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

export function isUniqueViolation(error) {
  return /UNIQUE constraint failed/.test(error?.message || "");
}

export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
