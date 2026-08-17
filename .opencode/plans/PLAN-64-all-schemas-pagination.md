# PLAN-64 — Fix all-schemas listing pagination dropping entries

**Depends on PLAN-63** (client test harness). The regression suites for this plan run under `pnpm --filter client test`; the merge extraction produced there is transitional and is replaced by this plan.

## Goal

In the all-schemas content listing (`/content` without a schema), pagination is broken in two compounding ways:

1. **Dead end.** The merged-reduce in `useAllEntries` resets the merged `nextCursor` to `null` when *any* schema runs out of pages, so as soon as the smallest schema is exhausted the list dead-ends and the remaining schemas' rows are unreachable.
2. **Shared-cursor lockstep (deeper flaw).** One shared URL cursor is sent to *every* per-schema query. Each schema seeks that anchor in its own sort order, so once schemas desynchronize (different entry counts), whole ranges of rows are duplicated or never shown.

Exploration additionally found that **the pagination path is currently unreachable in normal use**: on the first page there are no cursor params in the URL, so `ContentPage` passes `paginationParams = undefined` and every per-schema query fetches *all* entries un-paginated — the merged-listing pagination only activates when cursor params reach the URL via bookmark/deep-link, which is exactly when the lockstep flaw produces a garbled partial list. The fix therefore must start per-schema cursors from page 1 in the all-view.

**Fix: per-schema cursors.** Each schema's query carries its own cursor; the all-view's URL state records, per schema, how to fetch that schema's contribution at the current page depth. Schemas that run out stop contributing (and stop being fetched) while the others continue, and walking back restores them at exactly the right depth.

## Files

- `client/src/lib/allViewPagination.ts` — **new.** Pure state model, transitions, visibility rules, and URL codec for the all-view pagination state. No React, no fetch — fully unit-testable.
- `client/src/hooks/useAllEntries.ts` — rewritten to consume the state model (one query per *visible* schema, each with its own cursor).
- `client/src/routes/ContentPage.tsx` — all-view branch only: parse the state from the URL, drive Next/Prev through the transitions. The single-schema branch (`useEntries` + `cursor_next`/`cursor_prev`/`page` params) is **untouched**.
- `client/test/` — new suite for the transitions/codec; the PLAN-63 merge suite and the extracted merge function are **deleted** (superseded).
- `client/src/lib/cursor.ts` — unchanged. (`compareRawCursors` may lose its last runtime caller after the rewrite; keep the function and its tests.)

## The state model (contract)

```
AllViewState = { depth: number; schemas: Record<string, SchemaPageState> }
SchemaPageState = { cursor?: string; direction?: "fwd" | "bwd"; stuckAt?: number }
```

- `depth` is the 1-based page position of the merged list (the "Page N" counter).
- A schema's state describes **how to fetch that schema's contribution at the current depth**: send `cursor` + `direction` to its entries endpoint. Both absent = first page.
- `stuckAt` names the depth of this schema's *last* page and is present only while the current depth is beyond it. A stuck schema contributes **nothing** and is **not fetched**.
- A schema name absent from `schemas` (fresh load, or a schema added to the set mid-session) means *implicit first-page state*.
- Absent or malformed state in the URL → initial state `{ depth: 1, schemas: {} }`.

**URL encoding:** a single search param, `allview`, whose value is the JSON-encoded state (`URLSearchParams` handles the percent-encoding). The old params (`cursor_next`, `cursor_prev`, `page`) are ignored in the all-view — they remain the single-schema view's params on the same route, and old all-view bookmarks degrade gracefully to page 1.

**Transitions (pure, exported from the lib module):**

- `advance(state, nextCursors): AllViewState` — `nextCursors: Record<schema, string | null>`, one entry per schema in the current query set (i.e. per visible schema, from the live responses). New depth = `depth + 1`. Per schema: `nextCursor != null` → `{ cursor: nextCursor, direction: "fwd" }`; `nextCursor == null` → keep the schema's current fetch fields and set `stuckAt` to the *old* depth. Schemas not present in `nextCursors` (stuck ones) keep their state unchanged.
- `retreat(state, prevCursors): AllViewState` — `prevCursors: Record<schema, string | null>` from the live responses. New depth = `depth - 1`. Per schema: normal state → `prevCursor != null ? { cursor: prevCursor, direction: "bwd" } : {}` (the empty case is only reachable at depth 1, where retreat is disabled); stuck with `stuckAt == new depth` → drop `stuckAt` (its last page becomes visible again); stuck with `stuckAt < new depth` → unchanged.
- `isStuck(state, schema): boolean` — `stuckAt != null && stuckAt < state.depth`.
- `hasNext(state, nextCursors): boolean` — some non-stuck schema has a non-null `nextCursor`. (Guaranteed consistent: reaching depth N always implies at least one schema has a page at depth N.)
- `hasPrev(state): boolean` — `state.depth > 1`.
- `encodeState(state): string` / `decodeState(raw: string | null): AllViewState` — the `allview` codec; `decodeState` validates the shape and returns the initial state for anything malformed.

**Why stuck schemas need no fetch while stuck:** the retreat decision for a stuck schema uses only `stuckAt` vs the new depth, never a response. Its last page is re-fetched (from the stored fetch fields) exactly when it becomes visible again.

## Approach (ordered)

