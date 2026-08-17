# Filter Conflicted Entries in SQL for Paginated Public Listings

> **Dependency:** This plan assumes **PLAN-66-spec-v012-pagination-contract.md** has been executed — specifically its decision to *keep* pagination on the public routes (bless). Verify before starting: `SPEC.md`'s title line reads v0.12 and §3 contains "No search in the data API." (not "No pagination"). If the spec instead restored "No pagination or search in the data API.", the approach below is wrong and this plan must not be executed as written.

## Goal

`ContentService.listPublic`'s paginated path pages first and then drops conflicted rows in JS: the repository returns up to `limit` rows *including* conflicted entries, and the service filters them out afterward. With 4 valid + 3 conflicted entries and `limit=5`, the page returns 4 entries while `nextCursor` is still set — arbitrarily short pages, and cursors that can point past the last valid entry. Push the compat filter (`schema_version >= compat_version`) into the repository query so a public page holds up to `limit` *valid* entries and cursor detection agrees.

## Files Involved

- `server/src/repositories/contentRepo.ts` — `listEntriesPaginated`, `listEntries`, and the private `keysetExists` probe.
- `server/src/services/contentService.ts` — `listPublic`.
- `server/test/contentService.test.ts` — new regression tests (fixture recipe below).

## Implementation Approach

1. **Repository: optional `minVersion` filter.** Add an optional `minVersion?: number` parameter to `ContentRepository.listEntriesPaginated` (after the existing sort parameter) and to `ContentRepository.listEntries`. When defined, the page SELECTs (all three branches: first-page, forward, backward) and the `keysetExists` existence probe carry the parameterized predicate `AND content.schema_version >= ?`. `keysetExists` needs the same optional parameter threaded through — without it, cursor detection still sees conflicted rows and emits cursors that lead to short or empty pages, leaving the bug alive in a different form.

2. **Service: pass the filter, drop the JS filter.** In `ContentService.listPublic`, pass `schema.compat_version` as `minVersion` on both the paginated and the non-paginated path, and remove the JS-side `.filter(...)` compat check on both paths (single mechanism; the non-paginated path's observable output is unchanged — same rows, same order).

   Invariants:
   - `listForSchema` (editor path) passes no `minVersion` — editor listings keep returning **all** entries including conflicted ones, each with its `conflict` flag.
   - `getPublic` (single-entry route) is unchanged: 404 unknown id, 422 conflicted.
   - Cursor encoding is unchanged: opaque `(sort value, entry id)` pairs.

3. **Tests** in `contentService.test.ts`, next to the existing "listPublic pagination returns only compat entries" test. Shared fixture recipe: create a schema with one required text field; create N entries; apply a breaking schema update that adds a required field (this sets `compat_version` to the new `version`, making every existing entry conflicted); then update a chosen subset of entries with a value for the new required field (those become valid). Update the *alternate* entries so valid/conflicted interleave by id. Derive the new field's id from the updated schema (`schemaService.get(...)`) rather than hardcoding it. **Use an explicit `{ sortField: "id", sortOrder: "asc" }` in every new test** — the default `modified desc` sort clusters the just-updated (valid) entries at the front and hides the bug.

   New tests:
   - **Regression (the verified scenario).** 4 valid interleaved with 3 conflicted (7 total). `listPublic(schema, { limit: 5 }, { sortField: "id", sortOrder: "asc" })` returns exactly the 4 valid ids in ascending order, and `pagination.nextCursor` is null. (Pre-fix behavior: 3 entries with `nextCursor` set.)
   - **Page fullness + walk.** 6 valid interleaved with 5 conflicted (11 total), same limit/sort: page 1 = the first 5 valid ids with `nextCursor` set; following `nextCursor`, page 2 = the remaining valid id with `nextCursor` null; no conflicted id appears in any page.
   - **All conflicted.** Every entry conflicted, `limit` 10: empty entries, both cursors null.
   - **Editor path unaffected.** The interleaved fixture via `listForSchema` with the same limit/sort returns 5 entries including conflicted ones, `nextCursor` set.

## Edge Cases

1. **The `keysetExists` probe** (step 1) is the part most likely to be missed — it computes `nextCursor`/`prevCursor` existence and must respect the filter exactly like the page SELECTs.
2. **All entries conflicted** hits the repository's zero-rows early return; cursors must come back null, not dangling.
3. **A cursor anchored on an entry that is now conflicted** (concurrent schema change between page loads): the keyset condition still anchors correctly; the page may be short or empty. Acceptable — same class as any concurrent modification; no special handling.
4. **Custom-field sorts use a `LEFT JOIN`** for the sort column; the predicate is on `content.schema_version` and is orthogonal to the join — but verify the joined SELECT still works with the added predicate.
5. **The `limit + 1` probe-row mechanism is unchanged**; `hasMore` now simply reflects valid rows only.
6. The existing test "listPublic pagination returns only compat entries" passes both before and after the fix (it never asserted page fullness) — it must remain green **unmodified**.

## Acceptance Criteria

1. **New behavior pinned, no regressions.** `cd server && npx vitest run` exits 0, with the contentService suite containing: (a) the regression test — 4 valid interleaved by id with 3 conflicted, limit 5, id ascending → exactly the 4 valid ids in order, `nextCursor` null; (b) the walk test — 6 valid interleaved with 5 conflicted, limit 5, id ascending → page 1 is the first 5 valid ids with `nextCursor` set, page 2 via the cursor is the remaining valid id with `nextCursor` null, and no conflicted id appears in any page; (c) the all-conflicted test — empty entries, both cursors null; (d) the editor-path test — interleaved fixture via `listForSchema`, limit 5, id ascending → 5 entries including conflicted, `nextCursor` set. All pre-existing tests pass unmodified, including "listPublic pagination returns only compat entries" and the publicApi pagination suite.
2. **Type-checks.** `cd server && npx tsc --noEmit` exits 0.
3. **The filter lives in SQL.** `grep -n "\.filter(" server/src/services/contentService.ts` returns no matches (the JS-side compat check is gone; the predicate is in the repository query).
