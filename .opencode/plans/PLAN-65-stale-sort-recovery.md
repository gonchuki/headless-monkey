# PLAN-65 — Recover from a stale sort_field param instead of a 422 dead end

**Depends on PLAN-63** (client test harness, for the unit tests of the new helpers). Independent of PLAN-64.

## Goal

When the URL carries a sort param the schema can no longer honor — a field deleted by another editor, or a bookmark carrying `?sort_field=<deleted-id>` — every list request 422s and the listing shows an error alert whose Retry button can never succeed, because it refetches with the same URL params. The server sources of this dead end:

- `ContentService.resolveSort` (`server/src/services/contentService.ts`): `Unknown sort field_id: <id>` (field gone), and `Cannot sort by field '<label>' (type: …)` (field exists but is boolean/schema-ref — not sortable).
- `parseSortParams` (`server/src/routes/paramValidation.ts`): `Invalid sort_field: …` / `Invalid sort_order: …` (malformed tokens from a hand-edited URL).

All four are the same class: *the URL's sort params are unusable for this schema; dropping them is the correct recovery.* The client should detect this specific error on the listing query and rewrite the URL to drop the invalid sort params, falling back to the default sort. The server is **not** changed (its messages are the contract the matcher relies on, and SPEC §4 contracts are frozen).

## Files

- `client/src/lib/sortRecovery.ts` — **new.** Pure helpers, no React:
  - `isStaleSortError(error: unknown): boolean`
  - `dropSortParams(params: URLSearchParams): URLSearchParams | null`
- `client/src/routes/ContentPage.tsx` — a small effect wiring detection → navigation.
- `client/test/sortRecovery.test.ts` — **new** suite.

## Approach (ordered)

1. **`isStaleSortError`.** True only for an `ApiError` (from `client/src/lib/api.ts`) with `status === 422` whose message starts with one of: `Unknown sort field_id:`, `Cannot sort by field`, `Invalid sort_field:`, `Invalid sort_order:`. Anything else — other 422s (e.g. `Missing required field …`), other statuses, non-`ApiError` values — is false.
2. **`dropSortParams`.** Returns a new `URLSearchParams` with the `sort_field` and `sort_order` keys removed and every other param preserved, or `null` when neither key is present (the no-op guard).
3. **The effect in `ContentPage`.** When the listing query has errored (the same `entriesIsError`/`entriesError` values the existing error alert renders) and `isStaleSortError` matches and the current URL actually contains sort params, navigate to the rewritten URL with `{ replace: true }`.
   - Loop safety is structural: after the rewrite the sort params are gone, so the guard fails and the effect can never navigate again for this error. The rewritten URL also changes the listing query's key (`useEntries` includes the sort params in its query key), so a fresh, valid fetch runs and the alert clears.
   - The all-view never sends sort params (it cannot produce this error); the effect is harmless there.
   - The existing Retry button and alert are kept for every other error, unchanged.

## Tests

- `isStaleSortError`: true for each of the four messages (with realistic suffixes, e.g. `Unknown sort field_id: 42`, `Cannot sort by field 'Active' (type: boolean)`); false for other 422 messages (`Missing required field 'X'`, `Entry 5 not found`-style), for `ApiError` with other statuses carrying a matching-looking body, for plain `Error`, and for `null`/`undefined`.
- `dropSortParams`: drops both sort keys while preserving other params (e.g. `conflicted`, `cursor_next`, `page`); returns `null` when no sort param is present; never mutates its input.

## Edge cases (found while exploring)

- **Deep page + stale sort.** The user may sit on a paginated page when the sort goes stale. The cursor params survive the rewrite; the server treats a cursor that doesn't match the new sort as "no cursor" (first page — the lenient fallback in `contentRepo.listEntriesPaginated`), so the list lands on page 1 of the default sort. Self-healing; no extra handling.
- **Sort selector after recovery.** The selector derives its value from the URL sort state; with the params gone it falls back to the default token and renders "Modified date". No additional sync needed.
- **The rewritten request still sends a valid sort.** `ContentPage` always sends a sort in the single-schema view (defaulting to the `modified` token when the URL has none), so the post-rewrite fetch is well-formed by construction — the recovery target is never itself an error.
- **Idempotence.** A second stale-sort error after recovery (e.g. the default sort itself can't go stale, but a user re-adding an invalid param via URL) re-triggers cleanly: the guard requires sort params in the URL, which the rewrite removed.

## Acceptance criteria

1. `pnpm --filter client test` exits 0 and the new sort-recovery suite passes (matcher positives for all four messages and the listed negatives; drop-helper preservation and no-op cases).
2. `pnpm --filter client typecheck` exits 0.
3. `pnpm -r test` exits 0 (server suites remain green).
4. **Manual (cannot be verified mechanically; verify in a browser):** with the app running, open `/content/<schema>?sort_field=<id>` where `<id>` is a field you then delete through the schema editor (or use a bookmark with a deleted field id): the listing recovers to the default sort without the error alert, the sort selector shows "Modified date", and the URL no longer carries sort params. Separately, a genuine non-sort failure (e.g. server stopped) still shows the error alert with a working Retry button.
