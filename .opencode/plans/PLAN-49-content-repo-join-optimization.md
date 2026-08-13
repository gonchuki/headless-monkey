# PLAN-49 — Eliminate N+1 queries in ContentRepository.listEntries with JOINs

## Goal

`ContentRepository.listEntries()` executes 1 + 2N queries: one query for content records, then two queries per record for `content_rows` and `content_refs`. Replace with batch JOIN queries that fetch all data in 3 queries total (1 for records, 1 for all rows, 1 for all refs), grouped in JavaScript.

## Files involved

- `server/src/repositories/contentRepo.ts` — `listEntries()` method; rewrite the query strategy
- `server/src/services/contentService.ts` — `toEntry()` consumes `ContentEntryRow` with `rows` and `refs` arrays; no changes needed if the returned shape is preserved

## Implementation approach

1. Keep the initial query for content records unchanged (it already uses a subquery for `referencer_count`).

2. Replace the per-record row queries with a single batch query using an IN clause on all content IDs from the records query. If there are zero records, skip this query entirely.

3. Replace the per-record ref queries with a similar single batch query using an IN clause.

4. Group the batch results by `content_id` in JavaScript and build `ContentEntryRow` objects by mapping over records and attaching the grouped rows/refs. Entries with no rows or refs should have empty arrays (matching current behavior).

## Edge cases

- **Zero entries**: The `IN (?, ?, ...)` clause would be empty. Guard against this — if `records.length === 0`, return early with an empty array.
- **Entries with no rows or refs**: The grouped maps won't have entries for these content_ids. Use `?? []` to provide empty arrays, matching the current behavior.
- **Large entry counts** (thousands): The `IN` clause with many parameters is fine for SQLite — it handles parameter binding efficiently. No pagination is needed per spec (non-goal §3).
- **Ordering**: The current code orders rows/refs by `field_id`. Preserve this by including `ORDER BY content_id, field_id` in the batch queries and relying on the grouped iteration order.

## Acceptance criteria

1. `listEntries()` returns the same data shape (`ContentEntryRow[]` with `record`, `rows`, `refs`) as before — consumers see no difference.
2. For a schema with N entries, exactly 3 queries are executed (1 for records, 1 for rows, 1 for refs) instead of 1 + 2N.
3. Entries with no rows or refs have empty arrays in the response (not undefined).
4. The existing test suite passes — no regression in content listing flow.
5. Query count instrumentation for a schema with N entries shows exactly 3 queries executed (1 for records, 1 for rows, 1 for refs) instead of 1 + 2N.
