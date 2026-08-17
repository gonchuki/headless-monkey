# Server-side conflicted-only filter for content listings

## Goal

The "Conflicted content only" toggle on the content list currently filters the *current server page* client-side (`visibleEntries` in `ContentPage`). That makes pages look arbitrarily sparse, and because the list+pagination block is gated on the filtered entries, a page whose entries are all non-conflicted shows only the "No conflicted entries" alert with **no pagination controls** — the user is stranded and cannot reach other pages that may contain conflicts.

Fix: add a `?conflicted=1` parameter to the editor entries route so the filter is applied server-side (before pagination), and point the client toggle at it. Render pagination whenever the underlying (already filtered) page has entries. Cross-package: server + client.

## Contract

- `?conflicted=1` turns the filter on; any other value (absent, `0`, garbage) turns it off. Lenient, no 422 — matching the leniency of `parsePaginationParams`.
- Filter semantics: an entry is conflicted iff `content.schema_version < schema.compat_version` — the same comparison the service already uses to compute the per-entry `conflict` flag. The filter must be implemented in SQL so keyset pagination and cursor probes see the filtered set.
- The public content routes are unchanged (they already exclude conflicted entries entirely).
- `SPEC.md` §4 (the editor content API line listing `GET /api/schemas/:name/entries`) is updated in this plan to note the new parameter.

## Files

Server:
- `server/src/routes/paramValidation.ts` — a parser for the new query param, alongside `parsePaginationParams` / `parseSortParams`.
- `server/src/repositories/contentRepo.ts` — `listEntries`, `listEntriesPaginated`, and the `keysetExists` probe.
- `server/src/services/contentService.ts` — `listForSchema` (note: this method carries a pile of overloads for the pagination/sort argument juggling; the flag must reach every repo call path).
- `server/src/routes/entries.ts` — the list route (`GET /` on the router mounted at `/api/schemas/:name/entries`).
- `server/test/publicApi.test.ts` — tests; the existing "editor content CRUD" and "pagination" describe blocks are the home for editor-route tests.

Client:
- `client/src/hooks/useEntries.ts` — optional conflicted argument → query key + URL param.
- `client/src/hooks/useAllEntries.ts` — same treatment (it builds one query per schema).
- `client/src/routes/ContentPage.tsx` — pass the toggle state into both hooks; drop the client-side filter; fix the empty-state and pagination gating.
- `SPEC.md` — §4 editor content API line.

## Steps

1. Server: add a param parser (e.g. `parseConflictedParam(req): boolean`) — `req.query.conflicted === "1"` is on, anything else off.
2. Server: thread the filter through the repo. `listEntries` and `listEntriesPaginated` take an optional filter argument carrying both the flag and the conflict threshold (the schema's current `compat_version` — the service already has it; the repo does not load schemas itself). When active, the SQL gains `AND content.schema_version < ?` bound to that threshold. It must apply to **every** SELECT branch of `listEntriesPaginated` (first page, forward, backward) **and** to the `keysetExists` probe — a probe that misses the filter computes wrong next/prev cursor presence for filtered pages.
3. Server: thread the flag through `listForSchema` to all of its repo call paths. The service already loads the schema (for `compat_version`) before calling the repo.
4. Server: accept the param on the list route and pass it down.
5. Server tests (in `server/test/publicApi.test.ts`, following the existing harness: `createApp` + supertest + editor token). To build a deterministic mix of conflicted and non-conflicted entries: create a schema and N entries; `PATCH /api/schemas/:name` to **add a required field** (a breaking change per R14 — every existing entry lacks it, so all N become conflicted); then `PATCH /api/entries/:id` on one entry supplying the new field in `values` (that entry's `schema_version` becomes current and it is no longer conflicted). Result: N−1 conflicted, 1 clean.
   - With that mix, `?conflicted=1` returns exactly the conflicted set; without the param the full set is returned (existing behavior unchanged).
   - The filter composes with `limit`/`cursor`: with enough conflicted entries to span more than one page, walking forward under `?conflicted=1` visits each conflicted entry exactly once, and `nextCursor` is null on the last filtered page.
   - The filter composes with `sort_field`/`sort_order`.
6. Client: `useEntries` gains an optional `conflicted` argument. When true, append a marker to the query key and set `conflicted=1` in the request URL. **Unfiltered requests must produce exactly the query keys and URLs they produce today** — existing cache behavior must not change, so add the marker only when the filter is on.
7. Client: `useAllEntries` gets the same treatment per schema (key + URL param).
8. Client: `ContentPage` — pass `conflictedOnly` into both hooks; delete the client-side `visibleEntries` filter (the data arrives pre-filtered); render the list+pagination block when the entries are non-empty (they now are the filtered set); merge the two empty states into one — entries empty renders "No conflicted entries…" when the filter is on and "No entries yet…" otherwise.
9. Update the §4 editor content API line in `SPEC.md` to record `?conflicted=1`.

## Edge cases

- The toggle handler, schema-change handler, and sort handlers already navigate with the right `conflicted=1` URL state (the toggle resets cursors; `buildPageUrl` carries the param). No navigation-URL changes are needed — verify, don't rewrite.
- Cursor URLs never cross a filter toggle via the UI (the toggle drops cursors). If one did (hand-edited URL), the keyset anchor degrades leniently against the filtered set — no duplicates or gaps on a static dataset.
- The all-schemas view merges per-schema pages with existing merge logic; each per-schema query simply carries the filter. No merge changes needed.
- `ReferenceSelect` keeps its own client-side `!entry.conflict` filtering — unaffected and out of scope.
- After this change, "No conflicted entries" means "none in the whole schema set", not "none on this page" — that is the point of the fix.

## Acceptance criteria

1. `pnpm --filter server test` passes, including the new tests.
2. New server test: a schema with a known mix of conflicted/non-conflicted entries returns exactly the conflicted set under `?conflicted=1` and the full set without the param (one test may assert both halves).
3. New server test: a forward cursor walk under `?conflicted=1` with a small `limit` (forcing multiple pages) visits each conflicted entry exactly once across pages, with `nextCursor` null on the last filtered page.
4. `pnpm --filter client typecheck` passes.
5. Manual (client has no test harness in this repo): with the toggle on, only conflicted entries render and pagination navigates the filtered set; toggling off restores the full list; the stranded-empty-page state (alert without pagination controls) no longer occurs.
