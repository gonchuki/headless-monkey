# PLAN-28 — Front 3: purge schema-ref targets when `ref_schema` retargets (R35)

## Goal

Implement **R35**: when a schema-ref field's `ref_schema` changes, remove every stored target for that field from the schema's entries and **do not** bump the entries' `schema_version`. The entries stay conflicted (`schema_version < compat_version`) — the retarget is a breaking change (§7 sets `compat_version = version`), so the public API already 422s/excludes them and the editor must re-select a target from the new schema.

This differs deliberately from R21 (field deletion), where `schema_version` **is** bumped because the entry is complete once the field is gone. After a retarget the field still exists and the entry is missing a valid target for it, so the conflict must persist until an editor re-saves. (The version-bump misconception was the original design error; PLAN-23's R35 text now states the no-bump semantics.)

Mirror R21's propagation but scoped to *retargeted* fields: purge the field's `content_refs` rows for the schema's entries, leave `schema_version` untouched.

## Dependency

- Requires **PLAN-26** (content_refs storage): the purge deletes rows from `content_refs` (that is where targets live after Front 1).
- Requires the corrected **PLAN-23** R35 wording (no `schema_version` bump) — already fixed in the plan file.
- Compose on top of **PLAN-24**: `updateSchemaFields` no longer manually prunes `content_rows` (cascade does it); the R21 bump block remains for deleted fields.

## Files involved

- `server/src/repositories/schemaRepo.ts` — `updateSchemaFields`: accept the set of retargeted field ids and delete their `content_refs` for the schema's entries, **without** touching `content.schema_version`.
- `server/src/services/schemaService.ts` — `update()`: compute retargeted field ids (schema-ref fields whose `ref_schema` changed between existing and incoming fields) and pass them to `updateSchemaFields`; keep the `compat_version` computation (already breaking).
- `server/test/schemaService.test.ts` — service-level purge test.
- `server/test/schemaRoutes.test.ts` — route-level test mirroring the existing R21 route test.
- `server/test/contentService.test.ts` — optional: assert conflicted entries are excluded from `listPublic` after the retarget (already covered by the conflict filter, but a guard test documents the invariant).

## Implementation approach

1. **Compute retargeted field ids in `SchemaService.update()`.** Alongside the existing `deletedFieldIds` computation (incoming vs existing ids), compute `retargetedFieldIds`: for each incoming field carrying an `id` that exists in `existing.fields`, both old and new `type === "schema-ref"`, and `old.ref_schema !== new.ref_schema`. Pass the array to `updateSchemaFields` as a new parameter (after `deletedFieldIds`).

2. **Purge refs in `updateSchemaFields`.** In `server/src/repositories/schemaRepo.ts`, extend `updateSchemaFields` with the new parameter. If non-empty, run `DELETE FROM content_refs WHERE field_id IN (<ids>) AND content_id IN (SELECT id FROM content WHERE schema = ?)`. Do **not** execute the `UPDATE content SET schema_version` bump for this case — only the existing `deletedFieldIds` block keeps its bump, and that bump is itself gated (step 3). Order matters: purge retargeted refs **before** the deleted-fields block runs, so a mid-edit state never exposes stale refs. Keep the statement count small (one prepared DELETE, loop-free).

3. **Gate the R21 bump against concurrent retargets.** The existing `deletedFieldIds` block (delete + bump) stays after PLAN-24's simplification (no manual `content_rows` delete; bump retained) **but the bump must be gated**: `if (deletedFieldIds.length > 0 && retargetedFieldIds.length === 0)` — because the bump is schema-wide (`UPDATE content SET schema_version = ? WHERE schema = ?`) and a mixed PATCH (delete field X + retarget field Y) would otherwise un-conflict entries that still miss a valid target for Y, re-opening the data-integrity hole this plan exists to close. The `deletedFieldIds` delete still runs unconditionally; only the `schema_version` update is gated. A field that is simultaneously deleted and retargeted is impossible (delete removes the field), so the two sets are disjoint; if both arrays are empty, no propagation runs.

4. **Route/SSE.** No route or SSE change. The existing `schema.updated` SSE event already fires on `PATCH /api/schemas/:name`; the client already refetches on it.

5. **Tests.**
   - Service test (mirror R21's shape): create `person` and `company`; create `car` with `owner → person` (schema-ref, optional); create a person entry and a car entry referencing it; read the `owner` field id from the created schema (`car.fields.find(f => f.label === "owner")!.id`) — do **not** hardcode `1`, because `updateField` is scoped only by field id, not by `schema`, and a hardcoded value could silently update the wrong schema in the test DB; then `service.update("car", [{id: <ownerId>, label: "owner", type: "schema-ref", required: false, ref_schema: "company"}, ...])`. Assert: (a) `content_refs` for the car entry's `owner` field is empty; (b) the car entry's `schema_version` is **unchanged** (the value it had before the update, not the new schema version); (c) the schema's `compat_version` equals the new version (breaking) so the entry is conflicted; (d) `listPublic("car")` excludes the entry and `getPublic("car", id)` throws `ContentServiceError` with `statusCode === 422`. Add a sibling case: the same retarget with the field **required** — same purge, still no bump, still conflicted. Optionally include a variant where the entry was *already* conflicted (older `schema_version`) before the retarget — the purge hits it and it stays conflicted.
   - Route test (mirror `schemaRoutes.test.ts`'s R21 describe): PATCH the schema, assert 200; then query the DB for `content_refs` and the `content.schema_version` value directly.
   - Regression: R21's existing tests still pass (deleted-field bump preserved).

## Edge cases

- **No refs to purge**: if the schema has no entries or no entries use that field, the DELETE is a no-op; must not error.
- **Required schema-ref field retargeted**: same purge; the entry is now missing a required value → it stays conflicted and the editor must re-select (R35 applies to required and optional alike; the conflict gate handles both). Do **not** special-case required vs optional.
- **Retarget to a schema that doesn't exist**: `update()` already 422s before propagation (`ref_schema` existence check, R9), so the purge only runs for a valid target.
- **Mixed update: retarget + field deletion in one PATCH.** The `deletedFieldIds` bump is schema-wide, so if a retarget coexists with any deleted field, the bump must **not** run (`deletedFieldIds.length > 0 && retargetedFieldIds.length === 0`); otherwise entries that just lost their target would un-conflict. Add a regression test: delete a *different* field and retarget `owner` in the same PATCH, assert the entry's `schema_version` stays unchanged and the public read still excludes it. The purge itself is per-field and unaffected by the bump gate.
- **Retarget to the same `ref_schema`**: `old.ref_schema === new.ref_schema` means the field is not in the retarget set and no purge runs — a no-op; the schema update still proceeds normally (R9 duplicate-label checks etc.). No special handling needed, but document it so an implementer does not "fix" it into purging.
- **Do not bump `schema_version`**: this is the crux. If a future implementer "fixes" the purge to bump like R21, the entries would un-conflict and the public API would serve entries missing a required target — a data-integrity hole. The acceptance criteria below are written to catch that regression.

## Acceptance criteria

1. `pnpm --filter server test` passes in full — including unchanged R21 tests in `schemaService.test.ts` and `schemaRoutes.test.ts` (the deleted-field bump is intact for retarget-free updates).
2. `pnpm --filter server test -- schemaService` passes with the retarget service test (purge + unchanged `schema_version` + `compat_version` = new version + public exclusion/422). The test reads the `owner` field id from the created schema (no hardcoded id). The suite running is the verdict; the specific DB assertions live in that test and fail independently.
3. `pnpm --filter server test -- schemaService` passes with the **mixed-update** regression test: one PATCH deletes an unrelated field and retargets `owner`; the entry's `schema_version` is unchanged (no schema-wide bump despite a deleted field) and `listPublic("car")` still excludes the entry. (The verdict is the suite; the assertion is in that test.)
4. `pnpm --filter server test -- contentService` (or the same schemaService test file) asserts `contentService.listPublic("car")` excludes the retargeted entry and `getPublic("car", <entry id>)` throws `ContentServiceError` with `statusCode === 422` — proving the no-bump keeps it conflicted. Also covers the required-field variant of retarget (same purge, no bump, still conflicted).
5. `pnpm --filter server test -- schemaRoutes` passes with the route-level test: PATCH retargeting the field returns 200, then direct `db` queries assert the `content_refs` purge and unchanged `content.schema_version` (mirroring the existing R21 route test's direct-query assertion style).
6. `pnpm --filter server build` passes (strict-ts compiles the new parameter and tests).

## Verify notes

`pnpm --filter server test` then `pnpm --filter server build`. The dev `data/` DB must be wiped before running `pnpm dev` as per PLAN-24's dev-DB note (the new baseline table). The R35 wording in `SPEC.md` is owned by PLAN-23 (executed first); this plan implements exactly that contract.