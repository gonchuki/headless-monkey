# Add Secondary Indexes for Hot Content Queries

## Goal

Three hot queries full-scan tables that have no usable index:

1. `ContentRepository.listEntries` and `listEntriesPaginated` filter `WHERE content.schema = ?` — every editor listing, public list, and paginated fetch. `content` has no secondary index, so this is a full table scan. Confirmed via `EXPLAIN QUERY PLAN`: `SCAN content`.
2. The R35 retarget purge in `SchemaRepository.updateSchemaFields` runs `DELETE FROM content_refs WHERE field_id IN (...) AND content_id IN (SELECT id FROM content WHERE schema = ?)`. Its `content` subquery is a full scan (same missing index).
3. Deleting a `schema_fields` row cascades (`ON DELETE CASCADE`) to `content_rows` and `content_refs` through their `field_id` foreign keys. Neither table's primary key is `(content_id, field_id)` with `field_id` leftmost, and no `field_id`-only index exists, so SQLite resolves the cascade by scanning both tables.

Add one **additive** migration creating three secondary indexes so these stop scanning.

> **SPEC note (do not edit SPEC.md):** SPEC §4's DDL block is frozen and lists only `idx_content_refs_target`. This plan intentionally diverges by adding three indexes. The addition is **semantics-preserving** (index-only; no schema shape, no query results, no FK behavior changes) — it only changes SQLite's plan choice. A separate SPEC revision (v0.12, being revised independently) may want to mirror the new indexes in §4; **that is out of scope here. Do not modify SPEC.md in this plan.**

## Files Involved

- `server/src/db/migrations.ts` — the `MIGRATIONS` array (append one new entry; applied by `applyMigrations`, which already tracks applied migrations by name).
- `server/test/database.test.ts` — where the greenfield DDL / index assertions live.

## Implementation Approach

1. **Append a new migration entry** to `MIGRATIONS`, after `001_initial_schema`, with a distinct name (e.g. `002_secondary_indexes`). Its SQL creates exactly three indexes, following the existing `idx_<table>_<column>` naming convention (cf. `idx_content_refs_target`):

   ```sql
   CREATE INDEX idx_content_schema          ON content(schema);
   CREATE INDEX idx_content_rows_field_id   ON content_rows(field_id);
   CREATE INDEX idx_content_refs_field_id   ON content_refs(field_id);
   ```

   Use plain `CREATE INDEX` (not `IF NOT EXISTS`) to match `001_initial_schema`'s style; the runner's name-tracking guarantees the entry runs once per database. Add a short comment on the entry noting it is an additive, semantics-preserving index addition that the frozen SPEC §4 block does not yet list.

2. **Do not touch `001_initial_schema`.** It is the frozen greenfield baseline; editing or renumbering it would break the "an old dev DB is not upgraded" invariant noted in its comment. The new entry is purely additive:
   - On a **fresh** database, `001` then `002` run (indexes created).
   - On an **existing** dev database (where `001_initial_schema` is already recorded in the `migrations` table), only `002` runs (indexes added). No runner change is needed.

3. **Tests** in `database.test.ts` (see Acceptance Criteria).

### Why these three (and the precise attribution)

- `idx_content_schema` — directly fixes the `WHERE content.schema = ?` scan in both listing paths **and** the R35 purge's `content` subquery. Empirically confirmed: `SCAN content` → `SEARCH content USING INDEX idx_content_schema`.
- `idx_content_rows_field_id` and `idx_content_refs_field_id` — primarily serve the **field-delete FK cascade**: deleting a `schema_fields` row makes SQLite look up child rows by `field_id`, which today scans both tables (field_id is not leftmost in either PK, and no `field_id`-only index exists).
- **Attribution correction:** the R35 purge's *direct* `DELETE FROM content_refs WHERE field_id IN (...) AND content_id IN (...)` already resolves `content_refs` via its PK autoindex (`(content_id, field_id)`) — the scan in that statement is the `content` subquery, fixed by `idx_content_schema`. So `idx_content_refs_field_id` is justified by the delete cascade, not by the purge's own `content_refs` access. The index is still correct and worth adding; this note just pins the right reason.

## Edge Cases

1. **Index-name collisions:** the three new names must be distinct from the existing `idx_content_refs_target` (they are) and from SQLite autoindexes.
2. **Idempotency / existing DBs:** re-running migrations on an already-migrated database must not error or duplicate indexes. The name-tracking in `applyMigrations` handles this; the existing file-persistence test (which reopens a database and re-applies migrations) must stay green.
3. **No behavior change:** adding indexes must not change any query's result set, ordering, or FK behavior — only the execution plan. Every pre-existing test must pass **unmodified**.
4. **`EXPLAIN QUERY PLAN` is plan-sensitive:** assert on the index *name appearing in the plan* (and the absence of a bare table `SCAN` for the indexed predicate), not on exact plan wording, which can vary by SQLite version.

## Acceptance Criteria

1. **Indexes applied and used; nothing regressed.** `cd server && npx vitest run` exits 0 with: (a) tests in `database.test.ts` confirming that on a freshly opened database, `SELECT name FROM sqlite_master WHERE type = 'index'` includes `idx_content_schema`, `idx_content_rows_field_id`, and `idx_content_refs_field_id` (alongside the pre-existing `idx_content_refs_target`), and that for a populated database `EXPLAIN QUERY PLAN` reports index usage — not a bare table `SCAN` — for `SELECT * FROM content WHERE schema = ?` (uses `idx_content_schema`), `SELECT * FROM content_rows WHERE field_id = ?` (uses `idx_content_rows_field_id`), and `SELECT * FROM content_refs WHERE field_id = ?` (uses `idx_content_refs_field_id`); and (b) **all** pre-existing tests passing unmodified (greenfield DDL baseline, cascade tests, file-persistence reopen), confirming the migration is additive and idempotent across fresh and reopened databases.
2. **Type-checks.** `cd server && npx tsc --noEmit` exits 0.
3. **SPEC untouched.** `git diff --name-only` shows no change to `SPEC.md`.
