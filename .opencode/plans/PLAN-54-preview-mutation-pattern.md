# PLAN-54 — Replace useSchemaPatchPreview useQuery-for-PATCH

**Goal:** Replace the `useSchemaPatchPreview` hook that misuses `useQuery` to issue a PATCH request. A PATCH is a side-effecting operation — even when it's a dry-run — and should use `useMutation` with manual invocation via `mutateAsync`.

**Depends on:** none.

## Files

- `client/src/hooks/useSchemas.ts` — rewrite `useSchemaPatchPreview`
- `client/src/routes/SchemaEditorPage.tsx` — update consumer to use mutation pattern

## Steps

1. Replace `useSchemaPatchPreview` with a `useMutation`-based hook. The new hook:
   - Accepts `(name: string, fields: SchemaFieldInput[])` as mutation variables.
   - Returns `{ mutateAsync, isPending, data, error, reset }` (the standard mutation interface).
   - Does NOT use a query key — mutations don't have query keys.
   - The `mutationFn` calls `apiFetch<SchemaUpdatePreview>(...)` with `method: "PATCH"` and `?preview=true`.

2. Update `SchemaEditorPage.tsx` to use the new mutation pattern:
   - Instead of calling `previewQuery.refetch()` to trigger the preview, call `previewMutation.mutateAsync({ name, fields })`.
   - Instead of reading `previewQuery.data`, read `previewMutation.data`.
   - Instead of checking `previewQuery.isFetching`, check `previewMutation.isPending`.
   - The preview is triggered on save (when the user clicks Save), not reactively when fields change. This matches the existing flow: the user edits fields, clicks Save, the preview fires, and if breaking the confirmation dialog opens.

3. Remove the `schemaPreview` query key from `query.ts` (no longer needed).

## Edge cases

- User clicks Save multiple times rapidly — the mutation should deduplicate (TanStack Query handles this for mutations by default).
- Preview request fails (422 validation error) — `previewMutation.error` should carry the error, and the existing error handling in the save flow should surface it.

## Acceptance criteria

1. `pnpm --filter client build` succeeds.
2. `grep -r "useQuery.*preview" client/src/` returns no matches — the useQuery-for-PATCH pattern is gone.
3. The schema save flow still works: non-breaking saves apply immediately; breaking saves show the confirmation dialog with affected entries (manual verification against running server).
