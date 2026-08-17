# PLAN-40: Server Sorting

## Goal

Add field-based sorting to content listing endpoints. Users can sort entries by `content.id`, `creation_date`, or any text/number/date field value. Boolean and schema-ref fields cannot be sorted. NULLS LAST semantics ensure entries without a field value sort to the end rather than being excluded.

**Depends on:** PLAN-38 (server pagination must be implemented first, as sorting builds on the paginated query structure).

## Files Involved

- `server/src/repositories/contentRepo.ts` — dynamic ORDER BY with JOIN
- `server/src/services/contentService.ts` — sort validation against schema
- `server/src/routes/entries.ts` — parse sort params
- `server/src/routes/content.ts` — parse sort params
- `server/src/types.ts` — sort types
- `server/test/contentService.test.ts` — sorting tests

## Implementation Approach

### 1. Add sort types to `types.ts`

Define `SortParams` with `sortField?: number | 'id' | 'date'`, `sortOrder?: 'asc' | 'desc'`. The `sortField` can be a field_id (number), `'id'` for content.id, or `'date'` for creation_date.

### 2. Modify `ContentRepository.listEntries()`

Add sort parameters to the existing pagination query:
- Default: `ORDER BY content.id DESC` (newest first)
- For `'id'`: `ORDER BY content.id <direction>`
- For `'date'`: `ORDER BY content.creation_date <direction>`
- For field_id: LEFT JOIN `content_rows` on the specific field_id, `ORDER BY content_rows.value <direction> NULLS LAST`

The JOIN must be conditional—only added when sorting by a field. Use parameterized SQL to prevent injection. The value column is TEXT in SQLite, so numeric sorting requires CAST: `CAST(content_rows.value AS REAL)` for number fields.

**NULLS LAST handling:**
- Text fields: `ORDER BY content_rows.value <direction> NULLS LAST`
- Number fields: `ORDER BY CAST(content_rows.value AS REAL) <direction> NULLS LAST`
- Date fields: `ORDER BY content_rows.value <direction> NULLS LAST` (ISO dates sort correctly as strings)

### 3. Modify `ContentService.listForSchema()` and `listPublic()`

Add `sort?: SortParams` parameter. Validate `sortField` against the schema:
- If `sortField` is a field_id, look up the field in the schema
- Reject with 422 if the field doesn't exist or has type `boolean` or `schema-ref`
- Pass validated sort params to repository

### 4. Modify routes

**`entries.ts`** and **`content.ts`**:
- Parse `sort_field` (field_id, 'id', or 'date') and `sort_order` ('asc' or 'desc') from query params
- Pass to content service methods
- Invalid `sort_field` (non-numeric, non-'id', non-'date') returns 422

### 5. Update tests

**`contentService.test.ts`**: Tests for sorting by id, date, text field, number field. Edge cases: empty field values (NULLS LAST), invalid sort field type (422), sort with pagination composition.

## Edge Cases

- **Sorting by field with no values**: Entries sort to end (NULLS LAST), not excluded
- **Sorting by boolean/schema-ref field**: Rejected with 422 before query execution
- **Number field sorting**: CAST to REAL for correct numeric ordering (not lexicographic)
- **Sort + pagination composition**: Cursor stability maintained—sorting doesn't affect cursor semantics
- **Invalid sort_field**: Non-existent field_id returns 422, not silent ignore
- **Default sort**: When no sort params provided, `ORDER BY content.id DESC` (newest first)

## Acceptance Criteria

1. `GET /api/content/car?sort_field=id&sort_order=desc` returns entries ordered by id descending
2. `GET /api/content/car?sort_field=id&sort_order=asc` returns entries ordered by id ascending
3. `GET /api/content/car?sort_field=<field_id>&sort_order=asc` sorts by text field value alphabetically
4. `GET /api/content/car?sort_field=<number_field_id>` sorts numerically (not lexicographically)
5. Entries without the sort field value appear at the end (NULLS LAST)
6. `GET /api/content/car?sort_field=<boolean_field_id>` returns 422
7. `GET /api/content/car?sort_field=<schema-ref_field_id>` returns 422
8. `GET /api/content/car?sort_field=999` (non-existent field) returns 422
9. Sort composes with pagination: `?limit=2&cursor=42&sort_field=id` returns correct sorted page
10. Default sort (no params) is `content.id DESC`—newest entries first
11. Existing tests pass without modification
