# PLAN-13 — Content listing schema filter with "All" view and `/content/:schema` routes

## Goal

Give the content listing a schema filter driven by the URL, replacing the current local-state dropdown that silently defaults to the first schema.

- `/content` shows an **All view**: entries from every schema, aggregated client-side, presented as one flat list with a per-row schema label.
- Selecting a schema from the dropdown navigates to `/content/<schema>`, which shows only that schema's entries (same rows as today, no schema label needed — the dropdown implies it).
- The dropdown has a default "All schemas" option at `/content`; picking it navigates back to `/content`.
- Saving an entry (edit) or creating an entry (new) returns to the list the user came from: a filtered `/content/<schema>` stays on that filter, the All view returns to `/content`.

## Depends on

- PLAN-08 (SSE realtime) — `useRealtime` is consumed as-is with its `schemas: string[]` and `deletedSchemas` contract. The All view passes the explicit list of schema names so reconnect re-sync (`invalidateVisible`) can invalidate each schema's entry query.
- PLAN-11 (save returns to listing) — established the post-save `navigate(..., { replace: true })` in `ContentEditorPage` and `NewContentPage`; this plan makes the target origin-aware.

Both are committed; nothing in this plan depends on uncommitted work.

## Files involved

- `client/src/main.tsx` — register the `/content/:schema` route.
- `client/src/routes/ContentPage.tsx` — core rework: URL-driven selection, All view, dropdown with "All schemas" option, schema badge, origin state on the edit / "New entry" buttons.
- `client/src/hooks/useAllEntries.ts` (new) — merged per-schema entries queries via TanStack Query's `useQueries`.
- `client/src/routes/ContentEditorPage.tsx` — origin-aware save/back navigation.
- `client/src/routes/NewContentPage.tsx` — origin-aware create-success navigation.

No server changes: every entry already carries its `schema` name, and there is no cross-schema listing endpoint (nor should one be added).

## Implementation approach

### 1. Route registration
In `client/src/main.tsx`, add a route for `/content/:schema` rendering `ContentPage` inside `RequireRole role="editor"`, alongside the existing `/content` and `/content/new` children (insert after the `/content/new` block and before `/content/:schema/:id` for readability). React Router ranks static segments above dynamic ones, so the literal `/content/new` keeps resolving to `NewContentPage` regardless of insertion order. Today `/content/<schema>` falls through to the catch-all and redirects to `/login`; this registration is what fixes that.

### 2. Selection model
`ContentPage` must derive the active schema from the URL instead of `useState`:

- Read `useParams()`. No `schema` param → All view; a `schema` param → filtered view for that schema.
- The dropdown reflects the current value and **navigates on change** rather than setting state:
  - an "All schemas" item (sentinel value, e.g. `"all"`) → `navigate("/content")`;
  - a schema item → `navigate(\`/content/${encodeURIComponent(schema.name)}\`)`.
- Remove the current `selected = schemaName ?? schemas[0]?.name ?? null` defaulting: `/content` must show the All view, never silently default to the first schema. The dropdown's active item on `/content` is "All schemas".

### 3. All view data aggregation
Create `client/src/hooks/useAllEntries.ts`: a hook accepting the list of schema names and returning a merged `listQuery`-shaped result, built on TanStack Query's `useQueries` (`@tanstack/react-query@^5.101.4` ships it). One query per schema, using the **same query key and query function as `useEntries`** — `queryKeys.entries(name)` hitting `GET /api/schemas/<name>/entries` — so the existing cache, optimistic updates, and SSE invalidation from `useRealtime`/`useEntries` keep working unchanged.

- `data`: flat `ContentListEntry[]` merged from every succeeded query, sorted by `last_modified_date` descending (ISO strings compare lexicographically). Entry ids are globally unique (single table), so no cross-schema collision on React keys.
- Aggregate status for the page: pending while no query has succeeded and some are pending (render the existing skeleton loader, matching the loading-only-skeletons convention); errored if any query errored; success otherwise. A retry must refetch every schema's query.
- The filtered path keeps using the existing `useEntries(selected)` unchanged.

