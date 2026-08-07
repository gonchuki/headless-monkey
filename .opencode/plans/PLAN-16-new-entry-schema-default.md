# PLAN-16 — New-entry defaults to the active schema filter; `/content` shows an intermediate selector-only state

## Goal

The "New entry" button in the content listing (`client/src/routes/ContentPage.tsx`) navigates to `/content/new` passing only the origin list URL (`state.list`). The create page (`client/src/routes/NewContentPage.tsx`) then defaults to the *first* schema in the list (`schemas[0]`) regardless of where the user came from — both in the initializer `const selected = schemaName ?? schemas[0]?.name ?? null;` and in a `useEffect` that force-sets the first schema when no name is chosen.

This was specified in `prompt-starter.md` but did not survive into SPEC.md or the plans. Required behavior:
- If the user arrived from a filtered view (`/content/:schema`), the create form must default to **that schema**.
- If the user arrived from the root `/content` (the "All schemas" view), they must get an **intermediate state**: the schema selector is shown, but no schema-guided form fields render until they pick a schema.

## Files involved

- `client/src/routes/ContentPage.tsx` — the "New entry" button; must pass the current selection (`selected`, which is `null` in the All view) alongside the existing `list` state.
- `client/src/routes/NewContentPage.tsx` — consume the passed schema; remove both `schemas[0]` defaulting sites; render the selector-only intermediate state when no schema is chosen.
- `client/src/components/NewEntrySelector.tsx` — already supports a `null` value with a "Select a schema" placeholder; no structural change required (verify only).
- `client/src/components/DynamicEntryForm.tsx` — already gated behind `selected != null` in `NewContentPage`; no change expected (verify only).

No route changes: `client/src/main.tsx` is untouched (the schema travels in router `state`, not the URL).

## Implementation approach

1. **`ContentPage.tsx` "New entry" button:** extend the navigation state it already passes to include the current selection — navigate to `/content/new` with `state: { list: listUrl, schema: selected }`. `selected` is `null` at `/content` and the schema name string on `/content/:schema`. Keep the existing `disabled={!hasLiveSchema}` behavior.
2. **`NewContentPage.tsx`:** read the default from router state — `const defaultSchema = typeof location.state?.schema === "string" ? location.state.schema : null;`. Initialize `schemaName` from it: `useState<string | null>(defaultSchema)`.
3. Remove the `schemas[0]` fallback in the `selected` derivation: `const selected = schemaName;` (drop `?? schemas[0]?.name ?? null`).
4. Remove the `useEffect` that force-sets `schemas[0].name` when no name is chosen. The empty state (`selected == null`) must persist so the intermediate state renders — no background defaulting.
5. **Intermediate state:** when `selected == null` and schemas exist, render the `NewEntrySelector` (already present) and a short hint such as "Select a schema to begin" in place of any form fields. The existing render path already hides `DynamicEntryForm`, `PageSkeleton`, and the schema-error alert when `selected == null` — the only addition needed is an explanatory line so the state is intentional, not blank. When the user picks a schema, `setSchemaName` flows through unchanged and the form appears.
6. Guard against a stale/deleted default: if `defaultSchema` names a schema that is not in the loaded `schemas` list (deleted by another editor, or a bad deep link), treat it as `null` so the user lands in the selector-only state rather than a broken form. This requires comparing `defaultSchema` against `schemas` once loaded — initialize `schemaName` to `null` and set it from state only if the schema exists, or clamp it via an effect that runs when `schemas` arrives. Choose the least-obtrusive approach that avoids a permanently-broken form for a missing schema.
7. Keep the "No schemas yet" alert behavior as-is (schemas list empty → selector disabled, alert shown).

## Edge cases

- **Edit-page `location.state` sharing:** `ContentEditorPage` also uses `location.state?.list`; this change only adds a new `schema` key and does not alter the `list` contract. Verify the edit page ignores any now-extra state.
- **All-view to create:** `/content` → "New entry" yields `schema: null` → intermediate selector state. This is the prompt-starter behavior being restored.
- **Filtered-view to create:** `/content/<schema>` → "New entry" yields the schema name → form immediately shows that schema's fields; the selector still allows switching to another schema.
- **Direct navigation / refresh:** `/content/new` typed in the URL has no `location.state` → `defaultSchema` is `null` → selector-only state (no first-schema surprise).
- **Deleted default schema:** covered by step 6 — no broken form, user is nudged to pick.
- **`useEntries(selected ?? "")` and `useQuery` on `selected`:** already tolerate `null` (`enabled: selected != null`, empty-string key); verify they remain safe when `schemaName` starts `null` and only becomes set on user action.

## Acceptance criteria

1. `ContentPage.tsx`: the "New entry" button's navigation passes `state` containing both the origin `list` URL and the current `selected` schema (which is `null` in the All view). `ContentPage` contains no other path that navigates to `/content/new` without this state.
2. `NewContentPage.tsx` no longer contains any `schemas[0]` defaulting — grep for `schemas[0]` in that file returns nothing. The page's chosen schema comes solely from `location.state.schema` (validated against the loaded schema list) or from the user's `NewEntrySelector` selection.
3. When no schema is chosen, the page renders the selector plus a "select a schema" hint and **does not** render `DynamicEntryForm` (the form, skeleton, and schema-error branch are all gated on `selected != null`). Inspect the render conditions to confirm.
4. `pnpm --filter client build` passes.
5. **Manual (cannot be verified by tests):** in a browser with at least two schemas — from `/content/<schema>` click "New entry" → the create form opens already showing that schema's fields; from `/content` (All) click "New entry" → only the schema selector and hint appear until a schema is chosen; picking a schema then renders its fields. Verify by hand.
