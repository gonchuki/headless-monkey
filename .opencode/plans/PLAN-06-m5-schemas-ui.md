# PLAN-06: M5 — Schemas UI (client)

**Originating milestone:** M5
**Depends on:** PLAN-04 (entry endpoints + conflict flag), PLAN-05 (client shell, api client, query provider, ui kit), and transitively PLAN-02 (schema endpoints `GET /api/schemas`, `GET/PATCH/DELETE /api/schemas/:name` — confirm `pnpm --filter server test` passes before starting)

## Goal

Editor lists schemas and builds/edits one through a 3-column sortable grid (`field_label | field_type | required`), with confirmed deletes showing affected counts and a new-entry selector.

## Spec refs (verbatim from milestone M5)

SPEC §2 R30; §2 R22 (confirmations + affected counts); §4 schema routes; §5 optimistic updates/skeletons.

## Files involved

- `client/src/routes/SchemasPage.tsx`, `client/src/routes/SchemaEditorPage.tsx`
- `client/src/hooks/useSchemas.ts`
- `client/src/components/SchemaFieldGrid.tsx`, `client/src/components/SchemaFieldRow.tsx`
- `client/src/components/DeleteConfirmDialog.tsx`
- `client/src/components/NewEntrySelector.tsx`
- `client/src/components/ui/AlertDialog.tsx` (delete confirmations; `<Alert />` is the passive banner, not a confirmation — SPEC §5)

## Approach

1. **List page:** `SchemasPage` — skeletons on first load (R28), optimistic delete, deleted-schema rows render disabled.
2. **Editor page:** `SchemaEditorPage` — schema name (editable only when the schema has no entries yet; read-only otherwise), plus the 3-column sortable grid: `field_label` (text input) | `field_type` (select of text/number/boolean/date/schema-ref) | `required` (checkbox) (R30). Reorder rows (move up/down or drag); when type is `schema-ref`, show a `ref_schema` select.
3. **Save:** `PATCH` with the id-stable `fields` shape from SPEC §4 — existing fields carry their `id`, new fields omit it, absent ids are deleted (R15). On save success, surface the new `version`. Inline 409/422 errors (duplicate labels, invalid ref, cycle) from the server.
4. **Confirmations:** `DeleteConfirmDialog` (built on shadcn `<AlertDialog />`) — deleting a schema warns with the affected content count (R22); deleting a *field* warns with the affected entry count, because that field's data propagates away (R21). Show the server's 409 message when a referenced schema cannot be deleted.
5. **New-entry selector:** `NewEntrySelector` — lists schemas, disabled when zero schemas exist (used by the content flow in PLAN-07; `POST /api/schemas/:name/entries` needs it later).
6. **Hooks:** `useSchemas` encapsulates list/create/update/delete with optimistic updates and query invalidation (R27).

## Edge cases

- Renaming a label keeps the field's `id` and must not lose its stored data (R15) — the PATCH payload preserves `id`.
- Reordering persists `sort_order`; a reorder or rename is non-breaking (compat unchanged per §7).
- Zero-field schema must not be submittable (R8) — disable save until ≥1 field exists.
- The schema editor is read-only (or blocked) when the schema has been deleted concurrently (that state is wired in PLAN-08; at minimum, handle the 404 on save).

## Acceptance criteria

1. `pnpm --filter client build` passes.
2. Manual E2E against a running server: create a schema → it appears in the list; open it → the 3-column grid renders rows for each field.
3. In the editor, rename a field and reorder rows → save shows `version` incremented by 1; verify `compat_version` is unchanged via `GET /api/schemas/:name` (the source of truth), since the editor need only surface `version` (non-breaking per §7).
4. Deleting a schema shows a confirmation with the affected content count; deleting a field shows a confirmation with the affected entry count (R22).
5. The new-entry selector renders disabled when the server has zero schemas.

Milestone M5 verify gate (preserved): `pnpm --filter client build`; manual against running server: create schema → listed; rename/reorder/optional-add → version +1 with compat unchanged; delete warns with correct counts.
