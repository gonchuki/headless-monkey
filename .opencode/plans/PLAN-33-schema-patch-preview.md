# PLAN-33 — Schema-update impact preview via `PATCH ?preview=true`

## Goal

A schema update can silently invalidate existing entries (retype `text→number`, `optional→required`, `ref_schema` retarget, deleted field, added required field). Editors currently get no warning before the PATCH applies. Add a dry-run of `PATCH /api/schemas/:name`: when the same route receives `?preview=true` with the same `{ fields }` body as a real PATCH, it returns what the update *would* do — `{ breaking, version, compatVersion, affectedEntries: [{ id, affectedFieldIds }] }` — **without writing anything** and **without emitting an SSE event**.

Deliberate design choice (user-approved): the preview is the same route and same payload as the apply, gated by a query flag, so the preview always reflects exactly what a real PATCH would do — including the same 404 unknown-schema and 422 validation outcomes (zero fields, blank label, no required field, duplicate label, invalid type, bad/nonexistent `ref_schema`, circular reference). A payload the preview blesses is a payload PATCH will accept; a payload PATCH rejects is rejected by the preview too.

This plan is the server half of the "communicate the risk / surface the affected entries / preview before applying" flow. The client confirmation dialog that consumes this endpoint is **PLAN-35**; this plan does not touch client code.

## Dependency

None. Stands alone as a server change.

## Files involved

- `server/src/services/schemaService.ts` — extract the validation + compat/prep computation out of `update()` into a shared private helper; add public `previewUpdate(name, fields)`.
- `server/src/services/fieldValidation.ts` — NEW shared module: scalar per-type validity + the `number→text` coercion rule, extracted so `ContentService` and the preview use the same rules (no drift).
- `server/src/services/contentService.ts` — delegate its scalar validation/coercion to the new module; behavior must stay byte-for-byte identical (existing tests are the guard).
- `server/src/routes/schemas.ts` — branch the `PATCH /:name` handler on `req.query.preview === "true"`.
- `server/src/types.ts` — add preview response types.
- `server/test/schemaService.test.ts` — service-level preview tests.
- `server/test/schemaRoutes.test.ts` — route-level preview tests.

## Implementation approach

1. **Factor the read-only part of `SchemaService.update()` into a private helper.** Move everything in `update()` up to (but excluding) the `this.repo.updateSchemaFields(...)` call — schema fetch/404, R8/R9/R10 validation, `newVersion`, `computeBreakingChange`, `compatVersion`, `deletedFieldIds`, `retargetedFieldIds` — into `private validateAndComputeUpdate(name, fields)` returning a typed object containing `{ existing, newVersion, isBreaking, compatVersion, deletedFieldIds, retargetedFieldIds }`. `update()` then becomes: call the helper, call `updateSchemaFields`, return `getSchema(name)`. Behavior must be byte-for-byte identical; the existing R21/R35 tests are the regression guard.

2. **Add `previewUpdate(name, fields): SchemaUpdatePreview`.** It calls the same private helper (so validation, breaking detection, and the deleted/retargeted id sets are guaranteed identical to `update()`), then computes the per-entry impact — and never calls `updateSchemaFields`. This is the one method the route calls for `?preview=true`.

3. **Shared scalar validation module.** Create `server/src/services/fieldValidation.ts` exporting the scalar type-validity predicate (text: `typeof value === "string"` and, when required, non-empty; number: finite number; boolean: boolean; date: `YYYY-MM-DD` string) and the single coercion rule (only `number→text`). Refactor `ContentService.isValidValue`/`coerce` to delegate to these. `ContentService` keeps its schema-ref branch local (it needs `entryExistsInSchema`); the preview handles schema-ref values locally per the rules below. For `date`, preserve the full `isValidDateString` round-trip predicate (regex + calendar round-trip) exactly as `ContentService` implements it — a loose "looks like a date" check would drift. `ContentService`'s editor write/read behavior must not change — the full `contentService.test.ts` suite passing is the proof.

4. **Affected-field rules (the correctness core).** In `previewUpdate`, load the schema's entries via `ContentRepository.listEntries(name)` (construct a `ContentRepository` in `SchemaService` like `ContentService` does with `SchemaRepository`). For each entry, derive a field's stored value by checking **both** tables independently — `entry.rows` (scalar, `value` JSON-parsed) and `entry.refs` (schema-ref target) — because stale storage survives type changes: a previous `schema-ref→text` flip leaves a stale `content_refs` row and a previous `text→schema-ref` flip leaves a stale `content_rows` row (only retargets purge refs; only field deletion cascades rows). Reading only one table would miss affected entries. Then a field counts as affected for that entry exactly when:
   - **Field deleted** (existing id absent from incoming id set): the entry has a row or ref for that id.
   - **New field with no id, required**: always affected (the entry cannot have a value for a brand-new field).
   - **New field with no id, optional**: never affected.
   - **Kept field, `number→text`**: never affected (lossless coercion, R13/R17).
   - **Kept field, type and `ref_schema` unchanged, `required→optional` or required unchanged**: never affected.
   - **Kept field, type and `ref_schema` unchanged, `optional→required`**: affected iff the entry has no stored value for the field, or the stored value is invalid under the new field's required semantics (the only such case: a text value of `""`).
   - **Kept field, type changed to anything other than `number→text`**: affected iff the entry has any stored value (row or ref) for the field.
   - **Kept field, schema-ref → schema-ref with a different `ref_schema` (retarget)**: affected iff the entry has a stored ref for the field (the real PATCH purges it unconditionally — R35 — regardless of whether the old target happens to exist in the new schema).
   - **Anything else (label rename, reorder)**: never affected.
   - Collect per-entry the affected field ids; omit entries with an empty list. The `deletedFieldIds`/`retargetedFieldIds` computed by the shared helper feed these rules directly — do not recompute them.
   - Each affected entry also carries a `label` for display (the dialog in PLAN-35 renders it): the stored value of the schema's **first required field by `sort_order`** (the same listing convention the client uses in `schemaLabelField`/`entryLabel`), or `Entry #<id>` when that label field has no stored value. Compare against the **existing** fields — the label is the currently-stored value being displayed, and it may itself be an affected field (fine for display).

