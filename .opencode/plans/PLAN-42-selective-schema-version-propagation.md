# PLAN-42: Selective schema_version propagation for breaking changes

## Goal

Fix three bugs where breaking schema changes incorrectly mark all entries as conflicted (or incorrectly resolve conflicts):

1. **Type change on optional field** (e.g., `text → number`): Preview correctly identifies only entries with stored values as affected, but saving marks ALL entries as conflicted.
2. **Optional → required**: Preview correctly identifies only entries with empty/missing values as affected, but saving marks ALL entries as conflicted, including entries that already have a valid value.
3. **Field deletion**: The R21 schema-wide `schema_version` bump resolves conflicts for previously-conflicted entries that should remain conflicted.

The root cause: `compat_version` bumps correctly for breaking changes, but `schema_version` propagation to entries is blanket (`UPDATE content SET schema_version = ? WHERE schema = ?`) rather than selective. Entries that are actually compatible with the new schema shape should have their `schema_version` bumped; entries that are not should stay behind and become conflicted through the existing `schema_version < compat_version` check.

## Files involved

- `server/src/services/schemaService.ts` — `validateAndComputeUpdate()`, `computeAffectedEntries()`, `update()`
- `server/src/repositories/schemaRepo.ts` — `updateSchemaFields()` (R21 block)
- `server/src/types.ts` — `SchemaUpdatePreview` return type, potentially new types for selective propagation
- `server/test/schemaService.test.ts` — existing tests for breaking changes, R21, preview
- `server/test/schemaRoutes.test.ts` — route-level R21 test

## Implementation approach

### 1. Compute affected vs. unaffected entry IDs in the service layer

In `SchemaService.validateAndComputeUpdate()`, after computing `deletedFieldIds` and `retargetedFieldIds`, call a new method (or extend `computeAffectedEntries()` to return both sets) that determines which entries are affected by the incoming changes and which are not.

The affected/unaffected classification depends on the change type, processed in priority order: type change → required change → deletion.

**For type changes** (detected via `isFieldChangeBreaking()` returning `true` due to `typeChanged`):
- Affected: entries that have a stored value for the field (`hasStoredValue(field_id)` checks both `content_rows` and `content_refs`)
- Unaffected: entries with no stored value — empty is valid for any type

**For optional → required** (detected via `isFieldChangeBreaking()` returning `true` due to `requiredChanged` from `false` to `true`):
- Affected: entries with no stored value or an empty string `""`
- Unaffected: entries with a non-empty stored value — they already comply

**For field deletion**:
- Affected: entries that had a stored value for the deleted field
- Unaffected: entries that did not have a stored value
- **Additional constraint**: among the unaffected, exclude entries that were previously conflicted (`schema_version < compat_version` before this update) — preserve their conflict state

**For combined changes in the same PATCH**: an entry is affected if ANY change affects it. Process by priority: first check type changes, then required changes, then deletions. An entry only enters the unaffected set if it survives all applicable checks.

The result is two arrays: `affectedEntryIds` and `unaffectedEntryIds`. These are passed to the repository layer.

### 2. Replace blanket R21 bump with selective bump in the repository

In `SchemaRepository.updateSchemaFields()`, replace the R21 block (the `if (deletedFieldIds.length > 0 && retargetedFieldIds.length === 0)` conditional that runs `UPDATE content SET schema_version = ? WHERE schema = ?`):

With a selective bump that only updates unaffected entries:

```sql
-- New: bump only entries that are compatible with the new schema shape
UPDATE content SET schema_version = ? WHERE id IN (?, ?, ...)
```

The `unaffectedEntryIds` come from the service layer. For entries not in this set, `schema_version` is left unchanged — they fall behind `compat_version` and become conflicted naturally.

**Important**: This change applies to ALL breaking changes, not just field deletions. Currently, the R21 bump only runs when `deletedFieldIds.length > 0`. The new logic runs for any breaking change (type change, optional→required, deletion), since all three need selective propagation. The condition becomes: if `isBreaking` is true, perform selective bump using `unaffectedEntryIds`.

### 3. Wire the affected/unaffected IDs through the call chain

`SchemaService.update()` calls `repo.updateSchemaFields()`. Add `unaffectedEntryIds` as a parameter (or a combined propagation object). The signature of `updateSchemaFields()` changes to accept this information.

For `previewUpdate()`, the existing `computeAffectedEntries()` already computes affected entries. Extend it (or add a sibling) to also return unaffected entry IDs so the same logic is reused between preview and actual update.

### 4. Handle the retarget gate correctly

