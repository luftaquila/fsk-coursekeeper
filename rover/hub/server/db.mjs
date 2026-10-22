import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Opens the hub database, creating its directory first. WAL keeps the GPS-rate
// telemetry writes from blocking operator reads.
export function openDatabase(dbPath) {
  if (typeof dbPath !== "string" || !dbPath) throw new Error("dbPath is required.");
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function assertIdentifier(name) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
}

// Keeps only the newest maxRows rows of a table. An AFTER INSERT trigger trims
// the oldest rows on every insert, and rows already over the cap are trimmed
// once here. keyColumn must be a monotonically increasing integer key.
export function setupRowCapRetention(db, table, maxRows, keyColumn = "id") {
  assertIdentifier(table);
  assertIdentifier(keyColumn);
  if (!Number.isInteger(maxRows) || maxRows <= 0) throw new Error(`Invalid row cap for ${table}: ${maxRows}`);
  const trigger = `trg_${table}_retention`;
  const condition = `${keyColumn} <= COALESCE((SELECT MAX(${keyColumn}) FROM ${table}), 0) - ${maxRows}`;
  db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  db.exec(`CREATE TRIGGER ${trigger} AFTER INSERT ON ${table}
    BEGIN
      DELETE FROM ${table} WHERE ${condition};
    END`);
  db.exec(`DELETE FROM ${table} WHERE ${condition}`);
}

// Runs a write and maps failures to an HTTP status and a user-facing message.
// internalError carries the raw cause for the audit log only.
export function createDbRun() {
  return function dbRun(fn) {
    try {
      return { success: true, result: fn() };
    } catch (error) {
      const internalError = error?.message || String(error);
      if (error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { success: false, status: 409, error: "The item already exists.", internalError };
      }
      if (error?.code === "SQLITE_CONSTRAINT_CHECK" || error?.code === "SQLITE_CONSTRAINT_NOTNULL") {
        return { success: false, status: 400, error: "The value violates a database constraint.", internalError };
      }
      if (Number.isInteger(error?.status) && error?.message) {
        return { success: false, status: error.status, error: error.message, internalError };
      }
      return { success: false, status: 500, error: "Database error.", internalError };
    }
  };
}
