# PLAN-26 — Front 1: move entry-level schema-ref values into the `content_refs` table

## Goal

Stop storing schema-ref values as `JSON.stringify(target_id)` numbers inside `content_rows.value`, and store them relationally in the normalized `content_refs(content_id, field_id, target_content_id)` table introduced by PLAN-24. This is the storage half of the referential-integrity redesign: after this plan, a schema-ref target is a real FK edge (target enforced `ON DELETE RESTRICT` by the DDL) instead of an opaque scalar, so Fronts 2 (blocked deletion), 3 (retarget purge), and 5 (read-path proofs) all operate on one relational source of truth.

The public/editor serialization shapes must **not** change in this plan: editor shape stays `values` keyed by `String(field_id)` with raw target-id numbers; public shape keeps `{id, schema}` enrichment exactly as today. Only the underlying storage and read/write plumbing changes. The v0.7 id-keyed `values` + `meta.fields` wrapper is specified in PLAN-23 (doc-only) and remains a separate serializer follow-up; this plan keeps the existing serializers green so the whole suite passes at every commit.

## Dependency

- Requires **PLAN-24** (greenfield DDL): the `content_refs` table, `idx_content_refs_target`, and the schema-field cascade chains must exist before this plan runs.
- Does **not** require PLAN-25, but they touch disjoint code (`schemaService` vs `contentService/repo`) so either order after PLAN-24 works.

## Files involved

- `server/src/repositories/contentRepo.ts` — `ContentEntryRow` gains a `refs` collection; `insert`, `replaceRows`, `getEntry`, `listEntries` read/write `content_refs`.
- `server/src/services/contentService.ts` — `buildRows`, `toEntry`, and the create/update flow carry refs; `isValidValue`-based validation is unchanged for schema-ref targets.
- `server/test/contentService.test.ts` — extend with ref-specific storage/read tests.
- `server/test/publicApi.test.ts` — existing route-level tests stay green (no shape changes). There is no `contentRoutes.test.ts`; the route tests live here.
- `server/src/routes/*` — intentionally no changes.

## Implementation approach

1. **Extend the repository's read model.** `ContentEntryRow` already carries `record: ContentRecord` and `rows: ContentRow[]`. Add `refs: { field_id: number; target_content_id: number }[]` (or a `Map<number, number>`-equivalent structure in-memory) populated by `getEntry` and `listEntries` queries against `content_refs` (ordered by `field_id`). Keep `rows` for scalars only.

2. **Write refs on insert.** Extend the `insert` signature to accept ref pairs alongside the scalar-rows map (e.g., a second map `fieldId → targetContentId`). Inside the existing transaction, after writing `content_rows`, write one `content_refs` row per present ref. No ref row is written when an optional ref is absent.

3. **Rewrite refs on update.** Extend `replaceRows` the same way: in its transaction, `DELETE FROM content_refs WHERE content_id = ?` (mirroring the existing `content_rows` delete), then insert the submitted refs. Empty ref set means all old refs are removed.

4. **Reassemble rows in `ContentService.buildRows`.** Replace the single `Map<number, string>` output with a composite carrying both scalar rows and schema-ref pairs. Logic stays:
   - For a submitted schema-ref value (a positive integer), run the existing `validateSubmitted`/`isValidValue` check (`entryExistsInSchema(value, field.ref_schema)`), then emit a **ref entry** — do not `JSON.stringify` it into `content_rows`.
   - For a submitted scalar, keep the existing `JSON.stringify` path.
   - For the *omitted* case (client did not resubmit that field and this is an update), carry over the stored ref from `existing.refs` (validated the same way), mirroring the current stored-value carry logic; if no stored ref exists and the field is optional, leave it absent. Required fields that end up without a value (new or carried) must still throw 422 as today.

