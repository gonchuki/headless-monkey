# Fix Cursor Pagination for Non-ID Sorts (Keyset on the Sort Column)

> **Relationship to PLAN-60:** This plan is designed to be forward-compatible with PLAN-60-fix-sort-dropdown.md. The keyset mechanism must be generic over the sort column (driven entirely by `ResolvedSortParams`) so that PLAN-60's new `modified` sort needs no change to the keyset mechanism — only a case in the shared derivation (step 2) and its ORDER BY clause (PLAN-60 step 4). No hard dependency — either plan can execute independently, but they are intended to run in this order.

## Goal

Make cursor-based pagination in `ContentRepository.listEntriesPaginated` correct for **every** sort kind, not just id sorts. Today the cursor is a bare `content.id` and pages are filtered with `WHERE content.id < ?` / `> ?` (the code comment says "The cursor is always a content.id; the ORDER BY handles display order"). That is only valid when the sort column *is* the id. For any other sort column (`date`, custom fields — and the `modified` sort that PLAN-60-fix-sort-dropdown.md adds next), page 2+ can duplicate rows from page 1 and drop rows that should appear, because "rows after the cursor in display order" is not the same set as "rows with a smaller/larger id".

Fix: keyset pagination on the actual sort column with `content.id` as the tiebreak. The cursor becomes an opaque string encoding `(sort-column value, content.id)`, carried unchanged by the client.

The mechanism must be **generic over the sort column** (driven entirely by `ResolvedSortParams`) so that future sort columns work without touching pagination again.

## Files Involved

- `server/src/types.ts` — `PaginationParams`, `PaginationResponse`, `parseCursor`
- `server/src/repositories/contentRepo.ts` — `listEntriesPaginated`, `buildOrderClause`
- `server/src/routes/paramValidation.ts` — `parsePaginationParams`
- `client/src/lib/api.ts` — `PaginationResponse`
- `client/src/hooks/useEntries.ts` — client `PaginationParams`
- `client/src/hooks/useAllEntries.ts` — cross-schema cursor merge
- `client/src/routes/ContentPage.tsx` — cursor URL handling
- `server/test/contentService.test.ts` — existing pagination tests + new walk tests
- `server/test/publicApi.test.ts` — HTTP-level cursor round-trip tests

## Implementation Approach

### 1. Cursor contract (`types.ts`, `paramValidation.ts`)

- `PaginationParams.cursor` and `PaginationResponse.nextCursor` / `prevCursor` become **string** (opaque) on both server and client.
- A cursor encodes both the sort-column value of the anchor row and that row's `content.id`. It must be reversible and safe to carry in a URL query param. The exact encoding is the implementer's choice (e.g. base64url of a small JSON pair) — the server encodes and decodes; the client treats it as an opaque string. The encoding must distinguish a SQL NULL sort value from any string value.
- `parseCursor` (in `types.ts`) becomes the decoder. An undecodable cursor must be treated as "no cursor" (first page), preserving today's lenient behavior for garbage input — existing tests rely on it.
- `parsePaginationParams` passes the raw cursor string through to the service/repo instead of coercing with `Number()`.

### 2. One sort-column derivation, shared by ORDER BY / WHERE / cursor extraction (`contentRepo.ts`)

- Derive the SQL expression for the sort column from `ResolvedSortParams` in a single place: `"id"` → `content.id`, `"date"` → `content.creation_date`, numeric field id → `sort_field.value` (with `CAST(... AS REAL)` when `sortFieldType === "number"`, and the existing `LEFT JOIN` produced by `buildJoinClause`).
- The same derivation must also produce the **tiebreak direction** `T` for `content.id`: `T = sortOrder` when `sortField === "modified"` (the sort PLAN-60 adds), otherwise `T = "asc"` — preserving today's universal `id ASC` tiebreak for id/date/field sorts. Do not change the existing sorts' behavior; only `"modified"` gets a direction-matching tiebreak. Display order is `(sortColumn dir, content.id T)`. If this plan executes before PLAN-60, the `"modified"` token does not exist in the sort union yet — write the derivation so that adding it later is a one-case change (e.g. a small `tiebreakDirection(sort)` helper), and do not add the token yourself.
- `buildOrderClause`, the keyset WHERE clause, and cursor value extraction must all use this one derivation. This genericity is what lets PLAN-60's new sort column work without touching pagination again.
- When sorting by a custom field, the paginated SELECT must also return the sort column's value per row (it currently does not), so cursors can be generated from the first/last rows of the page.

