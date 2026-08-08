import type { Db } from "./database";

const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "001_create_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT NOT NULL UNIQUE,
        hashed_password TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS schemas (
        name TEXT PRIMARY KEY,
        creation_date TEXT NOT NULL,
        created_by TEXT NOT NULL,
        last_modified_date TEXT NOT NULL,
        last_modified_by TEXT NOT NULL,
        version INTEGER NOT NULL,
        compat_version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema TEXT NOT NULL REFERENCES schemas(name),
        label TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('text','number','boolean','date','schema-ref')),
        required INTEGER NOT NULL,
        ref_schema TEXT,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS content (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema TEXT NOT NULL REFERENCES schemas(name),
        schema_version INTEGER NOT NULL,
        creation_date TEXT NOT NULL,
        created_by TEXT NOT NULL,
        last_modified_date TEXT NOT NULL,
        last_modified_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS content_rows (
        content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
        field_id INTEGER NOT NULL REFERENCES schema_fields(id),
        value TEXT,
        PRIMARY KEY(content_id, field_id)
      );
    `,
  },
  {
    name: "002_unique_schema_field_labels",
    sql: `
      CREATE UNIQUE INDEX idx_schema_fields_schema_label
        ON schema_fields(schema, label);
    `,
  },
];

export function applyMigrations(db: Db): void {
  // Create migrations tracking table first (always)
  db.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)");

  const existing = db
    .prepare("SELECT name FROM migrations")
    .all() as { name: string }[];
  const applied = new Set(existing.map((r) => r.name));

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.name)) {
      const stmt = db.prepare("INSERT INTO migrations (name) VALUES (?)");
      db.transaction(() => {
        db.exec(migration.sql);
        stmt.run(migration.name);
      })();
    }
  }
}
