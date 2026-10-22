// Structured audit log in the hub database. The actor comes from req.actor
// (set per app) unless an explicit actor is given for background work. The
// console is used only when the database write itself fails.
export function createLogger(db) {
  const insert = db.prepare(`INSERT INTO logs (level, action, actor, actor_login, target, detail)
    VALUES (?, ?, ?, ?, ?, ?)`);

  function write(level, req, action, detail, target, actorOverride) {
    const actor = actorOverride || req?.actor || null;
    let detailText = null;
    if (detail != null) {
      try {
        detailText = typeof detail === "string" ? detail : JSON.stringify(detail);
      } catch {
        detailText = String(detail);
      }
    }
    try {
      insert.run(level, action, actor?.label ?? null, actor?.login ?? null, target ?? null, detailText);
    } catch (error) {
      console.error(`[hub] log write failed (${level} ${action}): ${error?.message || error}`, detailText ?? "");
    }
  }

  return {
    log: (req, action, detail, target, actorOverride) => write("info", req, action, detail, target, actorOverride),
    warn: (req, action, detail, target, actorOverride) => write("warn", req, action, detail, target, actorOverride),
  };
}
