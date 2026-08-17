# Add GET /api/entries/:id and stop full-list fetches on single-entry screens

**Depends on PLAN-72 (reset the entry editor on external change).** The editor's `loadKey` must already include `last_modified_date`, and this plan's single-entry query must be keyed under the `queryKeys.entries(schema)` prefix so that realtime invalidation refetches it and the form resets on external change. Verify the PLAN-72 reset still works end to end after this plan lands.

## Goal

The server has no single-entry route, so single-entry screens download whole schemas:

- `ContentEditorPage` mounts `useEntries(schemaName)` and `.find()`s its entry — every entry of the schema, re-downloaded on every realtime invalidation.
- `SchemaEditorPage`'s tombstone banner triggers **two** full entry fetches: `useSchemaEntryCount` and `useEntries` cache the same endpoint under different query keys.
- `ContentPage`'s delete dialog mounts a full `useEntries(entryToDelete.schema)` whose only purpose is the pre-wired remove mutation.

Fix: add `GET /api/entries/:id` (editor shape), a standalone delete-entry mutation hook, and drop the redundant banner query. Cross-package: server + client.

## Contract

- `GET /api/entries/:id` returns **200** with the editor-shape list entry — `values` keyed by `String(field_id)`, schema-ref values as raw target content ids, `conflict` and `referencer_count` present (exactly the shape one row of the editor list route returns) — and **404** for an unknown id.
- **No 422 for conflicted entries.** The editor is the repair surface for conflicts; 422-ing them would break the resolve-and-save flow.
- The single-entry query key includes the URL schema so it sits under the `queryKeys.entries(schema)` prefix — realtime invalidation and mutation `onSettled` invalidation both use that prefix. The id is the data's identity; the schema in the key is only for invalidation routing.
- `SPEC.md` §4 (editor content API line) gains `GET /api/entries/:id`.

## Files

Server:
- `server/src/services/contentService.ts` — new `getEditorEntry(entryId)` method.
- `server/src/routes/entries.ts` — new `GET /:id` route. Note the same router instance is mounted at both `/api/schemas/:name/entries` and `/api/entries`; a `/:id` route also matches a (currently meaningless) `/api/schemas/:name/entries/<id>` path — harmless, no ordering conflict with `/`.
- `server/test/publicApi.test.ts` — tests, alongside the existing "editor content CRUD" / guard blocks.

Client:
- `client/src/lib/query.ts` — new `entry(schema, id)` key under the `entries(schema)` prefix.
- `client/src/hooks/` — new file with two mutation-only hooks (no query mounted):
  - `useDeleteEntry` — vars `{ id, schema }`; `DELETE /api/entries/:id`. Optimistic: remove the entry from **every** query under the `queryKeys.entries(schema)` prefix (use `setQueriesData` on that prefix; handle both list cache shapes — flat `ContentListEntry[]` and `{ entries, pagination }` — and leave single-entry detail objects untouched: they self-heal on refetch, and navigating to a deleted id 404s into the not-found screen anyway), capturing previous data for rollback. Invalidate the prefix on settle.
  - `useUpdateEntry` — vars `{ id, schema, values }`; `PATCH /api/entries/:id`. Invalidate the prefix on settle. No optimistic cache write: the editor navigates away on success and lists refetch via invalidation, so there is no user-visible stale state to patch.
- `client/src/routes/ContentEditorPage.tsx` — single-entry query replaces `useEntries` + `.find()`.
- `client/src/routes/ContentPage.tsx` — delete dialog uses `useDeleteEntry` instead of mounting `useEntries(entryToDelete?.schema ?? "")`.
- `client/src/routes/SchemaEditorPage.tsx` — drop the `useSchemaEntryCount` call; derive the banner's entry count from the entries list. **Keep the `useSchemaEntryCount` hook itself** — `SchemasPage` still uses it for the schema-delete dialog.
- `client/src/hooks/useEntries.ts` — after the callers above are migrated, remove the `update` and `remove` mutations from the hook and its result type (both become dead code; `create` stays — `NewContentPage` uses it).
- `SPEC.md` — §4 editor content API line.

## Steps

1. Server: `getEditorEntry(entryId)` — 404 (`ContentServiceError`) when unknown; otherwise `toEntry(row, schema, includeConflict=true, "editor")` with the schema resolved from the entry's own `schema` column (the route takes no schema param).
2. Server: `GET /:id` route on the entries router with `validateNumericParam("id")`.
3. Server tests: 200 with editor shape for an existing entry (assert `values` keyed by `String(field_id)`, `conflict` present, a schema-ref value serialized as the raw target id); 404 for an unknown id; a conflicted entry returns 200 with `conflict: true` (not 422); auth guards behave like the other editor routes (401 unauthenticated, 403 admin token — follow the existing guard test block).
4. Client: add the `entry(schema, id)` query key.
5. Client: the two standalone mutation hooks in a new file.
6. Client: `ContentPage` delete flow on `useDeleteEntry` (mutate with `{ id, schema: entryToDelete.schema }`).
7. Client: `SchemaEditorPage` banner — remove the redundant count query; pass the count as `entriesPending ? undefined : entriesList.length` so the banner hides the count line while loading, exactly as today.
8. Client: `ContentEditorPage` on the single-entry query (enabled once schema name and id are present). Keep the `loadKey` composition from PLAN-72 unchanged.
9. Client: remove `update`/`remove` from `useEntries`.
10. Update §4 in `SPEC.md`.

## Edge cases

- Hand-crafted URL `/content/:wrongSchema/:id` where the entry belongs to a different schema: today `.find()` fails and the page renders "Entry not found". Preserve that — after the fetch, if `entry.schema` differs from the URL schema, render the not-found screen. (The query is keyed by the URL schema, so in this mismatch case data caches under the wrong prefix; harmless, since the screen shows not-found.)
- Realtime `entry.deleted` while editing: the detail query refetches → 404 → "Entry not found" screen (today the entry vanishes from the list → same screen). Treat a failed detail fetch as the not-found screen — that matches today's de-facto behavior when the list fetch fails.
- Realtime `entry.updated` by another editor: refetch → `last_modified_date` changes → the PLAN-72 `loadKey` resets the form. This is the integration point — verify the reset end to end.
- The optimistic delete must cover every cache shape under the prefix: `ContentPage`'s selected view (flat or paginated depending on cursor state), the all-schemas per-schema queries, and `ReferenceSelect`'s bare-prefix query.
- `ReferenceSelect` still full-list-fetches each referenced schema — dropdown options genuinely need the list; unchanged and out of scope.
- `useEntries`'s own `onSettled` invalidations already use the prefix, so list views keep working after steps 6–9; the only behavior change is that the delete dialog no longer mounts a full list query.

## Acceptance criteria

1. `pnpm --filter server test` passes, including the new tests.
2. New server tests: `GET /api/entries/:id` returns 200 with the editor shape for an existing entry; 404 for an unknown id; a conflicted entry returns 200 with `conflict: true`.
3. `pnpm --filter client typecheck` passes.
4. Manual (client has no test harness in this repo): open the editor for one entry of a schema holding many entries. The network panel shows `GET /api/entries/:id` — not `GET /api/schemas/:name/entries` — on load, and again (not the list endpoint) after another editor saves to the same entry.
5. Manual: with the schema editor showing a staged field deletion, the banner shows the entry count and its "View affected entries" overlay works, and the network panel records **one** `GET /api/schemas/:name/entries` for the banner (not two). The delete flow from the content list still removes the entry optimistically, toasts on success, and surfaces server errors in the dialog.
