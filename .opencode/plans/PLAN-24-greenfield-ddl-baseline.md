# PLAN-24 — Greenfield SQLite baseline: normalized `content_refs`, cascade chains, and R23/R24 referential-integrity foundations

## Goal

Replace the current two-step migration history (`001_create_tables` + `002_unique_schema_field_labels`) with a single greenfield baseline that matches the SPEC v0.7 §4 DDL exactly (PLAN-23 defines that contract; this plan implements it). Because the DB can be wiped, the migration runner keeps existing, but the `MIGRATIONS` array becomes one clean `001_initial_schema` entry — no table-rebuild migrations are needed.

The new DDL introduces:
- `ON DELETE CASCADE` on `schema_fields.schema`, `content.schema`, `content_rows.content_id`, `content_rows.field_id`, `content_refs.content_id`, and `content_refs.field_id`.
- `content_refs` with `ON DELETE RESTRICT` on `target_content_id` (the R23 backstop at the DB level).
- `idx_content_refs_target` for the "who references X?" lookups.
- Inline `UNIQUE (schema, label)` and `CHECK (type != 'schema-ref' OR ref_schema IS NOT NULL)` on `schema_fields`.

This plan is DDL + repo mechanics only. It does **not** switch schema-ref values into `content_refs` yet — that is Front 1 (a later plan). After this plan, `content_refs` exists and is FK-enforced but is not written by the application; schema-ref values still flow through `content_rows.value` JSON exactly as today, so the repo stays green at every commit.

The plan also collapses the manual cascade deletes that the DDL now handles automatically:
- `schemaRepo.deleteSchema` becomes a single `DELETE FROM schemas WHERE name = ?`.
- `schemaRepo.updateSchemaFields` no longer manually deletes `content_rows` for deleted field ids (the `field_id` cascade does it) but must keep the R21 `schema_version` bump logic intact.

## Files involved

- `server/src/db/migrations.ts` — replace the `MIGRATIONS` array with the single greenfield migration from SPEC v0.7 §4.
- `server/src/repositories/schemaRepo.ts` — simplify `deleteSchema`; remove the manual `content_rows` prune in `updateSchemaFields` (keep the version bump).
- `server/test/database.test.ts` — extend with DDL-shape, cascade, and FK-enforcement tests.
- `server/test/schemaService.test.ts` and `server/test/schemaRoutes.test.ts` — R21 field-delete propagation tests must still pass unchanged (the behavior is preserved by the cascade + retained bump). Verify; only edit if a test asserted the old manual-prune SQL directly.
- `server/src/db/database.ts` — no change (already sets `journal_mode = WAL` and `foreign_keys = on`).
- `SPEC.md` — no change in this plan (PLAN-23 owns the contract).

## Implementation approach

