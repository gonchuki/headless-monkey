# PLAN-21 — Content API serialization: label keys and schema-ref enrichment

## Goal

Change the `values` object in `GET /api/content/:schema` and `GET /api/content/:schema/:id` responses from `{field_id: raw_value}` to `{label: enriched_value}`. Schema-ref field values should be shaped as `{id: <target_entry_id>, schema: <ref_schema_name>}` instead of just the raw target ID number.

This plan depends on PLAN-20 (label uniqueness enforcement) — labels must be unique per schema for this serialization to work correctly.

## Files involved

- `server/src/services/contentService.ts` — modify `toEntry()` method to use label keys and enrich schema-ref values
- `server/src/repositories/contentRepo.ts` — may need to fetch schema fields for the mapping (Option B: in-memory mapping)
- `server/test/contentService.test.ts` — update tests that assert on `values` shape
- `server/test/publicApi.test.ts` — update route-level tests that check `values` format
- `SPEC.md` — amend the public API contract to reflect the new `values` shape (this is a breaking change and REQUIRED — the serialization change contradicts the current frozen contract unless the spec is revised)

## Implementation approach

1. **Obtain schema field definitions:** In `ContentService.toEntry()`, obtain the schema's field definitions (label, type, ref_schema) to build a mapping from field_id to field metadata. Fetch fields once per request and map in-memory.
2. **Key values by label:** Replace the current serialization that uses field_id as the key with one that uses the field's label. The mapping from step 1 provides the label for each field_id.
3. **Enrich schema-ref values:** When serializing a schema-ref field, output `{id: <target_entry_id>, schema: <ref_schema_name>}` instead of the raw target ID number. Use the ref_schema from the field metadata.
4. **Update tests:** All tests in `contentService.test.ts` and `publicApi.test.ts` that assert on `values` shape must be updated to expect label keys instead of numeric IDs. Schema-ref assertions should check for the enriched `{id, schema}` shape.
5. **Amend SPEC.md (REQUIRED):** This is a breaking API change, so the spec must be revised in the same changeset, not left to drift. Amend the frozen sections that describe the `values` shape:
   - §4's public API contract `values: { <fieldId>: <value> }` → `values: { <label>: <value> }`.
   - §4's schema-ref value serialization ("target content id (number)") → `{id: <target_entry_id>, schema: <ref_schema_name>}`.
   - R15's claim that API payloads reference fields by `field_id` "never by label" → update to state that content API `values` are keyed by unique label (the rationale: labels are unique per schema per PLAN-20, and consumers get self-describing responses).
   - The §7 serialization example → the new label-keyed format.
   - Check for any other sections that reference field_id-keyed `values` and reconcile them so the spec is internally consistent.
   - Add a changelog entry (using the established mechanism in SPEC.md) marking this as a breaking API change.

## Edge cases

- **Missing field metadata:** If a field_id in content_rows has no corresponding schema field (orphaned row), skip it or use the field_id as fallback key. This should not happen in normal operation but could occur after schema deletion.
- **Schema version mismatch:** The entry's schema_version may differ from the current schema version. Use the schema fields from the entry's schema_version, not the current schema. The `toEntry()` method already receives the schema entry — use its fields.
- **Null values:** A content row with NULL value should still appear in the values object with null/undefined value, keyed by label.
- **Empty entries:** An entry with no content rows should return `{}` for values (current behavior preserved).

## Acceptance criteria

1. `pnpm --filter server test` passes (all tests including updated assertions in `contentService.test.ts` and `publicApi.test.ts`).
2. SPEC.md has been revised and is consistent with the implementation: grep SPEC.md for the §4 contract — it must now document `values` keyed by label (no longer `{ <fieldId>: <value> }`), the schema-ref value as `{id, schema}`, and the §7 example must match the new format. No remaining SPEC.md section references field_id-keyed `values` for the public content API.
3. **Manual verification — label keys:** create a schema with text fields, create content entries, call `GET /api/content/:schema` → values object uses field labels as keys instead of numeric field IDs.
4. **Manual verification — schema-ref enrichment:** create a schema with a schema-ref field, create content entries referencing another schema's entry, call `GET /api/content/:schema/:id` → the schema-ref value is an object shaped `{id: <target_entry_id>, schema: <ref_schema_name>}`.
