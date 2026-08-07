# PLAN-11 — Save/create returns to the listing

## Goal

After saving or creating a schema, return the user to the `/schemas` listing. After saving or creating an entry, return the user to the `/content` listing. Currently:

- Schema create (`SchemaEditorPage`, route `/schemas/new`) navigates into the new schema's editor (`/schemas/:name`).
- Schema update (`SchemaEditorPage`) stays on the editor.
- Entry create (`NewContentPage`, route `/content/new`) navigates into the new entry's editor (`/content/:schema/:id`).
- Entry update (`ContentEditorPage`) stays on the editor.

All four flows must land back on their listing after a successful save.

**Accepted limitation (decision made in planning):** `/content` lists the first schema by default; returning there does not deep-link to the schema of the entry just saved. No per-schema listing route is added.

## Files involved

- `client/src/routes/SchemaEditorPage.tsx`
- `client/src/routes/NewContentPage.tsx`
- `client/src/routes/ContentEditorPage.tsx`

## Implementation approach

Follow the existing post-save convention used everywhere in the codebase: `toast.add(...)` first, then `navigate(target, { replace: true })`.

### 1. `SchemaEditorPage` — `handleSave`

- **Create branch** (`create.mutate` `onSuccess`): after the `"Schema created"` toast, navigate to `/schemas` (currently `/schemas/${encodeURIComponent(schema.name)}`). The `schema` argument of `onSuccess` is then unused.
- **Update branch** (`update.mutate` `onSuccess`): keep the `"Schema saved"` toast (including the `Version ${schema.version}` description), then navigate to `/schemas`. The `dispatch({ type: "LOAD", ... })` call re-syncs editor state for a page that is about to unmount; it is no longer needed and may be removed.
- `replace: true` is used so the browser Back button does not return to the just-saved editor.

### 2. `NewContentPage` — `handleSubmit`

- In `create.mutate` `onSuccess`: after the `"Entry created"` toast, navigate to `/content` (currently `/content/${encodeURIComponent(selected)}/${entry.id}`). The `entry` argument of `onSuccess` is then unused; `selected` (the schema) is already in scope and stays as-is.
- `replace: true` stays.

### 3. `ContentEditorPage` — `handleSubmit`

- In `update.mutate` `onSuccess`: after the `"Entry saved"` toast, navigate to `/content` with `replace: true`. Nothing else changes.

### 4. No other changes

- The editors' back buttons (which already navigate to the listings) are unchanged.
- No route-table changes in `client/src/main.tsx`, no server changes.

## Edge cases

- **Query freshness on return:** no refetch wiring is needed. `useEntries` and `useSchemas` already invalidate their listing queries `onSettled`, so the listing is fresh when the user lands back on it.
- **No unsaved-changes guard exists** anywhere in the codebase (no `useBlocker`, no dirty tracking), so navigation after save conflicts with nothing; do not add one.
- **Toast ordering:** keep the toast before the navigation, matching the existing convention (`NewContentPage` and `SchemaEditorPage` already do this).
- **`replace: true`** must be preserved so Back does not loop back into the editor.

## Acceptance criteria

1. `pnpm --filter client build` passes (the `build` script runs `tsc` and then `vite build`, so it covers type checking as well).
2. Grep check: in `SchemaEditorPage.tsx`, `NewContentPage.tsx`, and `ContentEditorPage.tsx` the success-navigation targets are exactly `/schemas` and `/content` — i.e. no `onSuccess` handler navigates to a `/:name` or `/:schema/:id` suffix anymore.
3. Manual (no client test infra exists): run `pnpm -r dev`, log in as editor:
   - create a schema → lands on `/schemas`;
   - open a schema and save changes → lands on `/schemas`;
   - create an entry → lands on `/content`;
   - open an entry and save changes → lands on `/content`.
