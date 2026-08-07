# PLAN-15 — Schema save validation: non-empty labels, at least one required field, required-by-default

## Goal

The schema create/edit flow currently lets users save invalid schemas:
- A field with an empty or whitespace-only label can be saved (nothing checks label content, client or server).
- A schema with **zero required fields** can be saved.
- New fields added in the editor default to `required: false`, but the product brief (`prompt-starter.md` §46/§67) requires *one or more required fields* before a schema can be saved, and *all fields required by default*.

Fix both sides:
- **Server** (`SchemaService`): `create` and `update` must reject (422) a field whose label is empty or whitespace-only, and a schema with no `required: true` field. `update` must also reject zero total fields to match `create` (currently `PATCH { fields: [] }` deletes every field).
- **Client** (`SchemaEditorPage`): a newly added field is `required: true` by default; the save button is disabled (and submit is guarded) while any label is empty/whitespace-only or no field is required.
- **SPEC.md**: the binding spec (R8) does not currently mandate non-empty labels or ≥1 required field; the requirements live only in `prompt-starter.md`. Amend SPEC.md (extend R8, add a changelog line, reconcile the R32 fallback note) so spec and behavior agree.

## Files involved

- `server/src/services/schemaService.ts` — `SchemaService.create` and `SchemaService.update` validation.
- `server/test/schemaService.test.ts` — service-level negative tests.
- `server/test/schemaRoutes.test.ts` — route-level 422 tests.
- `client/src/routes/SchemaEditorPage.tsx` — `editorReducer`'s `ADD_FIELD` action (defaults `required: false`), `handleSave`, and the `canSave`/disabled computation.
- `client/src/components/SchemaFieldGrid.tsx` — empty-state copy currently says "Add at least one field to save this schema."; update to reflect the required-field rule.
- `SPEC.md` — R8 (Schema model & versioning), R32 (schema-ref select labeling), and the changelog header at the top.

## Implementation approach

### Server (`schemaService.ts`)

In `create(name, fields, createdBy)`:
1. Keep the existing zero-fields check (R8).
2. Add: reject if any field's `label.trim()` is empty → 422. Message like `Field label must be non-empty`.
3. Add: reject if no field has `required === true` → 422. Message like `Schema must have at least one required field`.
4. Place these new checks before the duplicate-label check (the duplicate-label Set uses raw label strings; a whitespace-only label rejected earlier never reaches it).

In `update(name, fields, modifiedBy)`:
5. Add the same three checks the new `create` has: zero total fields → 422; empty/whitespace-only label → 422; no `required: true` field → 422. `update` currently has **none** of these (no zero-fields guard, no duplicate-label guard either — do not add a duplicate-label guard here; that is a separate pre-existing asymmetry and out of scope).
6. **The ≥1-required-field rule breaks existing test fixtures. This is expected and must be handled explicitly.** Both test files create schemas whose single field is `required: false` as *setup* for other rules — those `create` calls will now throw before the rule under test runs. Rewrite every such fixture so it is valid under the new rule while still exercising the rule it was written for. The default remedy is adding a second, required field (keeping the single optional field untouched). Only flip the single field to `required: true` where the original field's optionality is incidental to the rule under test — never for the §7 `optional→required` case, where flipping the only field makes the later update a required→required no-op and breaks the `compat_version === version` assertion.
   - `server/test/schemaService.test.ts`: the cycle tests (self-referential, transitive, mutual) and the §7 compat-table cases ("optional→required", "into boolean", "into date", "into schema-ref", "out of boolean", "ref target change"), plus the R22 delete tests — all create a `car` schema with a single optional field. Add a required field to each.
   - `server/test/schemaRoutes.test.ts`: the same `car` fixtures in the route tests and the `it.each` compat cases listed above, plus the self-referential-cycle route test whose POST body is a single optional field (it would otherwise 422 for the *new* rule, not the cycle it claims to test), and the `it.each` "required→optional" case which PATCHes a single-field schema to all-optional (it would pass for the wrong reason — the update rejected, version never bumped). Rework both to two-field schemas.
   - `server/test/schemaService.test.ts` "keeps compat_version unchanged for required→optional": this updates a single-field schema to a state with **no required field**, which the new update rule rejects. Rework it to start from a two-field schema (one required, one optional), flip the required one to optional, and assert compat_version stays unchanged — the schema must retain at least one required field after the update.
   - Verify the full suite is green after the fixture rewrites; criterion 1 requires it.
7. Existing `update` tests that end with a schema that still has ≥1 required field (e.g. the field-delete propagation tests) must keep passing as-is; only the now-invalid cases (zero fields, all-optional, blank label) become rejected.

### Client (`SchemaEditorPage.tsx`)