5. **Preview response shape** (add to `server/src/types.ts`):
   ```ts
   export interface SchemaUpdatePreviewEntry {
     id: number;
     label: string; // first-required-field value by sort_order (listing convention), else `Entry #<id>`
     affectedFieldIds: number[];
   }
   export interface SchemaUpdatePreview {
     breaking: boolean;
     version: number;        // the version the PATCH would produce
     compatVersion: number;  // the compat_version the PATCH would produce
     affectedEntries: SchemaUpdatePreviewEntry[];
   }
   ```
   `affectedEntries.length` is the "N affected entries" count the client dialog shows.

6. **Route branch.** In the `PATCH /:name` handler of `createSchemasRouter`, before the existing update path: if `req.query.preview === "true"`, call `schemaService.previewUpdate(name, req.body.fields)` and `return res.json(preview)`. No SSE event (the event is only for applied changes), no `getSchema` pre-fetch for the changes diff, and no write. Everything else about the handler stays identical.

7. **Tests.** Mirror the repo's existing style (per-test in-memory DB, direct `db.prepare` assertions).
   - Service tests (`schemaService.test.ts`, a `previewUpdate` describe): build entries with raw SQL like the existing R21 tests do, then assert the per-change-kind rules (text→number flags entries with stored values; number→text flags none and `breaking=false`; optional→required flags only entries missing the value; new required field flags every entry; ref retarget flags only entries with stored refs; deleted field flags only entries that had the value) and — critically — that `previewUpdate` performs **no write**: `schemas.version`, `schemas.compat_version`, `schema_fields`, `content`, `content_rows`, and `content_refs` are unchanged after the call, and that a follow-up real `update()` still applies the change.
   - Route tests (`schemaRoutes.test.ts`): `PATCH /api/schemas/:name?preview=true` returns 200 with the correct shape and leaves the DB untouched (direct `db` queries); the same payload without the flag is a normal applied PATCH (regression); unknown schema → 404; invalid payloads (zero fields, blank label, no required field, duplicate label, circular reference) → 422 with the same status as a real PATCH.

## Edge cases

- **The no-write invariant is the point of this plan.** If `previewUpdate` ever touches `updateSchemaFields` (or any write), the feature becomes a double-apply hazard. The acceptance criteria below are written to catch that regression.
- **Unknown field ids in the payload**: a real PATCH silently drops them (no 422 — the update simply doesn't match them). The preview shares the same helper, so it must mirror that behavior, not invent a new warning.
- **Entries already conflicted before this change**: report them as affected if this change touches their fields; do not special-case pre-existing conflict. The client dialog counts "entries whose data this change disturbs", which is exactly what these rules compute.
- **Schema with zero entries**: `affectedEntries` is `[]`, `breaking` still reflects the schema change itself (e.g. a retype is still breaking even with no data). The dialog shows "0 entries affected".
- **Mixed PATCH (delete field + retarget in one payload)**: the shared helper computes both sets the same way `update()` does, so the preview reflects the R21 exception (entries stay conflicted) without ever reimplementing the version-bump gating in `updateSchemaFields`.
- **Optional retargeted ref field**: an entry with no stored ref for it is not affected — it never had a target to lose. Only entries holding that ref are flagged.
- **`details` on service errors is never serialized** — the preview's structured data lives in the 200 body, not in error payloads.

## Acceptance criteria

1. `pnpm --filter server test` passes in full. This single suite gate covers every new behavior (each assertion fails independently within the suite, and any one failing fails this criterion):
   - the unchanged `contentService.test.ts` suite stays green — proving the `fieldValidation.ts` extraction changed no `ContentService` read/write behavior;
   - the new `previewUpdate` describe in `schemaService.test.ts` passes — the per-change-kind affected rules above, the `label` computation (the label-field value when present, the `Entry #<id>` fallback when the label field has no stored value), plus the DB-unchanged assertion: direct `db` checks that `schemas.version`, `schemas.compat_version`, `schema_fields`, `content`, `content_rows`, and `content_refs` are identical before/after the preview call, followed by a real `update()` that still applies;
   - the new preview route tests in `schemaRoutes.test.ts` pass — `PATCH /api/schemas/:name?preview=true` returns 200 with the `SchemaUpdatePreview` shape and leaves the DB untouched; the identical request without the flag applies the change; unknown schema returns 404; invalid payloads return the same 422s as a real PATCH.
   For failure localization, `pnpm --filter server test -- schemaService` and `pnpm --filter server test -- schemaRoutes` are diagnostic subspans — they are not separate acceptance criteria.
2. `pnpm --filter server build` passes (strict TS compiles the new types, module, and tests).

## Verify notes

`pnpm --filter server test` then `pnpm --filter server build`. The dev `data/` DB needs no migration — this plan adds no DDL. Plan 35 consumes the new endpoint and its response type via the client `SchemaUpdatePreview` type; that wiring lives in PLAN-35.