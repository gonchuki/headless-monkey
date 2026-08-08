# PLAN-19 — Skip field deletion confirmation for unsaved fields

## Goal

Remove the confirmation dialog when deleting fields that were created during the current editor session and not yet persisted to the database. When editing an existing schema, only fields that exist in the database should require confirmation before deletion.

## Files involved

- `client/src/routes/SchemaEditorPage.tsx` — modify the `onRemoveField` handler to check field state

## Implementation approach

1. The reducer state already distinguishes new vs. persisted fields by `id` convention:
   - `field.id < 0` → created this session (unsaved, negative IDs from `nextNewId`)
   - `field.id > 0` → persisted in database (positive IDs from API)

2. Modify the handler that responds to field deletion requests (currently `setFieldToDelete`):
   - When a field with `id < 0` is targeted, dispatch `REMOVE_FIELD` immediately — skip the dialog entirely
   - When a field with `id > 0` is targeted, set `fieldToDelete` to open the existing confirmation dialog (current behavior)

3. The handler receives the field's array index. Use `fields[index].id` to check whether the field is new or persisted. The `fields` array comes from the reducer state.

4. Keep the existing `DeleteConfirmDialog` and its flow unchanged for persisted fields — only the new-field path bypasses it.

## Edge cases

- **All fields unsaved (create mode):** Every field has `id < 0`, so no confirmation dialogs appear at all during schema creation — this is the intended behavior.
- **Mixed state (edit mode):** Some fields are persisted (`id > 0`), some are new (`id < 0`). Only persisted fields show confirmation; new fields delete immediately.
- **Field removed before handler runs:** If a field was already deleted between rendering and click, `fields[index]` may be undefined — add a guard to handle this gracefully (return early or use optional chaining).
- **No fields:** Empty schema → no rows rendered → no deletion possible.

## Acceptance criteria

1. `pnpm --filter client build` passes (typecheck + vite build).
2. **Manual verification (cannot be verified by automated tests):** create a new schema, add fields, delete them — no confirmation dialog appears. Edit an existing schema, add a new field, delete it — no dialog. Delete a persisted field (`id > 0`) — confirmation dialog appears with affected entry count.
