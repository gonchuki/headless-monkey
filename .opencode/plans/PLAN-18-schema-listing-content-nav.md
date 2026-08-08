# PLAN-18 — Schema listing shortcut to content view

## Goal

Add a "View entries" navigation button to each schema row in the schema listing (`/schemas`), so users can navigate directly to `/content/:schema` without having to go through the sidebar or content listing. The button should appear first in the action group, before Edit and Delete.

## Files involved

- `client/src/routes/SchemasPage.tsx` — add the new button in the existing button group within the `schemas.map` callback

## Implementation approach

1. Add a navigation button as the first child of the button group inside each schema row's `<li>` in the `schemas.map` callback. The button should navigate to `/content/:schema` using the same imperative `navigate()` pattern already used for Edit button navigation.
2. The button must be visually consistent with the existing Edit/Delete action buttons (same variant, size, icon-only shape). It must respect the `deleted` state guard — disabled when the schema has been deleted via the realtime stream.
3. Use an icon from `@phosphor-icons/react` that conveys forward navigation. Import it alongside existing icon imports in the file.
4. No other files need changes; no route modifications required (the `/content/:schema` route already exists).

## Edge cases

- **Deleted schema:** When `deleted` is true, the row has `pointer-events-none opacity-50`, so the button will be disabled and non-interactive — same as Edit/Delete.
- **Schema name encoding:** Use URL encoding to handle special characters in schema names, matching the existing navigation pattern.
- **Empty schema list:** No schemas → no rows rendered → no buttons needed.

## Acceptance criteria

1. `pnpm --filter client build` passes (typecheck + vite build).
2. **Manual verification (cannot be verified by automated tests):** click the View entries button on a schema row → navigates to `/content/:schema` with that schema's entries displayed. The button appears before Edit and Delete in each row's action group.
