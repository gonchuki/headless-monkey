import type { Db } from "./database";

// Greenfield schema baseline. Exactly the DDL frozen in SPEC §4 (v0.7).
// This is a BREAKING change: the migration is intentionally NOT renumbered so
// that an old dev DB created by `001_create_tables` is not "upgraded" — the
// dev `data/` DB must be deleted by hand and recreated fresh (see PLAN-24).
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "001_initial_schema",
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT NOT NULL UNIQUE,
        hashed_password TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE schemas (
        name TEXT PRIMARY KEY,
        creation_date TEXT NOT NULL,
        created_by TEXT NOT NULL,
        last_modified_date TEXT NOT NULL,
        last_modified_by TEXT NOT NULL,
        version INTEGER NOT NULL,
        compat_version INTEGER NOT NULL
      );

      CREATE TABLE schema_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
        label TEXT NOT NULL,
        type TEXT NOT NULL
          CHECK(type IN ('text','number','boolean','date','schema-ref')),
        required INTEGER NOT NULL,
        ref_schema TEXT,
        sort_order INTEGER NOT NULL,
        UNIQUE (schema, label),
        CHECK (type != 'schema-ref' OR ref_schema IS NOT NULL)
      );

      CREATE TABLE content (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL,
        creation_date TEXT NOT NULL,
        created_by TEXT NOT NULL,
        last_modified_date TEXT NOT NULL,
        last_modified_by TEXT NOT NULL
      );

      CREATE TABLE content_rows (
        content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
        field_id INTEGER NOT NULL REFERENCES schema_fields(id) ON DELETE CASCADE,
        value TEXT,
        PRIMARY KEY(content_id, field_id)
      );

      CREATE TABLE content_refs (
        content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
        field_id INTEGER NOT NULL REFERENCES schema_fields(id) ON DELETE CASCADE,
        target_content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE RESTRICT,
        PRIMARY KEY(content_id, field_id)
      );

      CREATE INDEX idx_content_refs_target ON content_refs(target_content_id);
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
