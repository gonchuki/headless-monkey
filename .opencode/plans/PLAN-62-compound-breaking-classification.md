# PLAN-62 — Classify compound field changes as breaking

## Goal

A field that changes along two breaking-relevant dimensions in one PATCH must be classified as **breaking**. Today `isFieldChangeBreaking` in `server/src/services/schemaService.ts` early-returns per dimension, so a second dimension is never evaluated:

1. **number/optional → text/required** is misclassified as *non*-breaking (the number→text type change returns non-breaking before the required flip is checked). Consequence: `compat_version` does not bump, so entries missing the now-required field still read as `schema_version >= compat_version` and are served as valid by the public API.
2. **schema-ref A/required → schema-ref B/optional** is misclassified as *non*-breaking (the required→optional flip returns non-breaking before the ref-target change is checked), while the R35 retarget purge still runs — it is computed independently of the breaking classification. Consequence: refs are deleted without a `compat_version` bump, i.e. silent ref-data loss with no conflict (R35 violation).

Both compounds are realistic: the editor UI saves all field edits in one PATCH.

## Files involved

- `server/src/services/schemaService.ts` — `isFieldChangeBreaking` (the classification) and `buildPreviewEntries` (the preview's per-entry affected-field computation, which has the same early-exit pattern — see step 2).
- `server/test/schemaService.test.ts` — tests for both compound cases.

## Approach

1. **Rewrite `isFieldChangeBreaking` to evaluate the three dimensions independently and OR them.** No dimension may short-circuit a *non-breaking* result before the others are checked (returning breaking early is fine — OR semantics). The dimensions, per SPEC R13/R14:
   - **Type:** breaking if the type changed, except number→text (the only non-breaking type change, R13).
   - **Required:** breaking if optional→required; required→optional is not breaking.
   - **Ref:** breaking if both old and new are schema-ref and `ref_schema` changed.
   Single-dimension outcomes must be byte-for-byte unchanged — the §7 compat-table tests in `server/test/schemaService.test.ts` and `server/test/schemaRoutes.test.ts` are the regression guard.
2. **Align `buildPreviewEntries` with SPEC R36.** Its kept-field loop is a sequential if/continue chain with the same early-exit flaw: the number→text case `continue`s before the optional→required clause is evaluated. After step 1, compound case 1 becomes breaking, and the preview must list the entries that will be conflicted (entries missing the now-required value) — but the number→text early-exit suppresses them, so the preview would report `breaking: true` while omitting exactly those entries, and the client's save-confirm dialog would under-report. SPEC R36 already specifies the correct per-dimension behavior; make the loop evaluate, per kept field, **independently**:
   - type clause: any type change *other than* number→text flags the entry if it has a stored value for the field (row or ref);
   - retarget clause: a retargeted field flags the entry if it holds a ref;
   - optional→required clause: flags the entry if it has no stored value or a stored text `""`.
   The deleted-field branch, the new-required-field (`hasNewRequiredField`) path, and label computation are untouched. All existing `previewUpdate` tests (single-dimension cases) must keep passing unchanged.
3. **Add tests in `server/test/schemaService.test.ts`** for both compound cases (follow the file's conventions — real services on a fresh db, field ids looked up from returned `SchemaEntry`s by label, direct `db` queries for `schema_version`/`content_refs`, `contentService.listForSchema`/`listPublic`/`getPublic` for conflict assertions):
   - **Compound case 1 (number/optional → text/required):** create `car` with `make` (text, required) and `year` (number, optional). Create entry A with a number value for `year`, entry B without. PATCH `car` keeping `make` and changing `year` to text/required. Assert: returned schema has `version === 2` and `compat_version === 2` (breaking — before the fix it was `1`); entry A is bumped to version 2 and not conflicted (number coerces to text per R17); entry B keeps its pre-update `schema_version`, is conflicted in `listForSchema`, is excluded from `listPublic`, and 422s on `getPublic`. Then assert `previewUpdate` with the same payload returns `breaking: true` and an `affectedEntries` that contains entry B with the `year` field id and does **not** contain entry A.
   - **Compound case 2 (schema-ref A/required → schema-ref B/optional):** create `person` and `company` schemas; create `car` with `make` (text, required) and `owner` (schema-ref → `person`, **required**). Create a person entry and a car entry referencing it. Verify the `content_refs` row exists. PATCH `car` changing `owner` to schema-ref → `company`, **optional**. Assert: returned schema has `compat_version === version` (breaking — before the fix it was unchanged); the `content_refs` row for the owner field is purged; the car entry's `schema_version` is unchanged (R35 no-bump gate) and it is now conflicted — excluded from `listPublic`, 422 on `getPublic`. Then assert `previewUpdate` with the same payload returns `breaking: true` and an `affectedEntries` containing the car entry with the owner field id.

## Edge cases

- **The third compound is fixed for free.** schema-ref A/optional → schema-ref B/required (retarget + optional→required) is also misclassified today and is corrected by the same change; no separate test is required.
- **Do not touch `computeUnaffectedEntryIds` / `validateEntryAgainstFields`.** The validation-based bump already handles compound changes correctly once the classification is right: `compat_version` bumps, entries missing a now-required value fail validation and stay conflicted, and entries with coercible values are bumped. The misclassification was the only defect in the data path.
- **The R35 no-bump gate is unchanged.** When a retarget is present, no entry is bumped (repo-level gate on `retargetedFieldIds`); after the fix every pre-existing entry of the schema reads as conflicted, which is the intended R35 outcome.
- **Preview label convention** (first required field by sort_order, fallback `Entry #<id>`) is untouched.
- The existing single-dimension tests — the §7 compat table in both `schemaService.test.ts` and `schemaRoutes.test.ts`, and every test in the `previewUpdate` describe block — are the regression guard for step 1/step 2 equivalence on non-compound inputs. They must pass unmodified.

## Acceptance criteria

1. `pnpm --filter server test` passes — the full server suite, including both new compound tests and all pre-existing §7/preview/R35 tests, with no pre-existing test modified.
2. `pnpm --filter server typecheck` passes.
3. Mutation checks (manual): (a) revert `isFieldChangeBreaking` to the early-return form — the two new compound tests fail on their `compat_version`/`breaking` assertions; (b) restore `buildPreviewEntries` to the sequential if/continue chain — the compound case 1 test fails on its `affectedEntries` assertion. Each reversion must be caught by the new tests; then restore both fixes and confirm the suite is green.
