// Canonical course-data schema shared by every host. A host that owns older
// databases migrates them to these exact definitions before calling
// initializeCourseSchema; a fresh database is created from them directly.
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export const COURSE_TABLES = {
  course: `(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW},
  reverse INTEGER NOT NULL DEFAULT 0,
  start_cone_id INTEGER
)`,
  cone: `(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  alt REAL,
  side TEXT NOT NULL CHECK(side IN ('left', 'right', 'center')),
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW},
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
)`,
  memo: `(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  rotation REAL NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW},
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
)`,
  // Markers are physical map anchors; route_step may visit the same marker
  // repeatedly to express multi-lap or branched walks.
  route_marker: `(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW},
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
)`,
  route_step: `(
  course_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  marker_id INTEGER NOT NULL,
  PRIMARY KEY (course_id, position),
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE,
  FOREIGN KEY (marker_id) REFERENCES route_marker(id) ON DELETE CASCADE
)`,
  course_snapshot: `(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  taken_at INTEGER NOT NULL,
  actor TEXT,
  reason TEXT,
  cones_json TEXT NOT NULL,
  FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE
)`,
  // Named cone orders for missions. Items keep a coordinate snapshot so a preset
  // whose cone was deleted or moved to another course is reported stale instead
  // of silently driving somewhere else.
  mission_route_preset: `(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      finish_behavior TEXT NOT NULL CHECK(finish_behavior IN ('stop', 'return_to_start')) DEFAULT 'stop',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      actor TEXT,
      FOREIGN KEY (course_id) REFERENCES course(id) ON DELETE CASCADE,
      UNIQUE (course_id, name)
    )`,
  mission_route_preset_item: `(
      id TEXT PRIMARY KEY,
      preset_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      cone_id INTEGER,
      cone_id_snapshot INTEGER NOT NULL,
      lat_snapshot REAL NOT NULL,
      lng_snapshot REAL NOT NULL,
      alt_snapshot REAL,
      side_snapshot TEXT,
      FOREIGN KEY (preset_id) REFERENCES mission_route_preset(id) ON DELETE CASCADE,
      FOREIGN KEY (cone_id) REFERENCES cone(id) ON DELETE SET NULL,
      UNIQUE (preset_id, position)
    )`,
};

export const COURSE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_cone_course ON cone(course_id)",
  "CREATE INDEX IF NOT EXISTS idx_memo_course ON memo(course_id)",
  "CREATE INDEX IF NOT EXISTS idx_route_marker_course ON route_marker(course_id)",
  "CREATE INDEX IF NOT EXISTS idx_route_step_marker ON route_step(marker_id)",
  "CREATE INDEX IF NOT EXISTS idx_course_snapshot ON course_snapshot(course_id, taken_at)",
  `CREATE INDEX IF NOT EXISTS idx_mission_preset_course
      ON mission_route_preset(course_id, updated_at DESC)`,
];

export function initializeCourseSchema(db) {
  db.pragma("foreign_keys = ON");
  for (const [table, body] of Object.entries(COURSE_TABLES)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} ${body}`);
  }
  for (const statement of COURSE_INDEXES) db.exec(statement);
}
