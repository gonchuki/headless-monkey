# PLAN-37 — Gate the schema-editor entries query on pending deletions

**Depends on:** PLAN-36 (`staged-field-deletion`) — the tombstone draft state (`deleted` on `SchemaDraft`), `PendingDeletionBanner`, and the banner wiring in `SchemaEditorPage` must exist before this plan executes. Resolve the dependency at runtime: `SchemaEditorPage` derives `hasTombstones`/`tombstonedFields` and renders `PendingDeletionBanner` only when `!isCreate && !deleted && hasTombstones`.

## Goal

Stop `SchemaEditorPage` from fetching `GET /api/schemas/:name/entries` on every editor visit. The entries list is consumed only by `PendingDeletionBanner` (the "View affected entries" overlay rows), which renders only when at least one field is tombstoned. Today `useSchemaEntryCount` is already gated on `hasTombstones && !deleted`, but `useEntries` — the overlay's rows source — still fetches unconditionally, so a plain (no-tombstone) visit wastes one request, and a realtime-deleted schema visit fetches into a dead editor.

The change mirrors the existing `useSchemaEntryCount` gate: `useEntries` gains an optional `enabled` flag that defaults to the current behavior, so no other call site changes.

## Files involved

- `client/src/hooks/useEntries.ts` — `useEntries(schemaName)` gains an optional `enabled = true` parameter applied to the `listQuery` `useQuery` options. The `create`/`update`/`remove` mutations are untouched.
- `client/src/routes/SchemaEditorPage.tsx` — the `useEntries(entriesSchemaName)` call site passes `hasTombstones && !deleted` as the new second argument.
- Context only: `client/src/components/PendingDeletionBanner.tsx` (already receives `entryCount`, `entries`, `entriesPending` and handles pending data), `client/src/hooks/useSchemas.ts` (`useSchemaEntryCount` — the gate pattern to mirror).

## Implementation approach

Ordered steps; each is a unit of work, not a prescribed edit.

1. **Extend the hook.** In `useEntries`, change the signature to `useEntries(schemaName: string, enabled = true)`. In the `listQuery` `useQuery` options, replace the current `enabled: schemaName.length > 0` with a combined gate that keeps both conditions true for the data fetch (e.g. `enabled && schemaName.length > 0`). Do not change the mutation options.
2. **Gate the editor call.** In `SchemaEditorPage`, pass the same condition used by the neighboring `useSchemaEntryCount` call: `useEntries(entriesSchemaName, hasTombstones && !deleted)`. This is exactly the condition under which `PendingDeletionBanner` renders, so the data is available precisely when the overlay needs it.
3. **Verify.** Run the acceptance criteria below.

## Edge cases

- **Tombstone appears mid-edit:** the gate flips to true at the moment `MARK_FIELD_DELETED` runs, the query fires, and `PendingDeletionBanner` renders with its existing pending states (`entriesPending` is already a prop; `useSchemaEntryCount` was already gated the same way, so the count and the list appear together). No new UX gap.
- **Restore removes the last tombstone:** the gate flips back to false; the cached entry rows stay in the query cache but are no longer consumed. If the user tombstones again, re-enabling the query reuses the cached rows first; a refetch may also fire because react-query's default `staleTime` is 0 — and it is deduped against `useSchemaEntryCount` through the shared query key, so exactly one request goes out.
- **Realtime-deleted schema:** `deleted` true → gate false → no fetch into a dead editor; the existing deleted-schema banner already explains the state.
- **Create route:** `entriesSchemaName` is `""`, so the hook's `schemaName.length > 0` check keeps it disabled regardless of the new argument.
- **Other callers** (`ContentPage`, `NewContentPage`, `ContentEditorPage`): the default `enabled = true` preserves their current behavior exactly; they must not pass the new argument.
- **Cache sharing:** `useEntries` and `useSchemaEntryCount` share `queryKeys.entries(name)`. Gating both on the same condition means the shared query fires once, exactly when the banner needs it.

## Acceptance criteria

1. `pnpm --filter client build` exits 0 (runs `tsc` + `vite build`; the pre-existing 500 kB chunk warning is unrelated).
2. Manual — request gating: open the schema editor for a schema that has entries and make no edits; the Network tab shows no `GET /api/schemas/:name/entries` request for that schema. Click the Trash on a saved field; the request fires and the summary alert's "View affected entries" overlay lists the schema's entries.
3. Source — scope of the signature change: `grep -n "useEntries(" client/src` shows the `SchemaEditorPage` call is the only call site passing a second argument; all other call sites (in `ContentPage`, `NewContentPage`, `ContentEditorPage`) still pass a single argument and rely on the default. If any other site passes the new argument, that is a violation.
4. Source — gate lockstep: the `useEntries(entriesSchemaName, …)` call in `SchemaEditorPage` passes the same `hasTombstones && !deleted` condition that the `useSchemaEntryCount(entriesSchemaName, …)` call receives. The two queries share `queryKeys.entries(name)`, so the gates must stay identical: a divergence would refetch entries in the realtime-deleted case that criterion 2's manual common-path check does not exercise.

Criteria 2 is manual because the client package has no test infrastructure (`client/package.json` exposes only `dev`/`build`/`typecheck` scripts) — say so in the PR description. Criteria 3–4 are source checks because they verify intent that no test exercises.