7. `ADD_FIELD` reducer action: new field draft becomes `{ id: state.nextNewId, label: "", type: "text", required: true }`.
8. `handleSave`: before the existing zero-fields and empty-name guards, add guards — return early if any field label is empty after `trim()`, or if no field is required. This mirrors the server and keeps the UI honest even if the button were enabled.
9. `canSave` (the expression feeding the save button's `disabled`): add the same two conditions so the button is disabled while the schema is invalid — `state.fields.length === 0 || (isCreate && state.name.trim() === "") || state.fields.some((field) => field.label.trim() === "") || !state.fields.some((field) => field.required) || pending || deleted`.
10. `SchemaFieldGrid.tsx` empty-state copy: adjust to reference the required-field rule (e.g. "Add at least one required field to save this schema.").

### SPEC.md

11. Add a changelog line at the top (matching the existing `v0.x —` lines), e.g. `v0.5 — schema fields must have non-empty labels and every schema needs at least one required field (§2 R8, R30)`. Carry the header date forward: the existing header is `v0.4 — 2026-08-06`; bump to `v0.5` with today's date (2026-08-07).
12. Extend **R8**: add the two new 422 conditions, enumerating the update-side validations explicitly rather than saying "same validations" (the duplicate-label check is intentionally *not* added to `update`, so the spec must not imply it is). E.g. *"POST /api/schemas with zero fields, with an empty/whitespace-only field label, with no required fields, or with duplicate field labels returns 422; with a name that already exists returns 409. PATCH /api/schemas/:name returns 422 with zero fields, with an empty/whitespace-only field label, or with no required fields."*
13. Reconcile **R32**: its fallback ("fallback: first field by sort_order") exists for target schemas that have no required fields. With ≥1 required field now mandatory for new/edited schemas, note that the fallback only applies to pre-existing schemas that predate the rule (existing stored schemas are untouched — this is a forward rule; no migration/backfill). Adjust the wording so the fallback is described as legacy-only rather than the normal path.
14. Do **not** change the DB DDL (`label TEXT NOT NULL` in §4). SQLite `NOT NULL` still permits `""`; enforcement is service-level. Add this note to the plan's Edge cases (the implementer reads the plan, not this note).

## Edge cases

- **Whitespace-only labels of differing widths**: `" "` and `"  "` are distinct strings, so both the current duplicate-label Set and any new check must use `trim()` before comparing emptiness. The blank check is `label.trim() === ""`; the duplicate check stays raw-string (unchanged behavior).
- **Edit flow on existing schemas**: `update` runs the same new checks, so a schema that was somehow saved with all-optional fields can no longer be *edited* into that state again. Existing stored schemas are not mutated; only future saves are constrained. No data migration or backfill runs — a pre-existing all-optional schema keeps its stored fields untouched until someone edits it.
- **DB DDL is unchanged**: `label TEXT NOT NULL` still permits `""` at the SQLite layer (NOT NULL rejects only SQL NULL). The non-empty and ≥1-required rules are enforced purely in `SchemaService`; no migration is involved.
- **Field delete propagation tests**: `server/test/schemaService.test.ts` and `server/test/schemaRoutes.test.ts` delete a field leaving a schema with ≥1 field — those still pass (the remaining field is required in the fixtures). Verify when running the suite.
- **Fixture rewrites are part of this plan**: the ≥1-required rule invalidates existing test *setup* fixtures (single optional field), so the suite will not pass until they are rewritten as described in approach step 6. This is the plan's biggest blast radius — do not ship with red tests and assume they are pre-existing.
- **Client has no test infra**: the client changes are verified by typecheck/build and the grep checks below, not by a client test suite.
- **The required-by-default change must not affect loaded (edit-mode) fields**: only `ADD_FIELD` changes; `LOAD` maps stored `required` values as-is.

## Acceptance criteria

1. `pnpm --filter server test` passes. This requires both the new negative tests and the fixture rewrites of approach step 6 — the all-optional single-field `create` fixtures (cycle tests, §7 compat cases, R22 delete tests) and the `required→optional` compat test (reworked to a two-field schema) must be green. New negative tests in `server/test/schemaService.test.ts`: (a) `create` with a whitespace-only field label → throws `SchemaServiceError`; (b) `create` with no required field → throws; (c) `update` with zero fields → throws; (d) `update` with a whitespace-only label → throws; (e) `update` with no required field → throws. Each test names the rule it exercises (R8 extension).
2. Route-level 422 checks: `server/test/schemaRoutes.test.ts` gains at least one case proving the API surfaces the new errors — e.g. `POST /api/schemas` with a whitespace-only label returns 422, and `PATCH /api/schemas/:name` with `fields: []` returns 422.
3. Client behavior — verifiable by inspection (no client test runner exists): in `client/src/routes/SchemaEditorPage.tsx` the `ADD_FIELD` reducer action creates field drafts with `required: true`; the save button's disabled condition and `handleSave` both include a "no empty/whitespace label" guard and a "at least one required field" guard. `pnpm --filter client build` passes.
4. `SPEC.md` reflects the rules: R8 names the empty-label and ≥1-required-field 422 conditions (create and update), the changelog header gains a `v0.5` line, and R32's fallback is described as applying only to legacy schemas predating the rule. `SPEC.md` header version string is bumped to match the new changelog line.