### 3. Keyset WHERE + ordering (`contentRepo.ts`, `listEntriesPaginated`)

Display order is `(C dir, content.id T)`, where `C` is the derived sort column and `T` is the tiebreak direction from step 2. For an anchor row `(v, i)` — the cursor's decoded pair — let `<tie>` be `content.id > i` when `T = "asc"` and `content.id < i` when `T = "desc"`, and `<tie-rev>` its opposite:

- **Forward** (rows after the anchor), ordered by display order:
  - desc sort: `(C < v) OR (C = v AND <tie>)`
  - asc sort: `(C > v) OR (C = v AND <tie>)`
- **Backward** (rows before the anchor): fetch in the exact reverse of display order, then reverse the result array to restore display order.
  - for a desc sort: condition `(C > v) OR (C = v AND <tie-rev>)`, ordered `C ASC NULLS FIRST, content.id <revT>`
  - for an asc sort: condition `(C < v) OR (C = v AND <tie-rev>)`, ordered `C DESC NULLS FIRST, content.id <revT>`
  - where `<revT>` is the reverse of `T`. The backward ORDER BY must be the exact reverse of display order *including NULL placement*: display order puts NULLs last in both directions (`NULLS LAST`), so its reverse puts NULLs first. Plain `C ASC` already does this under SQLite's default NULL ordering, but `C DESC` needs an explicit `NULLS FIRST` (SQLite's default for DESC is NULLs-last). Do not copy the existing `NULLS LAST` pattern into the backward clause; for non-nullable `C` the `NULLS FIRST` is a no-op and may be omitted.
- **NULL sort values** (custom field sorts only — `content.id`, `creation_date`, and `last_modified_date` are NOT NULL): rows whose value is NULL sort last in display order in both directions, so the comparisons above must be written NULL-aware:
  - forward, anchor value non-NULL: append `OR C IS NULL` (every NULL row comes after any non-NULL row);
  - forward, anchor value NULL: the condition is just `C IS NULL AND <tie>`;
  - backward, anchor value non-NULL: no extra term — NULL rows are never "before" a non-NULL anchor, and SQL's NULL comparisons exclude them anyway;
  - backward, anchor value NULL: the condition is `(C IS NOT NULL) OR (C IS NULL AND <tie-rev>)` — a naive `(C < v) OR ...` with `v = NULL` evaluates to NULL for every row and would return nothing.
- The composite form degenerates cleanly for `"id"` sorts (`C` is `content.id` itself, never NULL), so a single uniform path works for all sort kinds; keeping a dedicated branch for id sorts is also acceptable if its behavior matches the existing tests.
- `buildOrderClause` currently only emits an `id ASC` tiebreak, so it needs to support both the `T` direction and the reversed ordering used by backward fetches (a parameter or a sibling builder).
- The `nextCursor` / `prevCursor` existence probes currently compare bare ids (`SELECT 1 ... WHERE id > ?` / `id < ?`). Re-derive them so they agree with the keyset semantics: null exactly when no rows remain in that direction.
- Keep the existing `limit + 1` probe-row mechanism for `hasMore`.

### 4. Client cursor type (`api.ts`, `useEntries.ts`, `useAllEntries.ts`, `ContentPage.tsx`)

- `PaginationResponse.nextCursor` / `prevCursor`: `number | null` → `string | null`; client `PaginationParams.cursor`: `number` → `string`.
- `ContentPage` currently coerces URL cursors with `Number(...)` — remove the coercion; pass the opaque string through to the query and back into the next page's URL.
- `useAllEntries` merges pagination across per-schema queries using `Math.min` / `Math.max` on cursors, which only works for numbers. Replace with a comparison of decoded cursors that generalizes today's behavior exactly: merged `nextCursor` = the per-schema cursor whose decoded anchor `(sort value, id)` is the **minimum under natural ascending comparison** (sort value ascending, then id ascending); merged `prevCursor` = the maximum. For today's id-based cursors this reduces to the existing `Math.min`/`Math.max`, so the approximation semantics ("any schema having more = has more") are preserved unchanged; a true k-way merge across schemas is out of scope. Note that in practice only the default direction is exercised: the all-schemas view passes no sort params, so every per-schema query uses the server default sort.

