# PLAN-34 — "Show conflicted only" filter on the content listing

## Goal

After a breaking schema change, entries whose `schema_version < compat_version` render with an amber "Conflicted" badge on the content listing — but no way exists to isolate them, so an editor with one bad schema among many must scan every row. Add a client-side **"Show conflicted only"** filter to `ContentPage`, active in **both** the `/content` All view and the `/content/:schema` filtered view.

The filter is URL-driven via a `?conflicted=1` query param (the app's first query param — react-router@7 supports it natively). URL state beats component state here because:
- the browser back/forward buttons and refresh preserve the filter,
- deep links work (`/content/car?conflicted=1`), which **PLAN-35**'s "view affected entries" link depends on,
- `ContentPage` already round-trips a `listUrl` through router `state.list` to `/content/new` and the entry editor; threading the param through `listUrl` means those screens return to the filtered list with **zero changes to `ContentEditorPage`/`NewContentPage`**.

Filtering is a pure client-side derivation; `conflict` is guaranteed present on every entry in both views (the server computes it in `ContentService.toEntry`). No server change, no API/type change, no change to `useEntries` or `useAllEntries`.

## Dependency

None. Standalone client change. (PLAN-35 will consume this filter as a deep-link target, but this plan does not depend on it.)

## Files involved

- `client/src/routes/ContentPage.tsx` — the only file that must change.
- `client/src/components/ui/checkbox.tsx` — used as-is (already exists, wraps `@base-ui/react/checkbox`).
- `client/src/routes/ContentEditorPage.tsx` and `client/src/routes/NewContentPage.tsx` — must **not** need changes; they read `location.state.list` and navigate to it, so the filter survives the round-trip through `listUrl`.

## Implementation approach

1. **Read the param.** Import `useSearchParams` from `"react-router"`. Derive `const [searchParams, setSearchParams] = useSearchParams();` and `const conflictedOnly = searchParams.get("conflicted") === "1";`.

2. **Add a `withConflicted(path)` helper** in the page: returns `\`${path}?conflicted=1\`` when `conflictedOnly` is true, else the path unchanged. Use it for every navigation target construction so the filter survives navigation:
   - `listUrl` (this automatically covers the new-entry and entry-editor return flows, which navigate back to `state.list`).
   - The schema `<Select>` `onValueChange` targets — both `/content` and `/content/${encodeURIComponent(value)}`.
   - The "Back to content" button on the schema-not-found screen (consistency; cheap).

3. **Derive the visible list.** `const visibleEntries = conflictedOnly ? entries.filter((entry) => entry.conflict) : entries;` — applied after the All view's merge/sort, so it works identically in both views.

4. **Render the toggle.** In the existing filter block that holds the "Schema" `Label` and the schema `<Select>` (which renders whenever `schemas.length > 0`), add a `Label` + `Checkbox` row: label text "Show conflicted only". The checkbox renders in both views because that block is outside the `allView` branches. Render it **controlled**: `checked={conflictedOnly}` with `onCheckedChange={(checked) => (checked ? setSearchParams({ conflicted: "1" }) : setSearchParams({}))}` — base-ui's `Checkbox` callback delivers a plain `boolean` (indeterminate is a separate prop, not part of this union). The controlled binding is what makes deep links, refresh, and back/forward render the box checked on load — an uncontrolled checkbox would filter the list but show unchecked, breaking acceptance 3e. Note that `setSearchParams` keeps the current `:schema` path segment (it only touches the query string), so toggling never loses the schema selection.

5. **Handle the empty-filtered state.** Keep the existing **"No entries yet"** branch keyed on `entries.length === 0`. Add a new branch for `entriesQuery.isSuccess && entries.length > 0 && conflictedOnly && visibleEntries.length === 0`: render an `Alert` with "No conflicted entries" copy that varies by view ("All schemas" vs "this schema"), mirroring the existing empty-state pattern.

6. **Render `visibleEntries`.** Replace the `entries.map(...)` and the `entries.length > 0` list guard with `visibleEntries` equivalents. The skeleton (`isPending`), error, and "No entries yet" branches keep reading `entriesQuery` as today. The rows themselves — including the amber "Conflicted" badge and the delete dialog — are untouched.

7. **No other file changes.** Do not touch `SchemasPage` (its "View entries" link stays plain), `main.tsx` (routes already accept query strings), hooks, or the server. Adding affordances elsewhere is follow-up scope, not this plan.

## Edge cases

- **No conflicted entries while filtered**: handled by the new empty-filtered `Alert` (step 5). The toggle must remain interactable so the user can unfilter.
- **SSE invalidations while filtered**: `useRealtime` invalidates `queryKeys.entries(schema)` on schema/entry events; React Query refetches in the background and `visibleEntries` re-derives from the fresh `entriesQuery.data`, so newly-flagged conflicts appear without any special handling.
- **Editor/new-entry return flow**: because `listUrl` carries `?conflicted=1`, `ContentEditorPage` and `NewContentPage` return to the filtered view unchanged. Verify this manually (criterion 3d).
- **Back/forward and refresh**: URL-driven, so they work; every ContentPage navigation must go through `withConflicted` or the filter is silently lost mid-flow.
- **Deleted schema while filtered**: `deletedSchemas` row-dimming is untouched; a deleted-but-conflicted row stays visible (dimmed) under the filter, which is correct.
- **Encoding**: keep `encodeURIComponent` for schema names (existing convention); the literal query string `?conflicted=1` needs no encoding.
- **Toggle disabled states**: while `entriesQuery.isError` or `schemas.length === 0` the toggle can stay rendered but inert (no data to filter); the plan does not require disabled styling — leave to the implementer's judgment, matching the page's existing patterns.

## Acceptance criteria

1. `pnpm --filter client typecheck` exits 0 — `tsc --noEmit` under `strict` + `noUnusedLocals` + `noUnusedParameters` (the client package has no test runner; this is the mechanical gate).
2. `pnpm --filter client build` exits 0.
3. Manual browser verification (no client test infrastructure exists; these cannot be automated mechanically). With a schema containing at least one conflicted and one valid entry:
   - a. The "Show conflicted only" checkbox renders on both `/content` and `/content/:schema`; checking it shows only conflicted rows and unchecking restores all rows.
   - b. With the filter on, switching schemas via the schema `<Select>` lands on the other schema's list with the filter still active (URL keeps `?conflicted=1`).
   - c. With the filter on and no conflicted entries in view, the "No conflicted entries" `Alert` renders instead of an empty list.
   - d. With the filter on, editing a conflicted entry and saving returns to the filtered list (the `state.list` round-trip preserved the param); the browser back button also preserves the filter.
   - e. Directly loading `/content/<schema>?conflicted=1` (or `/content?conflicted=1` for the All view) renders the filtered list on first load.

## Verify notes

`pnpm --filter client typecheck` then `pnpm --filter client build`, then the manual checklist. Client test backfill is tracked separately and deliberately out of scope for this plan.