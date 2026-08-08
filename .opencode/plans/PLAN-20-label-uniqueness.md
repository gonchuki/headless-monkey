# PLAN-20 — Enforce schema field label uniqueness on update

## Goal

Close the gap where `PATCH /api/schemas/:name` allows duplicate field labels within a schema. Add both server-level validation (matching the existing CREATE guard) and a database-level UNIQUE constraint as a safety net. This ensures labels remain unique per schema, which is a prerequisite for the content API serialization change that uses labels as keys.

## Files involved

- `server/src/services/schemaService.ts` — add duplicate label check in `update()` method
- `server/src/db/migrations.ts` — add migration for UNIQUE(schema, label) constraint on schema_fields table
- `server/test/schemaService.test.ts` — add test for duplicate labels on update
- `server/test/schemaRoutes.test.ts` — add route-level 422 test for duplicate labels on PATCH
- `SPEC.md` — amend R8 to remove the asymmetry note (update now also rejects duplicates)

## Implementation approach

1. **Server validation:** Add duplicate-label validation in `SchemaService.update()` that matches the existing guard in `create()`. Place it after the empty-label check but before field processing. Reject with 422 when labels collide.
2. **Database constraint:** Add a new migration entry that adds `UNIQUE(schema, label)` constraint to `schema_fields`. Use SQLite's table recreation pattern (the migration runner executes raw SQL in a transaction). The migration should be wrapped in a transaction so it rolls back if duplicates already exist.
3. **Tests:** Add service-level test for duplicate labels on update (should throw 422). Add route-level test for PATCH with duplicate labels → 422.
4. **SPEC.md:** Update R8 to state that both POST and PATCH reject duplicate field labels (remove the implicit asymmetry).

## Edge cases

- **Existing duplicates:** If duplicate labels already exist in the database (created before this fix, or via direct DB manipulation), the migration INSERT will fail with UNIQUE constraint violation. The transaction rolls back, and the migration is not recorded — it will retry on next boot. This is acceptable for a development app; production would need a data cleanup step first.
- **Rename to existing label:** If a field is renamed to match another field's label in the same schema, the duplicate check should catch this (the Set includes all labels after the rename).
- **Case sensitivity:** Labels are compared as-is (case-sensitive). "Name" and "name" are different labels. This matches the existing CREATE behavior.

## Acceptance criteria

1. `pnpm --filter server test` passes (all existing tests + new tests for duplicate labels on update).
2. **Manual verification (cannot be verified by automated tests):** create a schema with two fields, PATCH to rename one field to match the other's label → 422 response with duplicate label error.