The current R21 block is gated on `retargetedFieldIds.length === 0` — a mixed PATCH (delete + retarget) must not un-conflict entries that still miss a valid target. The new selective bump preserves this gate: if there are retargets, the unaffected set should exclude entries affected by the retarget (entries holding refs for the retargeted field). This is already handled by `computeAffectedEntries()` flagging those entries as affected.

### 5. Update tests

- `"deleting a field removes content_rows and bumps schema_version"` — rewrite to verify only previously-compatible entries get bumped; previously-conflicted entries stay behind.
- `"sets compat_version = version for text→number (§7)"` — add assertion that only unaffected entries' `schema_version` was bumped.
- `"sets compat_version = version for optional→required (§7)"` — add assertion that entries with valid values get bumped, entries without don't.
- Add tests for combined changes: type change + deletion in same PATCH, optional→required + deletion, etc.
- Preview tests already verify correct affected entry identification — no change needed there, but add unaffected entry assertions.

## Edge cases

- **Empty schema (no entries)**: `unaffectedEntryIds` is empty; the parameterized UPDATE with `IN ()` may fail on SQLite. Handle by skipping the bump when the array is empty.
- **All entries affected**: Same as above — no entries to bump, skip.
- **Non-breaking changes**: No change in behavior — `compat_version` doesn't bump, no propagation needed. The selective bump logic only runs when `isBreaking` is true.
- **Schema with only one entry**: Single-entry edge case; the IN clause works fine with one ID.
- **Field deleted + new required field added in same PATCH**: The new required field has no field ID (it's new), so it can't be matched against stored values. All entries are affected by the new required field. This is a global breaking change — `unaffectedEntryIds` will be empty, which is correct.
- **Type change on a field that's also made required in the same PATCH**: Process type change first (higher priority). Entries with incompatible stored values are affected. Among remaining entries, check required constraint. An entry with no value for a type-changed field is unaffected by the type change but affected by the required change — it stays behind. This is correct: the entry needs to provide a new value in the new type.
- **Entry conflicted from a prior unrelated breaking change**: Its `schema_version` is already behind. The selective bump leaves it alone, preserving its conflict state. Correct.

## Acceptance criteria

1. **Type change on optional field**: Create a schema with an optional text field, create two entries (one with a value, one empty), change the field to number type. Verify: `compat_version` equals new version; the entry with the stored text value has `schema_version` below `compat_version` (conflicted); the entry with no value has `schema_version` equal to the new version (not conflicted). Run `pnpm -r test` in `server/` and confirm existing tests pass plus the new assertions.

2. **Optional → required**: Create a schema with an optional text field, create two entries (one with "Red", one empty), make the field required. Verify: `compat_version` equals new version; the entry with "Red" has `schema_version` bumped to the new version (not conflicted); the empty entry has `schema_version` unchanged (conflicted). Verify via `ContentService.listForSchema()` that only the empty entry returns `conflict: true`.

3. **Field deletion preserves prior conflicts**: Create a schema, make a breaking change that conflicts an entry (e.g., type change), then delete a different field. Verify: the previously-conflicted entry remains conflicted (`schema_version` not bumped); previously-compatible entries have `schema_version` bumped to the new version. Run `server/test/schemaService.test.ts` test `"deleting a field removes content_rows and bumps schema_version"` — it should be rewritten to verify selective bumping.

4. **Combined changes (type change + deletion)**: Create a schema with two optional fields, create three entries (entry A has value for field 1 only, entry B has value for field 2 only, entry C has values for both). Change field 1's type (breaking) and delete field 2. Verify: entry A is affected by the type change on field 1 (conflicted); entry B is affected by the deletion of field 2 (conflicted); entry C is affected by both (conflicted). No entries get `schema_version` bumped.

5. **No regression for non-breaking changes**: Run the full test suite (`pnpm -r test`). Verify that non-breaking changes (number→text, required→optional, label rename, reorder) continue to work without any `schema_version` propagation — `compat_version` stays unchanged and no entries are touched.

6. **Route-level verification**: Run `server/test/schemaRoutes.test.ts` test `"deleting a field bumps compat_version (§7)"` — it should pass with the selective bump logic. The HTTP response and database state should be correct.

7. **Retarget gate preserved**: Run `server/test/schemaService.test.ts` test `"mixed PATCH (delete field + retarget) purges without a schema-wide schema_version bump"` — verify that a mixed PATCH (field deletion + schema-ref retarget) still skips the selective bump for entries affected by the retarget, preserving their conflict state.
