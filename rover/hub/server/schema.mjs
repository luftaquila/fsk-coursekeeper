import { setupRowCapRetention } from "./db.mjs";

export const DEFAULT_TELEMETRY_MAX_ROWS = 500000;
export const DEFAULT_LOG_MAX_ROWS = 50000;

const ACTIVE_STATES_SQL = "('ready','starting','running','pausing','paused','interrupted','resuming')";

// Creates the hub tables. Course data lives with the browser's course host:
// a mission keeps the course id and name it was created for and the cone
// geometry it was given, with no reference to any course table.
export function initializeHubSchema(db, {
  telemetryMaxRows = DEFAULT_TELEMETRY_MAX_ROWS,
  logMaxRows = DEFAULT_LOG_MAX_ROWS,
} = {}) {
  db.transaction(() => {
    // status is the coarse projection of lifecycle_state written with every
    // lifecycle change: ready/starting/pausing/paused/resuming → paused,
    // cancelled → stopped.
    db.exec(`CREATE TABLE IF NOT EXISTS mission (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER,
      course_name TEXT,
      preset_id INTEGER,
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      ended_at INTEGER,
      updated_at INTEGER NOT NULL,
      lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN
        ('ready','starting','running','pausing','paused','interrupted','resuming','completed','cancelled')),
      status TEXT NOT NULL CHECK(status IN ('running','paused','interrupted','completed','stopped')),
      hold_reason TEXT,
      finish_behavior TEXT NOT NULL CHECK(finish_behavior IN ('stop','return_to_start')),
      plan_hash TEXT NOT NULL,
      start_lat REAL,
      start_lng REAL,
      start_alt REAL,
      last_rover_boot_id TEXT,
      active_command_id TEXT,
      active_hold_id TEXT,
      empty_plan_mode TEXT CHECK(empty_plan_mode IN ('return_only','uncertainty_resolved')),
      protocol_version INTEGER NOT NULL,
      actor TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_created ON mission(created_at)`);
    // At most one mission may be open at a time.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_one_active
      ON mission((1)) WHERE lifecycle_state IN ${ACTIVE_STATES_SQL}`);

    db.exec(`CREATE TABLE IF NOT EXISTS mission_waypoint (
      id TEXT PRIMARY KEY,
      mission_id INTEGER NOT NULL,
      position INTEGER,
      cone_id INTEGER,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      alt REAL,
      side TEXT NOT NULL CHECK(side IN ('left','right','center')),
      state TEXT NOT NULL CHECK(state IN ('pending','active','completed','skipped')) DEFAULT 'pending',
      outcome TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      skipped_at INTEGER,
      skip_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE,
      UNIQUE (mission_id, position)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_waypoint_state
      ON mission_waypoint(mission_id, state, position)`);

    db.exec(`CREATE TABLE IF NOT EXISTS mission_command (
      id TEXT PRIMARY KEY,
      mission_id INTEGER NOT NULL,
      command_seq INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('start','pause','resume','end')),
      plan_hash TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','superseded')) DEFAULT 'pending',
      requested_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      actor TEXT,
      rover_boot_id TEXT,
      reject_reason TEXT,
      payload_json TEXT NOT NULL,
      FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE,
      UNIQUE (mission_id, command_seq)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_command_pending
      ON mission_command(state, requested_at)`);

    db.exec(`CREATE TABLE IF NOT EXISTS mission_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      t INTEGER NOT NULL,
      waypoint_id TEXT,
      command_id TEXT,
      rover_boot_id TEXT,
      actor TEXT,
      before_json TEXT,
      after_json TEXT,
      detail_json TEXT,
      FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_event_mission
      ON mission_event(mission_id, t, id)`);

    db.exec(`CREATE TABLE IF NOT EXISTS rover_boot_session (
      boot_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL UNIQUE,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_report_seq INTEGER NOT NULL DEFAULT -1
        CHECK(last_report_seq BETWEEN -1 AND 9007199254740991)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rover_boot_session_generation
      ON rover_boot_session(generation DESC)`);

    // ntrip_connected/corr_age_ms/ntrip_fail_count tell a network drop from a
    // silent caster; h_acc_m/altitude_m/v_acc_m record the fix quality.
    db.exec(`CREATE TABLE IF NOT EXISTS mission_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER NOT NULL,
      t INTEGER NOT NULL,
      lat REAL,
      lng REAL,
      fix_status TEXT,
      nav_state TEXT,
      ntrip_connected INTEGER,
      corr_age_ms INTEGER,
      ntrip_fail_count INTEGER,
      h_acc_m REAL,
      altitude_m REAL,
      v_acc_m REAL,
      FOREIGN KEY (mission_id) REFERENCES mission(id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_telemetry ON mission_telemetry(mission_id, t)`);

    db.exec(`CREATE TABLE IF NOT EXISTS hub_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      level TEXT NOT NULL CHECK(level IN ('info','warn')),
      action TEXT NOT NULL,
      actor TEXT,
      actor_login TEXT,
      target TEXT,
      detail TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_action ON logs(action)`);

    setupRowCapRetention(db, "mission_telemetry", telemetryMaxRows);
    setupRowCapRetention(db, "logs", logMaxRows);
  })();
}
