// The subset of the better-sqlite3 API the course service uses, over the
// SQLite WASM OO1 API. Statements are reset after every call so a cached
// statement can be reused like better-sqlite3's.
export function wrapOo1(sqlite3, oo1) {
  const { capi } = sqlite3;

  function bindArgs(stmt, args) {
    stmt.reset(true);
    const flat = args.flat();
    if (flat.length) stmt.bind(flat.map((value) => (value === undefined ? null : value)));
  }

  class Statement {
    constructor(sql) {
      this.source = sql;
      this.stmt = oo1.prepare(sql);
      this.reader = this.stmt.columnCount > 0;
    }
    run(...args) {
      bindArgs(this.stmt, args);
      try {
        while (this.stmt.step());
      } finally {
        this.stmt.reset(true);
      }
      return { changes: oo1.changes(), lastInsertRowid: Number(capi.sqlite3_last_insert_rowid(oo1.pointer)) };
    }
    get(...args) {
      bindArgs(this.stmt, args);
      try {
        return this.stmt.step() ? this.stmt.get({}) : undefined;
      } finally {
        this.stmt.reset(true);
      }
    }
    all(...args) {
      bindArgs(this.stmt, args);
      const rows = [];
      try {
        while (this.stmt.step()) rows.push(this.stmt.get({}));
      } finally {
        this.stmt.reset(true);
      }
      return rows;
    }
  }

  let savepointSeq = 0;
  const db = {
    prepare: (sql) => new Statement(sql),
    exec(sql) {
      oo1.exec(sql);
      return db;
    },
    pragma(source, { simple = false } = {}) {
      const rows = new Statement(`PRAGMA ${source}`).all();
      if (!simple) return rows;
      return rows[0] ? Object.values(rows[0])[0] : undefined;
    },
    get inTransaction() {
      return capi.sqlite3_get_autocommit(oo1.pointer) === 0;
    },
    // Nested calls become savepoints, like better-sqlite3.
    transaction(fn) {
      return function wrapped(...args) {
        if (db.inTransaction) {
          const name = `sp_${++savepointSeq}`;
          oo1.exec(`SAVEPOINT ${name}`);
          try {
            const result = fn.apply(this, args);
            oo1.exec(`RELEASE ${name}`);
            return result;
          } catch (error) {
            oo1.exec(`ROLLBACK TO ${name}`);
            oo1.exec(`RELEASE ${name}`);
            throw error;
          }
        }
        oo1.exec("BEGIN");
        try {
          const result = fn.apply(this, args);
          oo1.exec("COMMIT");
          return result;
        } catch (error) {
          if (db.inTransaction) oo1.exec("ROLLBACK");
          throw error;
        }
      };
    },
    close: () => oo1.close(),
  };
  return db;
}
