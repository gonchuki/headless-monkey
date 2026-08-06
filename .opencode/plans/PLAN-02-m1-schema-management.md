# PLAN-02: M1 — DB + schema management (server)

**Originating milestone:** M1
**Depends on:** PLAN-01 (provides the server package, `createApp()` factory, and the vitest+supertest harness — confirm `pnpm --filter server test` and `pnpm build` pass before starting)

## Goal

Schema create/read/update/delete endpoints with correct `version`/`compat_version` semantics, full-graph circular `schema-ref` rejection, field-delete propagation, cascade schema delete, and a 409 block on deleting a still-referenced schema.

## Spec refs (verbatim from milestone M1)

SPEC §2 R8–R15, R21, R22; §4 DB DDL, schema routes, id-stable field contract; §5 no-ORM migrations + ASSUMPTION (block referenced-schema delete); §7 compat table.

## Files involved

- `server/src/db/database.ts` — sqlite connection factory (per-test in-memory).
- `server/src/db/migrations.ts` — sequential migration runner + all migrations.
- `server/src/repositories/schemaRepo.ts`
- `server/src/services/schemaService.ts`
- `server/src/routes/schemas.ts`
- `server/src/types.ts` — shared field/schema types.
- `server/src/app.ts` — mount the schemas router (unauthenticated for now; guard lands in PLAN-03).
- `server/test/schemaService.test.ts`, `server/test/schemaRoutes.test.ts`.

## Approach

1. **Migration runner:** a sequential runner applying ordered SQL migrations inside a transaction, recording applied versions. Migrations create exactly the tables from SPEC §4 DDL: `users`, `schemas`, `schema_fields` (type CHECK constraint, `ref_schema`, `sort_order`), `content`, `content_rows` (composite PK, `ON DELETE CASCADE` on `content_id`).
2. **Repositories:** `schemaRepo` covering insert schema + fields, list schemas (with field count / entry count as needed by the UI later), get schema with fields (ordered by `sort_order`), update fields (insert new, update existing by `field_id`, delete absent ids), delete schema (cascades per DDL), and count entries per schema for the delete confirmation.
3. **`schemaService` (core logic, unit-tested):**
   - *Create:* reject zero fields (422-equivalent at route), duplicate field labels, invalid `type`, `ref_schema` that doesn't exist, and circular references (R8–R10). Set `version = compat_version = 1` and all audit timestamps (R11). Uniqueness of `name` → 409.
   - *Cycle detection:* traverse the full `schema-ref` graph (not just neighbors) whenever a `schema-ref` field is created/updated; a path back to the edited schema closes a cycle → reject (R10). Self-reference is a cycle.
   - *Update:* fields are id-stable — existing fields carry their `id`, new fields omit it, absent ids are deleted (R15). `version` always +1 (R12). Compute compat per the §7 table exactly: unchanged for add-optional-field, `number→text`, `required→optional`, label rename, reorder; `compat_version = version` otherwise (R13, R14).
   - *Propagation (R21):* when a field is deleted, delete that field's `content_rows` across all entries of the schema and set each surviving entry's `schema_version` to the new version.
   - *Delete (R22):* cascade-delete schema + its content; but if another schema's `schema-ref` references this schema, return 409 naming the referencing schema.
4. **Routes:** `GET/POST /api/schemas`, `GET/PATCH/DELETE /api/schemas/:name` translating service errors to R8–R10 status codes (422 validation, 409 conflicts). `PATCH` body uses the id-stable `fields` shape.
5. **Tests:** assert every row of the §7 compat table produces the expected `version`/`compat_version`; R8–R15, R21, R22; direct and transitive cycle rejection; referenced-schema delete → 409; field-delete propagation bumps entry versions and removes rows.

## Edge cases

- `schema-ref` `ref_schema` pointing at itself, or a two-schema mutual cycle — both must be rejected.
- Renaming a field label must NOT change its `field_id` and must not touch stored `content_rows`.
- Reordering must persist `sort_order` and be non-breaking (compat unchanged).
- Deleting the last field of a schema is allowed as a schema edit, but a *new* schema with zero fields is rejected.
- The `content`/`content_rows` tables are created by step 1's migrations even though no content routes exist yet — the propagation SQL runs against them directly.

## Acceptance criteria

1. `pnpm --filter server test` passes, including `schemaService.test.ts` and `schemaRoutes.test.ts`. The schema suite's parameterized §7 compat test asserts the resulting `version` and `compat_version` for every transition row in the §7 table.
2. A test creates `person`, then `car` with `schema-ref<person>`, then deletes `person` → 409 naming `car`; deleting `car` succeeds.
3. A test verifies field-delete propagation: deleting a field from `car` removes that field's rows from all `car` entries and sets those entries' `schema_version` to the new version (R21).
4. Cycle tests: `car→person→car` and self-referential `car→car` both rejected with 422.

Milestone M1 verify gate (preserved): `pnpm --filter server test` passes (schema suite).
