# PLAN-48 — Exclude conflicted entries from schema-ref dropdown

## Goal

`ReferenceSelect.tsx` fetches all entries for a target schema (including conflicted ones) and renders them as selectable options in the schema-ref `<select>`. A conflicted entry's data may be invalid for its current schema version, so referencing it creates a broken reference. Filter out conflicted entries from the dropdown, matching the pattern already used in `ContentPage.tsx` for the conflicted-only toggle.

## Files involved

- `client/src/components/ReferenceSelect.tsx` — filter `entries` before rendering `<SelectItem>` elements
- `client/src/hooks/useEntries.ts` — no changes needed; the `conflict` field is already included in `ContentListEntry`
- `server/src/services/contentService.ts` — no server-side changes needed; the editor endpoint already returns the `conflict` boolean

## Implementation approach

1. Filter out entries where `conflict` is true before rendering them as `<SelectItem>` options. Use the filtered list for the dropdown options instead of the raw entries array.

2. Distinguish between two empty states in the placeholder: "no entries at all" (existing behavior) vs. "all entries are conflicted" (new state). The latter should communicate that valid targets exist but are currently unavailable due to conflicts.

3. If the currently selected value references a conflicted entry, the `<Select>` will show that entry's label even though it's not in the options list. This is standard select behavior and acceptable — the user sees their current selection and can change it.

## Edge cases

- **All entries are conflicted**: The dropdown shows no options. The required field validation will prevent saving with an empty schema-ref. This is correct behavior — the user must resolve conflicts before creating new references.
- **Selected value is a conflicted entry**: The `<Select>` component may show the selected value even if it's not in the options list. This is standard select behavior and acceptable — the user sees their current (conflicted) selection and can change it.
- **Optional schema-ref with no valid targets**: The `[empty]` option is still available for optional fields. This is correct — the user can leave the ref empty.

## Acceptance criteria

1. Opening a schema-ref field's dropdown shows only non-conflicted entries as options.
2. If all entries in the target schema are conflicted, the dropdown shows no selectable entries (but the `[empty]` option for optional fields).
3. A required schema-ref with no valid targets is disabled (existing behavior from `field.required && entries.length === 0` check) — verify this still works with the filtered list.
4. The existing test suite passes — no regression in schema-ref selection flow.