5. **Reassemble `ContentEntryRow` on read.** `create` and `update` call `toEntry(this.requireEntry(id), ...)`; `requireEntry` now returns the extended row including `refs`, so `toEntry`:
   - for `schema-ref` fields reads the target id from `entry.refs` (keyed by field id),
   - for scalar fields reads `entry.rows.value` and parses as before,
   - editor shape: `values[String(field_id)] = <target number>` (or omit absent optional),
   - public shape: existing `{id, schema: field.ref_schema}` enrichment.
   No change to the response envelope.

6. **Keep `schemaService` untouched.** The R9/R10/cycle and ref_schema validation live in `schemaService`; no entry-value storage lives there, so no edits needed. Verify.

## Edge cases

- **Optional ref absent on create**: no ref row is written; serialization omits the key (existing absent-key behavior preserved).
- **Optional ref cleared on update**: client sends `null` for the field — ref rows for that field must be deleted (the `DELETE ... WHERE content_id = ?` in replaceRows covers it).
- **Required ref missing/cleared**: `buildRows` throws 422 exactly as today (the required-field checks unchanged).
- **Stale carried refs**: if an existing entry has a ref but the schema-editor pushes a change (e.g. retarget, Front 3), validation must not silently accept a ref whose target no longer exists in `field.ref_schema`; continue using `entryExistsInSchema` on the carried value.
- **Single ref per (content_id, field_id)**: DDL primary key enforces it; repository code must not try to write two ref rows for one field.
- **No dual storage**: after this plan there must be **zero** schema-ref values encoded in `content_rows.value`. If any were found during the transition, that is a bug; the old rows die with the content entry via cascade on field/schema deletion.
- **The public wrapper**: do *not* implement `{meta, entries}`/id-keyed `values` here — that belongs to a later serializer plan; the SPEC (PLAN-23) is binding for it, not this plan.

## Acceptance criteria

1. `pnpm --filter server test` passes in full — including the unchanged serialization tests in `server/test/contentService.test.ts`, `server/test/publicApi.test.ts`, and the R21 tests in `schemaService.test.ts`/`schemaRoutes.test.ts` (no shape changes observed).
2. `pnpm --filter server test -- contentService` passes with a created-entry storage test asserting, against the DB, that a schema-ref target is stored as an integer row in `content_refs` **and** there is no JSON-number value for that field id in `content_rows`. The test queries both tables directly and fails if either half is wrong.
3. `pnpm --filter server test -- contentService` passes with a round-trip test: create an entry whose schema-ref points at another schema's entry, then read via `listForSchema` (editor shape) and assert the raw target number under `String(field_id)`; read via `listPublic`/`getPublic` (public shape) and assert the existing `{id, schema}` keying. The two reads' assertions are in the same test but independently failable.
4. `pnpm --filter server test -- contentService` passes with an update test: change a schema-ref value from entry A to entry B, assert `content_refs` holds exactly one row pointing at B (old A row gone) and `content_rows` holds no schema-ref number for that field.
5. `pnpm --filter server test -- contentService` passes with an optional-clear test: updating an optional schema-ref field from a ref to `null` leaves zero `content_refs` rows for that (content_id, field_id) pair.
6. `git diff` over `server/src` for this plan touches only `server/src/repositories/contentRepo.ts` and `server/src/services/contentService.ts` (plus test files); no changes under `server/src/routes/` or `server/src/services/schemaService.ts`, and no changes under `client/`.
7. Reading `server/src/services/contentService.ts` and `server/src/repositories/contentRepo.ts`, no `JSON.stringify` is applied to schema-ref values: the submitted schema-ref target never goes to `content_rows.value`, and the only `JSON.stringify` calls remaining target scalar values (`text|number|boolean|date`). (Inspection criterion — this is the one negative invariant that is cheaper to verify by source than by behavior.)

## Verify notes

`pnpm --filter server test` then `pnpm --filter server build`. The dev `data/` DB must be wiped before running `pnpm dev` as per PLAN-24's dev-DB note (the new baseline table).