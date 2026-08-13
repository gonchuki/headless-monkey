# PLAN-50 — Eliminate N+1 queries in SchemaService.list with batch field query

## Goal

`SchemaService.list()` calls `repo.listSchemas()` (1 query) then `repo.getSchema(name)` per schema (2 queries each: schema metadata + fields). For N schemas, this is 1 + 2N queries. Replace with a batch approach: fetch all schema metadata in one query, then fetch all fields for all schemas in one query, and assemble `SchemaEntry[]` in JavaScript.

## Files involved

- `server/src/services/schemaService.ts` — `list()` method; rewrite to use batch queries
- `server/src/repositories/schemaRepo.ts` — add a new `getFieldsForSchemas(schemaNames: string[])` method that returns fields for multiple schemas in one query; alternatively modify `listSchemas()` to include fields inline

## Implementation approach

1. Add a batch query method to `SchemaRepository` that fetches fields for multiple schemas in one query using an IN clause. Return results grouped by schema name (e.g., as a Map from schema name to field array). Guard against empty input — if no schema names are provided, return an empty result without executing a query.

2. Modify `listSchemas()` to return full schema metadata (including `creation_date`, `created_by`, `last_modified_date`, `last_modified_by`) instead of lightweight entries with just name/version/compat_version. This eliminates the need for per-schema `getSchema()` calls in the list path.

3. Rewrite `SchemaService.list()` to: fetch all schema metadata via the enhanced `listSchemas()`, then fetch all fields via the new batch method, and reconstruct `SchemaEntry[]` from the combined data. Skip the batch query if there are zero schemas.

4. Update the `SchemaListEntry` type (or create a new internal type) to carry the full metadata needed to construct `SchemaEntry`.

## Edge cases

- **Zero schemas**: `listSchemas()` returns empty array. The batch fields query is skipped (guard on `schemaNames.length === 0`). Returns `[]`.
- **Schema with zero fields**: `fieldsBySchema` won't have an entry for this schema. Use `?? []` to provide an empty fields array. This is valid — the spec requires at least one field, but the list should still return the schema.
- **Schema deleted between queries**: Not possible in single-threaded better-sqlite3 — no concurrent modifications during the list operation.

## Acceptance criteria

1. `list()` returns the same `SchemaEntry[]` shape as before — consumers see no difference.
2. For N schemas, exactly 2 queries are executed (1 for schema metadata, 1 for all fields) instead of 1 + 2N.
3. Schemas with zero fields have an empty `fields` array in the response.
4. The existing test suite passes — no regression in schema listing flow.
5. Query count instrumentation for listing schemas shows exactly 2 queries executed (1 for schema metadata, 1 for all fields) regardless of schema count.
