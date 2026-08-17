# PLAN-41: Client Sorting

## Goal

Add sort selector UI to content listings in the control panel. Users can choose which field to sort by and the sort direction. Sort state persists in URL params for bookmarking and sharing.

**Depends on:** PLAN-39 (client pagination hooks must exist) and PLAN-40 (server sorting must be implemented).

## Files Involved

- `client/src/routes/ContentPage.tsx` — sort selector UI
- `client/src/hooks/useEntries.ts` — sort params in API requests
- `client/src/hooks/useAllEntries.ts` — sort params in API requests

## Implementation Approach

### 1. Update `useEntries` hook

Add sort state management:
- Read `sort_field` and `sort_order` from URL search params
- Pass to API requests as query params
- Expose `setSortField(fieldId)`, `setSortOrder(order)` methods
- Track available sortable fields from schema (text, number, date fields plus 'id' and 'date')

### 2. Update `useAllEntries` hook

Same sort state management as `useEntries`. Sort applies uniformly across all schemas in the merged view.

### 3. Add sort selector to `ContentPage.tsx`

Add shadcn `<Select />` component in the filter bar (next to schema selector and conflicted toggle):
- Options: "Newest first" (default, sorts by id desc), "Oldest first" (id asc), "Created date" (creation_date), plus each sortable field from the schema
- Field options show the field label with type indicator (e.g., "Name (text)", "Price (number)")
- Sort order toggle (asc/desc arrow) next to selected field
- Sort selector appears only when a schema is selected (not in "All schemas" view initially—can be added later)

URL state shape: `?sort_field=<field_id>&sort_order=asc` — composes with pagination params.

### 4. Integrate with existing UI

Sort selector sits in the same filter row as schema selector and conflicted toggle. Sort changes reset pagination to first page (different sort order = different page 1).

## Edge Cases

- **Schema change**: Sort selector resets when switching schemas (field_ids are schema-specific)
- **All schemas view**: Sort selector disabled or hidden (sorting across schemas is ambiguous)
- **Field deleted**: If sorted field is deleted from schema, reset to default sort
- **Sort + pagination reset**: Changing sort resets to page 1 automatically

## Acceptance Criteria

1. `ContentPage` renders sort selector `<Select />` when a schema is selected
2. Sort selector shows "Newest first" (default), "Oldest first", and all sortable fields from schema
3. Selecting a field updates URL with `sort_field=<field_id>&sort_order=asc`
4. Clicking sort order toggle changes between asc/desc
5. Boolean and schema-ref fields are not shown in sort selector
6. Changing sort resets pagination to first page
7. Switching schema resets sort to default
8. "All schemas" view disables or hides sort selector
9. Sort state persists in URL and restores on page reload
10. `pnpm build` succeeds
