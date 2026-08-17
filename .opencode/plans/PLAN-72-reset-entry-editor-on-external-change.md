# Reset the entry editor on external change (lost-update protection)

## Goal

When another editor saves changes to an entry while `ContentEditorPage` is open, the form must reset loudly to the new server state. Today the form-reset key (`loadKey`) covers only the entry id, the `conflict` flag, and the entry's `schema_version`. A plain value save by another editor changes none of those, so after the realtime invalidation refetch the second editor's form keeps showing the stale values — and since the form always submits a full payload, that stale save silently clobbers the first editor's change.

The proper server-side fix (version-preconditioned PATCH returning 409 on a stale version) is an API-contract change and is explicitly out of scope; this plan closes the gap client-side by making the reset key sensitive to any change of the stored row.

## Files

- `client/src/routes/ContentEditorPage.tsx` — the only file that changes. The `loadKey` string is built right before `handleSubmit`, from the found entry's `id`, `conflict`, and `schema_version`.
- Read-only context: `client/src/components/DynamicEntryForm.tsx` (the reset mechanism), `client/src/hooks/useRealtime.ts` (what invalidates the entries query), `client/src/hooks/useEntries.ts` (the query the editor reads), `server/src/repositories/contentRepo.ts` (`replaceRows` — why the timestamp is a reliable change indicator).

## How the mechanism works (needed to verify the plan, not to re-derive it)

- `DynamicEntryForm` resets its form state and clears validation errors in a `useEffect` keyed on the `loadKey` prop. A change of `loadKey` is the only reset trigger.
- `useRealtime` invalidates queries under the `queryKeys.entries(schemaName)` prefix on other editors' `entry.*` and `schema.updated` events, so the entries data the editor reads is refetched after an external save.
- The server bumps `last_modified_date` unconditionally on every successful entry PATCH (`contentRepo.replaceRows` sets it to "now" in the same statement that writes the new version), so the timestamp changes on *every* external save, including a no-op save of identical values.

## Steps

1. Include the entry's `last_modified_date` in the editor's `loadKey` (append it to the existing `id:conflict:schema_version` composition). `last_modified_date` is already present on the list-entry type the editor consumes — no type or API change is needed.
2. Preserve (do not weaken) the two invariants the reset depends on:
   - The query that feeds the editor's entry must remain invalidated under the `queryKeys.entries(schemaName)` prefix by the realtime hook.
   - `loadKey` must change whenever the stored row changes.
   A later plan changes the editor's data source from the full-list query to a single-entry route; that change is only safe if both invariants survive it.

## Edge cases

- A no-op save by the other editor (identical values) still bumps `last_modified_date`, so this editor's form resets anyway. That is intended: any save by someone else is a reload signal.
- An external schema update that flips the entry's `conflict` flag is already covered: `conflict` is in `loadKey`, and the refetch recomputes it server-side (`schema_version < compat_version`).
- External *deletion* of the open entry already renders the "Entry not found" screen (the entry disappears from the fetched data); that behavior is unchanged.
- The editor's own save never triggers a reset: it navigates to the list on success.
- Timestamps are ISO strings with millisecond precision; two saves inside the same millisecond are indistinguishable. Acceptable.

## Acceptance criteria

1. `pnpm --filter client typecheck` passes.
2. Manual (the client package has no test harness in this repo — there is no test runner configured, so verify by hand): seed a schema with one entry; open the editor for that entry as editor user B; make an unsaved edit; then save a value change to the same entry as a *different* editor user A (a second browser context with another editor account, or a direct `PATCH /api/entries/:id` call with a second editor's token — realtime events from the same user are ignored by design, so the saving identity must differ from the one viewing). User B's form must now show A's saved values with B's unsaved edits discarded (no success toast in B).
3. Manual regression: the conflicted-entry flow still works end to end — make an entry conflicted (e.g. `PATCH /api/schemas/:name` adding a required field, which conflicts every existing entry), open it, resolve the affected fields, save, and the success toast appears and the entry is no longer marked conflicted in the list.