1. **Rewrite `migrations.ts`.** Replace the `MIGRATIONS` array with one entry named `001_initial_schema`. The `applyMigrations` runner logic (migrations tracking table, skip-applied, per-migration transaction) stays as-is. The SQL must be exactly the DDL from SPEC v0.7 §4 (PLAN-23 step 7), with `CREATE TABLE` and `CREATE INDEX` (no `IF NOT EXISTS` needed for the tables, since the runner guarantees single application; matching SPEC verbatim is the requirement). Verify the `users`, `schemas`, `schema_fields`, `content`, `content_rows`, `content_refs` tables and the `idx_content_refs_target` index are all present after a fresh `openDatabase()`.
2. **Simplify `schemaRepo.deleteSchema`.** Replace the four-statement transaction with a single `DELETE FROM schemas WHERE name = ?`. The cascade chain removes `schema_fields`, `content`, `content_rows`, and `content_refs` rows for that schema. Keep the R22 referencer check in `schemaService.delete` untouched (it still runs before the repo call and is the service-layer gate; a later plan wraps it in a transaction to close the TOCTOU window).
3. **Remove the manual prune in `schemaRepo.updateSchemaFields`.** The existing R21 propagation block first deletes `content_rows WHERE field_id IN (deletedIds) AND content_id IN (SELECT id FROM content WHERE schema = ?)`, then bumps `content SET schema_version`. The manual row delete is now redundant: `deleteField` deletes the `schema_fields` row and the `content_rows.field_id` cascade removes the rows. Delete the manual `DELETE FROM content_rows ...` statement, keep the `UPDATE content SET schema_version = ? WHERE schema = ?` bump (guarded by `deletedFieldIds.length > 0` as today), and keep the `deletedFieldIds` parameter and the `deleteField` loop unchanged. The R21 tests in `schemaService.test.ts` and `schemaRoutes.test.ts` assert the outcome (rows removed + version bumped), not the mechanism, so they must pass without modification.
4. **Add DDL/cascade/FK tests in `server/test/database.test.ts`.** Follow the existing file-persistence test's `openDatabase()` pattern. Add a describe block that:
   - asserts the schema shape: `content_refs` and `idx_content_refs_target` exist in `sqlite_master`, and `PRAGMA foreign_keys` returns `1` (this is the enforcement precondition for every cascade in this plan);
   - inserts a schema + fields + content + rows via direct SQL (mirroring `schemaRoutes.test.ts`'s existing R21 setup), deletes the schema row directly with `DELETE FROM schemas WHERE name = ?`, and asserts the fields, content, and rows are gone (cascade works without the manual multi-statement delete);
   - inserts two schemas with a `schema-ref` field and a manually inserted `content_refs` row, then asserts `DELETE FROM content WHERE id = <target>` throws a SQLite FK constraint error (RESTRICT), while deleting an unreferenced entry succeeds;
   - asserts deleting a `schema_fields` row cascades its `content_rows` rows (no orphan rows remain).
5. **Verify the dev DB wipe requirement.** The repo's dev DB at `data/` (from `DATABASE_PATH`, PLAN-14) was created with the old `001_create_tables`; re-running with the same migration name would skip the new DDL. Document in the plan's verify notes (and in the PR description) that a developer must delete the `data/` DB file before running `pnpm dev` — tests are unaffected because they use fresh in-memory/temp DBs.

## Edge cases

- **`content_refs` is dormant after this plan.** It is created and FK-enforced, but `ContentService` still writes schema-ref values into `content_rows.value` as JSON numbers. Do not "improve" `ContentService` in this plan — the ref-switch is a later, separate plan. Any attempt to write `content_refs` from the application now would create a second, competing source of truth.
- **Cascade ordering inside SQLite.** With `ON DELETE CASCADE` on the structural edges, a single `DELETE FROM schemas` removes dependents in SQLite's internal order. The FK graph here has no cycle (refs point at other content, not back into `schemas`), and `content_refs.target_content_id` is `RESTRICT` — so deleting a schema whose entries are referenced by *other* schemas' content will throw at the DB level. That is acceptable and is the R23 backstop; the service-layer R22 check (schemas referencing a schema) is separate and still required.
- **R21 tests must not change.** The behavior — deleted field's rows gone, surviving entries' `schema_version` bumped — is preserved by cascade + retained bump. If any test asserted the exact manual-prune SQL, update that assertion to the preserved outcome, not the mechanism.
- **Do not renumber the migration.** Keeping the name `001_initial_schema` while changing its SQL is what forces the dev-DB wipe; tests with fresh DBs are immune. Do not add a `003` migration to "fix" old DBs — the greenfield wipe is the intended path.

## Acceptance criteria

1. `pnpm --filter server test` passes, including the unchanged R21 tests in `schemaService.test.ts` and `schemaRoutes.test.ts`. (This is the behavioral gate: the cascade + retained bump keep existing behavior green.)
2. The new describe block in `server/test/database.test.ts` contains an assertion that a fresh in-memory DB from `openDatabase()` has a `content_refs` table, an `idx_content_refs_target` index, and `PRAGMA foreign_keys` returning `1`. (Verifiable by reading the test file — the verdict is assertion present/absent, not suite status.)
3. The same describe block contains an assertion that a bare `DELETE FROM schemas WHERE name = ?` removes the schema's `schema_fields`, `content`, and `content_rows` rows without any manual multi-statement delete. (Verifiable by reading the test file.)
4. The same describe block contains an assertion that `DELETE FROM content` on an entry targeted by a `content_refs` row throws a SQLite constraint error, and that deleting an unreferenced entry succeeds. (Verifiable by reading the test file.)
5. The same describe block contains an assertion that deleting a `schema_fields` row removes its `content_rows` rows. (Verifiable by reading the test file.)
6. `schemaRepo.deleteSchema` contains exactly one DELETE statement against `schemas` and no statement against `content_rows`, `content`, or `schema_fields`. (Verifiable by reading `server/src/repositories/schemaRepo.ts` — the verdict is statement presence/absence.)
7. `schemaRepo.updateSchemaFields` contains no statement `DELETE FROM content_rows WHERE field_id IN ...` and still contains the `UPDATE content SET schema_version = ?` bump. (Verifiable by reading the file.)
8. `git diff` over the changes made by this plan touches exactly `server/src/db/migrations.ts`, `server/src/repositories/schemaRepo.ts`, and `server/test/database.test.ts` — no changes in `server/src/services/contentService.ts` or `server/src/repositories/contentRepo.ts` (the ref-table switch is a later plan), and no changes under `client/`.

## Verify notes

`pnpm --filter server test` then `pnpm --filter server build`.

**Dev DB wipe (required, BREAKING).** This plan changes the SQL behind the migration name `001_initial_schema`, so an existing dev DB created by the old `001_create_tables` is skipped (the runner only tracks names). Before running `pnpm dev`, delete the repo-root `data/` DB files — `headless-monkey.db` plus its `-wal`/`-shm` siblings (from `DATABASE_PATH`, PLAN-14) — so a fresh DB is created on the next boot. Tests are unaffected because they use fresh in-memory/temp DBs.
