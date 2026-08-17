# PLAN-55 — Add optimistic update for schema create

**Goal:** Eliminate the flash-of-empty-state after creating a schema by adding an optimistic cache update in the `create` mutation's `onMutate` callback. Matches the pattern already used by the `delete` mutation.

**Depends on:** none.

## Files

- `client/src/hooks/useSchemas.ts` — update `createMutation.onMutate`

## Steps

1. In the `createMutation`'s `onMutate` callback, after canceling queries and snapshotting `previous`, insert the optimistic schema into the cache:
   - Construct a partial `SchemaEntry` from the `input` fields: `{ name: input.name, fields: input.fields.map((f, i) => ({ ...f, id: -(i + 1), sort_order: i })), version: 1, compat_version: 1, creation_date: new Date().toISOString(), created_by: "you", last_modified_date: new Date().toISOString(), last_modified_by: "you" }`. The negative `id` values mark these as temporary client-side placeholders — the server response will replace them on `onSettled` invalidation.
   - Call `queryClient.setQueryData<SchemaEntry[]>(queryKeys.schemas(), (old) => [...(old ?? []), optimisticSchema])`.

2. The `onError` rollback already restores `context.previous` — no change needed there.

3. The `onSettled` invalidation already refetches the real list — no change needed there. The temporary optimistic entry will be replaced by the server-truth data.

## Edge cases

- Create fails (409 duplicate name, 422 validation) — `onError` rolls back to `previous`, removing the optimistic entry.
- Multiple rapid creates — each `onMutate` snapshots the current cache (which includes prior optimistic entries), so rollback is correct.

## Acceptance criteria

1. `pnpm --filter client build` succeeds.
2. After creating a schema, the new schema appears immediately in the list without a flash of empty state (manual verification).
3. If create fails (e.g. 409), the optimistic entry is removed and the list reverts to its previous state (manual verification).
