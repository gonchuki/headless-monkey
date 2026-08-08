# PLAN-25 — Front 4: eliminate check-then-act races in schema create/delete

## Goal

Make `SchemaService`'s create and delete paths atomic against interleaved writes. Two check-then-act sequences currently run as separate autocommit statements:

- **create**: `SchemaRepository.schemaExists(name)` (duplicate-name 409) then `SchemaRepository.insertSchema(...)`.
- **delete**: `SchemaRepository.getSchemasReferencing(name)` (R22 409) and `SchemaRepository.getSchema(name)` (404), then `SchemaRepository.deleteSchema(name)`.

With SQLite autocommit, another connection/statement can slip between the check and the write. Wrap each pair — check(s) + write — in one `Database.transaction`. The behavior for happy paths, 422s, 404s, and the 409s is unchanged; only the atomicity boundary moves.

This is purely a server-service change. No client, route, or spec changes.

## Dependency

- Execute after **PLAN-24** (greenfield DDL) for sequencing — the plans touch adjacent code (`schemaRepo`). This plan's tests do not depend on PLAN-24's cascade chain; they use plain schema-name uniqueness and service-level operations. If PLAN-24 were skipped, only the ordering note changes, not the tests' validity.

## Files involved

- `server/src/services/schemaService.ts` — `SchemaService.create` and `SchemaService.delete`; add the transaction boundary around each check+write.
- `server/test/schemaService.test.ts` — add the two interleaving tests (new describe block) proving atomicity.
- `server/test/schemaRoutes.test.ts` — no changes expected; existing R22 tests (which assert only HTTP 204/404/409 outcomes) must pass unchanged.

## Implementation approach

1. **Give `SchemaService` a transaction handle.** The service currently holds only `this.repo`. Store the `Db` it was constructed with (additive private field); keep the constructor signature. The repository methods it calls remain unchanged.

2. **Wrap create's duplicate check + insert.** Inside `create`, after all pure validation (zero fields, labels, required, allowed `type`, `ref_schema` existence, R10 cycle) succeeds, run inside one `db.transaction` callback both the duplicate-name check (`schemaExists(name)` throwing the 409) and `insertSchema(name, fields, createdBy)`. The existing `return this.repo.getSchema(name)!` stays outside the transaction.

3. **Wrap delete's R22 check + 404 + delete.** In `SchemaService.delete`, run inside one `db.transaction` callback: `getSchemasReferencing` (throws 409), `getSchema` (throws 404), and `deleteSchema`. Calling the repository's own `Database.transaction` from inside the service transaction is fine — nested transactions use savepoints. Do not change repository method signatures.

4. **Add interleaving tests** in `server/test/schemaService.test.ts`, modeled on the existing `openDatabase()` pattern. The tests must prove the check and write share one transaction — they simulate a competitor flush happening at the exact moment the code transitions from check to write:

   - **create race**: spy on `SchemaRepository.schemaExists` (the duplicate-name check) so that when asked about `car` it (1) inserts a full, valid competing `car` row into `schemas` via a direct prepared statement on `db` (simulating a concurrent creator), then (2) returns `false`. `service.create` then proceeds to `insertSchema`, which hits the UNIQUE/PK constraint on `schemas.name` and throws. Assert: `create` **throws** (any error type — a raw `SqliteError` here, not necessarily `SchemaServiceError`), and afterwards **no** `schemas` row named `car` exists (the competitor's row was rolled back by the same transaction). This discriminates: without the wrap, the injected row would have autocommitted and survived.
   - The injected row must be fully valid for the DDL (name, creation_date, created_by, last_modified_date, last_modified_by, version, compat_version all NOT NULL).
   - The assertion must use `toThrow()` without pinning the error class, because the interleaving path produces the underlying constraint error.

   - **delete race** (R22 check happens *first*): create `person`; create a referencing schema `car` whose `schema_fields` contains a `schema-ref` row to `person`. Spy on `SchemaRepository.getSchemasReferencing` so that on the `person` call it (1) runs the real query which returns `["car"]`, then (2) inserts a **second** referencing schema `truck` (same shape, also referencing `person`) into `schema_fields` via a prepared statement on `db`, then (3) returns `[]` — simulating a competitor having created a new referencer between check and delete. Assert: `service.delete("person")` throws 409, and afterwards no `schema_fields` row from either `car` or `truck` references `person` — the injected `truck` row rolled back with the transaction. This discriminates: a non-wrapped delete would commit `truck` and the `person` delete, leaving a dangling referencer.
   - The injected `truck` schema must exist in `schemas` first (or the field insert fails on the FK); create it with the same `service` before the spy.

   Both tests then assert the DB state directly (no row / no schema), not just the thrown status.

## Edge cases

- **Nested transactions.** The repo's `insertSchema`/`deleteSchema` already call `db.transaction`; wrapping them in the service's outer transaction is fine (savepoints). Verify `foreign_keys = on` still applies inside nested transactions.
- **404 vs 409 ordering in delete.** Keep R22 referencer check (409) before existence (404). Moving the 404 earlier breaks existing R22 route tests (the return ordering is asserted elsewhere).
- **Return value of create.** The post-insert `getSchema(name)` read may stay outside the transaction (pure read after commit).
- **Do not wrap `updateSchemaFields`.** Out of scope; the update path keeps its current behavior (Front 3 touches it separately).
- **Fresh in-memory DBs** per test (existing `openDatabase()` pattern).

## Acceptance criteria

1. `pnpm --filter server test` passes in full — including the existing R8/R9/R10/R11/R22 tests in `server/test/schemaService.test.ts` and `server/test/schemaRoutes.test.ts` unchanged.
2. `pnpm --filter server test -- schemaService` passes with a new create-interleaving test that asserts `service.create` throws and afterwards no `schemas` row named `car` exists (competitor row rolled back). (The suite run is the verdict; the specific assertion is within that test.)
3. `pnpm --filter server test -- schemaService` passes with a new delete-interleaving test that injects a second referencing schema at `getSchemasReferencing` time, asserts `service.delete("person")` throws 409 and afterwards no `schema_fields` row referencing `person` survives — including the injected one. (The suite run is the verdict.)
4. `pnpm --filter server build` passes (strict-ts compiles the new service field and tests).

## Verify notes

Run `pnpm --filter server test` and `pnpm --filter server build`. Fresh in-memory DBs per test; no dev-DB state changes.