1. **Pure module first.** Write `client/src/lib/allViewPagination.ts` (state types, transitions, visibility, codec) with no other files depending on it yet.
2. **Test it** (see regression tests below). This is where the bug class gets pinned.
3. **Rewrite `useAllEntries`:**
   - New signature shape: `(schemaNames: string[], state: AllViewState)` — always paginated mode. Every *visible* schema query sends `limit` (50 — keep `PAGE_LIMIT` reachable from the route; pass it or share the constant) plus its own `cursor`/`direction`. Stuck schemas issue **no query** (omit them from the `useQueries` array).
   - Query keys must include each schema's own cursor state so navigating refetches.
   - Merged `data`: concatenation of the visible schemas' entries, sorted by `last_modified_date` descending (existing behavior).
   - Expose what the route needs to compute transitions: the per-schema `nextCursor`/`prevCursor` from the live responses, plus `hasNext`/`hasPrev` via the lib functions. Keep the existing `isPending`/`isError`/`isSuccess`/`error`/`refetch` semantics (any query error → `isError`; pending only while nothing has succeeded).
   - Delete the old merged-reduce and the PLAN-63 extraction with it.
4. **Route (all-view branch only).** Parse `state` from the `allview` param (`decodeState`). `goToNextPage`/`goToPrevPage` compute `advance`/`retreat` from the hook's per-schema cursors and navigate to the URL with the new `allview` value, preserving `conflicted` and any sort params present, and **not** writing `page` in the all-view (depth lives in the state). The "Page N" display reads `state.depth`. `hasNextPage`/`hasPrevPage` come from the hook. Everything in the single-schema branch — including `buildListUrl`, `buildPageUrl`'s cursor handling, and the `cursor_next`/`cursor_prev`/`page` reading — stays as-is.

## Regression tests (the bug class to pin)

Drive the pure transitions with fixture responses for **uneven schemas** (the exact desynchronization scenario), e.g. limit 3: schema A has 4 rows (2 pages), B has 7 rows (3 pages). Model each schema's pages as fixture responses (`entries` + `nextCursor`/`prevCursor`) and walk:

- **No drops, no duplicates.** Walking `advance` from the initial state to the end: the multiset of entry ids shown across all depths equals the multiset of all 11 fixture rows, each exactly once (A's rows split 3+1 over depths 1–2, B's rows 3+3+1 over depths 1–3).
- **Visibility.** A is visible at depths 1–2 and hidden at depth 3; `hasNext` is false exactly at the final depth; `hasPrev` is true for depth > 1 and false at 1.
- **Backward restore.** `retreat` from depth 3 → 2: A's last page reappears **exactly** at depth 2 (its rows, once); `retreat` again → 1: first pages for both.
- **Stuck schemas are skipped.** During the walk, a stuck schema never appears in the query set the route would build (assert via `isStuck`/visibility, and that `advance`/`retreat` leave its state untouched apart from the documented rules).
- **Codec.** `encodeState`→`decodeState` round-trips; `decodeState(null)`, `decodeState("garbage")`, and a decoded-but-wrong-shape object all yield the initial state. A URL carrying only the old-style `cursor_next` param yields the initial state (the codec is the sole reader of `allview`).

## Edge cases (found while exploring)

- **The single-schema view shares this route** and keeps using `cursor_next`/`cursor_prev`/`page` + `useEntries`. Do not touch that branch. (Note: it has the same page-1 un-paginated short-circuit — its pagination is likewise unreachable in normal use. That is out of scope here; the all-view is what this plan fixes.)
- **Sort params in the all-view URL are ignored by the queries** (existing behavior: the all-view sends no sort; the sort selector renders only in the single-schema view). Preserve them through pagination navigation; do **not** wire sort into the all-view in this task.
- **Schemas list loading.** While the schema list query is pending the all-view has zero schemas; when it arrives, implicit first-page states apply. A schema added to the set mid-pagination starts at its first page — acceptable; do not build state-reset machinery for it.
- **Schema deleted while paginating.** The schemas list updates; stale `schemas` entries for the deleted name are inert (no query is issued for names not in the live list).
- **Conflicted-only filter** is a client-side post-filter (existing): under it, a page can render empty and show the existing "No conflicted entries" alert. Unchanged.
- **Merged page size.** A merged page holds up to (visible schemas × 50) rows — existing concatenation behavior, unchanged.
- **URL length** grows with schema count × cursor size; acceptable for realistic schema counts. No compression.
- **Server cursor leniency is not a crutch.** `contentRepo.listEntriesPaginated` treats a cursor that doesn't match the current sort as "no cursor" (first page). The design above never relies on that: each schema only ever receives cursors it generated itself.

## Acceptance criteria

1. `pnpm --filter client test` exits 0 and the new all-view pagination suite passes, including the no-drops/no-duplicates walk over the uneven-schema fixture (asserted on entry-id multisets per depth).
2. `pnpm --filter client typecheck` exits 0.
3. `pnpm -r test` exits 0 (server suites remain green).
4. The shared-cursor lockstep is gone: `grep -n "compareRawCursors" client/src/hooks/useAllEntries.ts` returns no matches, and `grep -rn "cursor_next" client/src/lib/allViewPagination.ts` returns no matches (the all-view state never reads or writes the single-schema cursor params).
5. **Manual (cannot be verified mechanically; verify in a browser):** run the app with at least two schemas whose entry counts differ across a 50-entry boundary (one schema > 50 entries). In the all-view: walk Next to the end — every entry appears exactly once across all pages, the exhausted schema's rows stop appearing while the larger schema continues, and Next disappears only after the largest schema is exhausted; Prev walks back restoring the smaller schema's last page at exactly the right depth; refreshing the browser at any depth restores the same page (state survives the round-trip through the URL). The single-schema view (`/content/<schema>`) behaves exactly as before this change.
