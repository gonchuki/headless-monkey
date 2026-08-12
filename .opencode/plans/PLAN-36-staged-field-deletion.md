# PLAN-36 — Staged field deletion in the schema editor

**Depends on:** PLAN-33 (`schema-patch-preview`) — the R36 dry-run endpoint `PATCH /api/schemas/:name?preview=true` — and PLAN-35 (`breaking-save-confirm-dialog`) — the `SchemaSaveConfirmDialog` component. Both are lower-index plans and already committed; resolve the dependency at runtime: the preview endpoint and the dialog component exist when this plan is executed. This plan only reshapes the client-side delete interaction; it does not touch the server.

## Goal

Replace the per-field "Delete field?" confirmation dialog in the schema editor with a staged model:

1. Clicking the Trash on an **existing** field no longer opens any dialog. The field becomes *tombstoned* in the draft: its row renders disabled/dimmed, all its controls are inert, and the row offers a **Restore** action (deletion is undone until "Save changes" is pressed).
2. A single summary `<Alert>` (destructive variant) appears above the field grid while any tombstone exists. It names the pending deletions and carries one **"View affected entries"** action that opens an overlay listing the schema's entries.
3. There is exactly one confirmation dialog in the whole flow, and it appears **only** on "Save changes" **iff** the pending change is destructive (breaking per SPEC R14/R37). Non-breaking saves still apply immediately with no dialog.
4. Clicking the Trash on a **new** (unsaved) field continues to remove the row immediately — no tombstone, no alert, no effect on entries.

Deleting a field is a breaking change (SPEC R14), so a tombstoned field always triggers the existing save-confirmation. The per-field entry count shown in the summary is the schema's **total entry count** (deliberate choice: no new preview requests while editing; the precise per-entry affected list remains available at save time in `SchemaSaveConfirmDialog`).

## Files involved

