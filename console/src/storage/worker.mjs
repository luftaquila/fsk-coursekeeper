// Course storage for the standalone console: the shared course service on SQLite
// WASM, persisted in the origin-private file system. The main thread talks to it
// with { id, type, ... } messages; change events are posted as { type: "event" }.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createCourseService, initializeCourseSchema } from "fsk-coursekeeper/service";
import { createCourseRouter } from "fsk-coursekeeper/service/router.mjs";
import { wrapOo1 } from "./better-sqlite3-shim.mjs";

const DB_FILE = "/coursekeeper.sqlite3";
let sqlite3 = null;
let pool = null;
let oo1 = null;
let handle = null;

function openDatabase() {
  oo1 = pool ? new pool.OpfsSAHPoolDb(DB_FILE) : new sqlite3.oo1.DB(":memory:", "c");
  const db = wrapOo1(sqlite3, oo1);
  initializeCourseSchema(db);
  handle = createCourseRouter(createCourseService(db), { actor: "local" });
}

async function start() {
  // Silence the library's console output; failures surface through results.
  sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: "fsk-coursekeeper", directory: ".fsk-coursekeeper" });
  } catch {
    // No OPFS (e.g. a private window): keep working in memory and say so.
    pool = null;
  }
  openDatabase();
  postMessage({ type: "ready", persistent: pool != null });
}

function respond(id, message, transfer = []) {
  postMessage({ id, ...message }, transfer);
}

function handleRequest({ id, method, url, body }) {
  let result;
  try {
    result = handle(method, url, body);
  } catch (error) {
    console.error("[course storage]", error);
    respond(id, { status: 500, text: "Server error." });
    return;
  }
  const { events, ...response } = result;
  respond(id, response);
  for (const [name, payload] of events) postMessage({ type: "event", name, payload });
}

async function handleImport({ id, bytes }) {
  if (!pool) return respond(id, { error: "Saving is unavailable in this browser." });
  try {
    oo1.close();
    await pool.importDb(DB_FILE, new Uint8Array(bytes));
    openDatabase();
    respond(id, { ok: true });
  } catch (error) {
    // Reopen whatever is stored so the console keeps working.
    try { openDatabase(); } catch { /* reported below */ }
    respond(id, { error: error?.message || String(error) });
  }
}

addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "request") return handleRequest(message);
  if (message.type === "export") {
    if (!pool) return respond(message.id, { error: "Saving is unavailable in this browser." });
    const bytes = pool.exportFile(DB_FILE);
    return respond(message.id, { bytes: bytes.buffer }, [bytes.buffer]);
  }
  if (message.type === "import") return void handleImport(message);
});

start().catch((error) => postMessage({ type: "failed", message: error?.message || String(error) }));
