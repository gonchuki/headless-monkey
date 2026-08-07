# PLAN-09 — Listings: explicit edit button, inert row clicks

## Goal

Make the schema listing (SchemasPage) and the content listing (ContentPage) consistent: the edit feature is reached only through an explicit edit button per row, and clicking anywhere else on a row has no effect.

Today:
- SchemasPage rows have no edit button; clicking the row navigates to the schema editor.
- ContentPage rows already have a `PencilSimple` edit button, but clicking the row also navigates to the editor.

Both listings must end up with an edit button as the sole entry point to the editor, and row clicks must be inert.

## Files involved

- `client/src/routes/SchemasPage.tsx`
- `client/src/routes/ContentPage.tsx`

## Implementation approach

### 1. SchemasPage — add an edit button, demote the row click

- The row's primary content element (currently a `<button>` that navigates to `/schemas/:name`) must become non-interactive. Preserve the truncation behavior of the schema name so long names still truncate correctly.
- Add an edit affordance next to the delete button. Match the action-group pattern already established in `ContentPage.tsx` — use the same icon, variant, size, and disabled semantics (`deleted`). The edit button navigates to `/schemas/${encodeURIComponent(schema.name)}`.

### 2. ContentPage — demote the row click

- The row's primary content element (currently a `<button>` that navigates to `/content/:schema/:id`) must become non-interactive. Preserve the truncation behavior of the entry label.
- The existing edit button and delete button are already correct; do not change them. Do not change the Conflicted badge.

### 3. No other changes

- Navigation targets and `encodeURIComponent` usage stay as they are.
- No server changes, no route-table changes.

## Edge cases

- **No nested interactive elements:** the edit/delete buttons must remain siblings of the row-content element (they already are) — do not wrap the whole row in a button, which would create invalid nested buttons.
- **Truncation:** the `min-w-0` on the new non-interactive element is required for `truncate` to work; keep it.
- **Disabled/deleted states:** the new edit button on SchemasPage must be `disabled={deleted}` like the delete button; on ContentPage the edit button already carries `disabled={selectedDeleted}`. The `pointer-events-none` on the `<li>` (deleted case) stays.
- **Accessibility:** the edit button is the keyboard-accessible path into the editor; keep the `aria-label`. Do not re-add row-level `role="button"`/`onKeyDown` handlers.
- **Keyboard/screen-reader:** row text remains visible and readable; only its interactivity is removed.

## Acceptance criteria

1. `pnpm --filter client build` passes (the `build` script runs `tsc` and then `vite build`, so it covers type checking as well).
2. Manual (no client test infra exists): run `pnpm -r dev`, log in as editor, open `/schemas` and `/content`; clicking anywhere on a row's title area does not navigate to the editor.
3. Manual (no client test infra exists): clicking the pencil edit button on a schema row navigates to `/schemas/:name`, and clicking the pencil edit button on an entry row navigates to `/content/:schema/:id`.

## Scope note

No files outside the two listing routes are touched. The editors themselves are unchanged here.