- `client/src/routes/SchemaEditorPage.tsx` — reducer, delete handler, save payload, validation, banner wiring; removes `DeleteConfirmDialog` usage.
- `client/src/hooks/useSchemas.ts` — `SchemaDraft` gains `deleted?: boolean`.
- `client/src/components/SchemaFieldRow.tsx` — tombstoned-row rendering + Restore action.
- `client/src/components/SchemaFieldGrid.tsx` — threads the new `deleted`/`onRestore` props.
- `client/src/components/PendingDeletionBanner.tsx` — **new** component: summary `Alert` + overlay `Dialog` listing entries.
- Unchanged but context: `client/src/components/DeleteConfirmDialog.tsx` (kept; still used by `SchemasPage` and `ContentPage` for real deletes), `client/src/hooks/useEntries.ts` (`listQuery` supplies the overlay's rows), `client/src/components/ui/alert.tsx` (`AlertAction` slot), `client/src/components/ui/dialog.tsx`, `client/src/lib/api.ts` (`SchemaEntryRow`/`ContentListEntry`).

## Implementation approach

Ordered steps; each step is a unit of work, not a prescribed edit.

### 1. Draft model: add tombstone state

In `client/src/hooks/useSchemas.ts`, extend `SchemaDraft` with an optional `deleted?: boolean` flag.

In `client/src/routes/SchemaEditorPage.tsx`, extend `EditorAction` and `editorReducer`:

- `MARK_FIELD_DELETED { index }` → set that field's `deleted: true`.
- `RESTORE_FIELD { index }` → set `deleted: false`.
- Keep `REMOVE_FIELD` as-is for discarded new fields.

The `LOAD` action must produce fields without `deleted` set (persisted fields arrive active); `ADD_FIELD` likewise adds active fields. No other action needs to know about the flag.

### 2. Delete handler: no dialog

Replace the current per-field flow in `SchemaEditorPage.tsx`:

- New field (`id != null && id < 0`): unchanged — `REMOVE_FIELD` immediately.
- Existing field: dispatch `MARK_FIELD_DELETED` — never open a dialog.
- Delete the `fieldToDelete` state, the `useSchemaEntryCount` call that gated on it, and the entire `<DeleteConfirmDialog>` element together with its import. The component file itself stays (other routes need it).

### 3. Save payload: exclude tombstones

In `toPayload`, filter out fields with `deleted: true` **before** the existing id/mapping logic. This is the correctness-critical step: if a tombstoned field kept its `id` in the PATCH body, the server would treat it as preserved and the deletion would silently not happen.

### 4. Validation against the active field set

`handleSave` early-return guards and the `canSave` computation must evaluate `activeFields = state.fields.filter((f) => !f.deleted)` instead of `state.fields`:

- zero active fields → cannot save
- any active field with a blank label → cannot save
- no active required field → cannot save

Purpose: a tombstoned field must not satisfy the "has a required field" rule, otherwise Save stays enabled and the server rejects with 422. When the tombstones would leave the schema invalid, Save is disabled and the banner's copy should say why (e.g. "A schema needs at least one required field — restore a field to save."). The auto-proceed `useLayoutEffect` and `handleSaveConfirm` keep using the preview as today; they consume the already-filtered payload.

### 5. Field row + grid: tombstoned rendering

`client/src/components/SchemaFieldRow.tsx`:

- Accept `deleted?: boolean` and `onRestore?: (index: number) => void` props.
- When `deleted`: render the row dimmed (e.g. reduced opacity + line-through on the label), disable every control (type select, label input, required checkbox, both move buttons), and replace the Trash button with a **Restore** button (label something like "Undo delete"; `onRestore(index)`).
- All existing visual/semantic structure stays the same for active rows.

`client/src/components/SchemaFieldGrid.tsx`: accept `deleted`/`onRestore` threading (e.g. pass `field.deleted` and a handler per row) and forward to each `SchemaFieldRow`.

### 6. Summary banner + affected-entries overlay

Create `client/src/components/PendingDeletionBanner.tsx` with one exported component holding both the alert and its overlay:

- Renders a destructive `<Alert>` when there is at least one tombstoned field. Copy names the pending deletions (labels, "Unnamed" fallback) and states they apply on save, plus the total entry count (e.g. "This schema has N entries.").
- `<AlertAction>` holds a button "View affected entries" that opens a `<Dialog>` overlay. The overlay lists the schema's entries rendered as `Entry #<id>` (rows from `useEntries(...).listQuery.data`), with an explicit empty state when there are no entries ("No entries in this schema yet.").
- Reuses the existing entry-list scroll/overflow styling pattern already present in `SchemaSaveConfirmDialog` (`max-h-60 overflow-auto`).

Wire it into `SchemaEditorPage.tsx` above `<SchemaFieldGrid>`:

- Render only when `!isCreate && !deleted` (realtime-deleted schema) and at least one tombstone exists.
- Feed it `entryCount` and `entries` from the page's queries. The page already has `useSchemaEntryCount` (kept — `SchemasPage` uses it too, and it shares the `queryKeys.entries` cache with `useEntries`), and should add `useEntries(name).listQuery` for the overlay rows. Both queries share one cache key, so no duplicate fetches.

### 7. Verification

Run the acceptance criteria below; fix any failure before finishing.

## Edge cases

- **Silent-keep bug (critical):** if `toPayload` leaks a tombstoned field's `id`, the server preserves it — the user sees a phantom save. The filter in step 3 is mandatory, not cosmetic.
- **Last required field tombstoned:** Save must disable (step 4). The banner should surface the reason so the user knows Restore unblocks saving.
- **All fields tombstoned:** same rule — zero active fields disables Save; rows remain visible and restorable, which is the intended recovery path.
- **Schema with zero entries:** the banner still appears for tombstones, but the overlay shows the empty state; no per-entry impact, and save still confirms once (deleting a field is breaking by definition).
- **Realtime `deleted` state:** when the schema was deleted elsewhere, the editor is already fully disabled; the banner is suppressed so it doesn't suggest actions on an unsavable schema.
- **Tombstoned rows must not be reorderable** (movement is meaningless for fields absent from the payload) — disable the move buttons (step 5).
- **Duplicate labels across active and tombstoned fields:** harmless — correctness is defined by the payload, which excludes tombstones before the server's duplicate-label check.
- **Mixed draft (tombstone + benign edit):** preview `breaking` is true because of the deletion, so the single save dialog appears once and lists all affected entries; the benign edit rides along. This satisfies "one dialog iff destructive".
- **Restore:** restoring a field re-enables its row and removes the banner when no tombstones remain; no server interaction occurs on restore.

## Acceptance criteria

1. `pnpm --filter client build` exits 0 (runs `tsc` + `vite build`).
2. No reference to the per-field confirmation remains in the editor: `grep -n "DeleteConfirmDialog" client/src/routes/SchemaEditorPage.tsx` returns no matches, while `DeleteConfirmDialog` still appears in `client/src/routes/ContentPage.tsx`, `client/src/routes/SchemasPage.tsx`, and `client/src/components/DeleteConfirmDialog.tsx` (component retained).
3. Manual — deleting a saved field: in the schema editor of a schema that has at least one entry, click the Trash on a saved field. No dialog opens; the row immediately renders disabled/dimmed with a Restore control; a summary destructive `<Alert>` appears above the field grid naming the field.
4. Manual — undo: click Restore on the tombstoned row. The row re-enables and the summary alert disappears when no tombstones remain.
5. Manual — single gate semantics: (a) with a tombstone present, click "Save changes": exactly one confirmation dialog appears (the save-confirm listing affected entries); canceling leaves the tombstone in place. (b) Edit only a label (no tombstones) and save: no dialog appears and the save applies.
6. Manual — persistence: with a tombstone present, navigate through the save-confirm and save. Reload the schema: the field is gone and the entry editor no longer shows its value.
7. Manual — payload correctness: in the Network tab, the `PATCH /api/schemas/:name` body sent by Save contains no entry for the tombstoned field's `id`. (This guards the silent-keep bug.)

Criteria 3–7 are manual because the client package has no test infrastructure (`client/package.json` exposes only `dev`/`build`/`typecheck` scripts) — state that in the PR description so reviewers know the manual pass is the behavioral gate.