### 4. Page rendering
- **Dropdown**: add an "All schemas" item above the schema items, shown in both views, keeping the existing shadcn `Select` pattern already at the top of the page.
- **Schema not found**: when a `schema` param is present but `schemasQuery` succeeded and that name is not in the list, render a destructive "Schema not found"-style state (mirror `ContentEditorPage`'s handling of an unknown `/schemas/:name`) with a back button to `/content` — not a dropdown whose value matches no item, and not a silent empty list.
- **Row actions use the entry's schema**: the edit button must navigate to `/content/<encoded-schema>/<id>` built from **`entry.schema`**, never the page-level selection (the current `selected!` would produce `/content/null/...` in the All view). The delete-confirm dialog description must likewise use `entryToDelete.schema`.
- **Delete mutation keyed to the entry's schema**: the `remove` mutation must target the schema of the entry being deleted, because the merged All view derives from per-schema queries. Obtain it from `useEntries(entryToDelete?.schema ?? "")` — in the filtered view that equals the selected schema, so one wiring serves both views, and with no dialog open the empty-key query stays disabled and harmless. This keeps `useEntries`' optimistic removal and `onSettled` invalidation on the correct per-schema query, which the merged list observes. The page must not call `useEntries("")` (or `useEntries(selected ?? "")` in the All view) for `remove`, since that optimistically edits a key matching no real query and the deleted row would linger in the merged list.
- **Label fields per schema**: rows title via `entryLabel(entry, labelFieldId)`. In the All view the label-field id is per schema — build a map from `schemasQuery.data` with `schemaLabelField` rather than resolving a single id from the selected schema.
- **Schema badge**: in the All view, each row shows the schema name as a small label/badge so the merged list stays scannable; the filtered view already implies it from the dropdown and does not need it.
- **Empty/error states**: carry over the existing "No schemas yet", entries-empty, and entries-error (destructive `Alert` + Retry) states; in the All view they operate on the merged query (a retry refetches all schema queries).
- **Realtime**: the All view passes the full list of schema names to `useRealtime` (`schemas: []` also means "all" but leaves `invalidateVisible` unable to re-sync per-schema entry queries on reconnect; the explicit list makes it re-sync every visible schema's entries). The filtered view keeps `schemas: [selected]`. Rows whose `entry.schema` is in `deletedSchemas` render disabled (opacity + no pointer events), in both views; the "This schema was deleted" `Alert` stays a filtered-view feature.
- **"New entry" button**: enable when at least one non-deleted schema exists (filtered view: at least the selected one); it navigates to `/content/new` and passes origin state (step 5).

### 5. Origin-aware save/return
- `ContentPage`'s edit buttons and "New entry" button pass navigation state with the current list URL, e.g. `state={{ list: "/content" }}` on `/content` and `state={{ list: \`/content/${encodeURIComponent(schema.name)}\` }}` on a filtered view.
- `ContentEditorPage`: on save success navigate to `location.state?.list ?? "/content"` with `{ replace: true }`. The fallback covers a hard refresh of the editor URL, where `location.state` is empty.
- `NewContentPage`: same origin-aware target on create success, same fallback.

## Edge cases

- **Unknown schema in URL**: handled by the schema-not-found state (step 4) — no broken dropdown, no silent empty page.
- **`/content/new` vs `/content/:schema`**: static-route ranking keeps `NewContentPage` winning for the literal `/content/new`. A schema literally named `new` (or `all`) is shadowed by the static route (or the All sentinel) and unreachable at those URLs — accepted, do not build around it.
- **Back/forward**: the filter lives in the URL, so browser navigation restores it with no extra state; TanStack caching per `queryKeys.entries(name)` makes returns instant.
- **New schema created while on the All view**: events for schemas not in the view's list are ignored (no toast, no invalidate) until the next reconnect or navigation refreshes the schema list. Acceptable — do not build workarounds.
- **Delete in the All view**: `remove` is keyed by `entryToDelete?.schema` (step 4), so optimistic removal and invalidation land on the correct per-schema query and the merged list updates. 
- **Hard-refreshed editor URL**: `location.state` is empty → save returns to `/content` (both origin values resolve to real routes).

## Acceptance criteria

The client package has no test harness in this repo, so criteria 2–7 are structural (grep/source) checks that confirm the code wires the behavior in the only way the codebase supports; the user-visible behaviors they stand in for are exercised end-to-end in the manual criterion 8.

1. **Build/typecheck**: `pnpm --filter client build` exits 0.
2. **Route registered**: `grep -n 'path: "/content/:schema"' client/src/main.tsx` matches, and reading the router definition confirms that route renders `ContentPage` inside `RequireRole role="editor"`.
3. **URL-driven selection, no first-schema default**: `grep -n "useParams" client/src/routes/ContentPage.tsx` matches, and `grep -n "schemas\[0\]" client/src/routes/ContentPage.tsx` returns no hits in that file.
4. **Dropdown has "All schemas" and navigates**: reading `ContentPage`, the schema `Select` renders an item whose value is the All sentinel (labelled "All schemas"), and its change handler calls `navigate` (`/content` for All, `/content/<encoded-schema>` for a schema) rather than setting local state. Not mechanically verifiable — see criterion 8 for the behavioral check.
5. **All view aggregates via `useQueries`**: `client/src/hooks/useAllEntries.ts` exists; `grep -n "queryKeys.entries" client/src/hooks/useAllEntries.ts` matches and `grep -n "useQueries" client/src/hooks/useAllEntries.ts` matches; reading `ContentPage` confirms the All view uses this hook (and the filtered view still uses `useEntries`).
6. **No page-selection-based navigation**: `grep -n "entryToDelete?.schema" client/src/routes/ContentPage.tsx` matches (delete mutation keyed by the deleted entry's schema) and reading `ContentPage` confirms the edit `navigate` target is built from `entry.schema` and the delete dialog description uses `entryToDelete.schema`.
7. **Origin-aware save**: `grep -n "location.state" client/src/routes/ContentEditorPage.tsx client/src/routes/NewContentPage.tsx` matches in both files, with a `/content` fallback when the state is absent.
8. **Manual** (requires `pnpm dev`): with two schemas each holding at least one entry, `/content` shows both entries with a schema label and an active "All schemas" dropdown (i.e. the All view, not the first schema's view); selecting a schema lands on `/content/<schema>` showing only that schema's entries; selecting "All schemas" returns to `/content`; editing an entry from `/content/<schema>` and saving returns to that same `/content/<schema>`; editing from `/content` and saving returns to `/content`; deleting an entry from the `/content` All view removes it from the merged list immediately (optimistic) and stays gone after refetch; a hard refresh of `/content/<nonexistent>` shows the schema-not-found state with a back link to `/content`.
