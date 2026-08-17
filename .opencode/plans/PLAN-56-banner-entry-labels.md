# PLAN-56 — Fix PendingDeletionBanner to show entry labels

**Goal:** Replace the `Entry #<id>` display in the "View affected entries" dialog with the entry's human-readable label (the value of the schema's first required field).

**Depends on:** none.

## Files

- `client/src/components/PendingDeletionBanner.tsx` — add `labelFieldId` prop, use `entryLabel()`
- `client/src/routes/SchemaEditorPage.tsx` — compute and pass `labelFieldId` to banner

## Steps

1. Add a `labelFieldId: number | null` prop to `PendingDeletionBanner`'s props interface.

2. In the banner's entry list rendering, replace `Entry #{entry.id}` with `entryLabel(entry, labelFieldId)`. Import `entryLabel` from `@/lib/entries`.

3. In `SchemaEditorPage.tsx`, compute `labelFieldId` from the loaded schema using `schemaLabelField(schemaQuery.data)` (import from `@/lib/entries`). Pass it as a prop to both `<PendingDeletionBanner>` instances.

## Edge cases

- Schema has no required fields — `schemaLabelField` returns the first field's id, or `null` if no fields exist. `entryLabel` falls back to `Entry #<id>` when `labelFieldId` is null.
- Entry has no value for the label field — `entryLabel` falls back to `Entry #<id>`.

## Acceptance criteria

1. `pnpm --filter client build` succeeds.
2. In the schema editor, the "View affected entries" dialog shows the entry's label value instead of `Entry #<id>` (manual verification against running server with existing entries).
3. When the label field has no stored value for an entry, the display falls back to `Entry #<id>`.