### 5. Tests (`contentService.test.ts`, `publicApi.test.ts`)

- Update the existing pagination tests for string cursors (they already round-trip `nextCursor` values through service calls and URLs; the "invalid cursor → first page" behavior must be preserved).
- **One existing test encodes today's bug and its expectation must be inverted, not just retyped:** the sorting suite's "sort composes with pagination" test sorts by a text field and asserts that page 2 is *empty* (the last row in sort order has the smallest id, so `id > cursor` finds nothing). Under correct keyset pagination, page 2 contains that row. Keeping the empty-page expectation would fail against a correct implementation.
- New walk tests per non-id sort kind — custom text field asc+desc and custom number field asc+desc: seed entries whose sort-column order deliberately disagrees with id order (e.g. create three entries, then update the oldest entry's value so it sorts last), **including at least one entry without a value for the sort field** so the NULL-aware WHERE construction from step 3 is exercised in both directions. Then walk forward from page 1 with a small limit and assert: every row appears exactly once in display order, backward navigation returns the previous page's rows, and cursors are null exactly at the ends. These tests fail on today's id-based cursor logic — that is the point.
- Note: `date` (creation_date) values are monotonic with id at insert time and cannot be made to disagree via the service API; date-sort pagination correctness follows from the shared code path exercised by the field-sort tests.

## Edge Cases

1. **Ties on the sort column** (e.g. two entries with identical field values): resolved by the `content.id T` tiebreak in display order and by the matching `<tie>` / `<tie-rev>` branches in the keyset WHERE — rows with equal sort values must never be duplicated or dropped across pages.
2. **NULL field values**: for custom-field sorts, rows whose value is NULL sort last in display order in both directions (the existing `NULLS LAST`). The keyset WHERE and the backward ORDER BY must place NULL-valued rows consistently with that in both directions; step 3 lists the required NULL-aware forms, including when the anchor row itself has a NULL value.
3. **Backward fetch ordering**: reversing a forward fetch does NOT produce the reverse of display order when there are ties on `C` or NULLs; the backward ORDER BY must be the exact reverse of `(C dir, content.id T)`, including `NULLS FIRST` where SQLite's default would not supply it (step 3).
4. **Invalid / legacy cursors**: an undecodable cursor string → first page (lenient, as today). A bare numeric id from an old client decodes fine for id sorts; for non-id sorts it simply yields the first page — acceptable, since cursors are ephemeral navigation state, not bookmarkable.
5. **`listEntries` (non-paginated) is unchanged.** Only `listEntriesPaginated` and its cursor plumbing change. Both listing endpoints (`/api/content/:schema` and `/api/schemas/:name/entries`) share this path via the service; no route-level changes beyond param parsing.

## Acceptance Criteria

1. **Server pagination correctness + no regressions.** `cd server && npx vitest run` exits 0, with a suite that includes: (a) the new walk tests from step 5 — for a custom text field (asc and desc) and a custom number field (asc and desc) over seeded data where sort order disagrees with id order **and at least one entry lacks a value for the sort field**, walking forward from page 1 with limit 2 visits every entry exactly once in display order, backward navigation returns the previous page's rows, and cursors are null exactly at the ends; (b) all pre-existing pagination and sort tests updated for string cursors, **including the inverted "sort composes with pagination" expectation** (page 2 now contains the row that today's id-cursor logic drops); (c) the preserved "invalid cursor → first page" behavior.
2. **Client type-checks.** `cd client && npx tsc --noEmit` exits 0.
3. **UI pagination still works (manual — requires a running app and a schema with enough entries to span at least two pages).** With a non-id sort selected, navigate forward and backward across pages: no duplicated or missing rows between adjacent pages, and refreshing on page 2 restores the same page from the URL.
