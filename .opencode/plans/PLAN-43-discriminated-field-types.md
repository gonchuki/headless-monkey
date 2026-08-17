# PLAN-43 — Refactor Field Types to Discriminated Union

## Goal

Replace the flat `FieldInput` / `FieldWithId` interfaces with a discriminated union so that `ref_schema` is required only on `schema-ref` fields. The DB schema stays unchanged — this is purely a type-system improvement that eliminates defensive null checks across 6+ files and makes invalid field combinations (e.g., `schema-ref` without `ref_schema`, or `text` with `ref_schema`) compile-time errors rather than runtime bugs.

## Files Involved

| File | Role |
|------|------|
| `server/src/types.ts` | Root type definitions — split into discriminated union |
| `server/src/services/schemaService.ts` | 6 type guards on `f.type === "schema-ref"` — remove redundant null checks |
| `server/src/services/contentService.ts` | 3 type guards + fallback defaults — simplify branches |
| `server/src/repositories/schemaRepo.ts` | 6 null-coalescings (`f.ref_schema ?? null`) — update mapping logic |
| `server/src/services/fieldValidation.ts` | `isScalarValueValid` signature — exclude schema-ref from scalar validation |
| `client/src/lib/api.ts` | Mirror server types — same discriminated union split |
| `client/src/hooks/useSchemas.ts` | `SchemaDraft` type — adapt to union pattern (has `deleted?` flag) |
| `client/src/components/SchemaFieldRow.tsx` | 1 guard on `field.type === "schema-ref"` — simplify conditional rendering |
| `client/src/components/ReferenceSelect.tsx` | `field.ref_schema` access — now guaranteed non-null for schema-ref |
| `client/src/components/DynamicEntryForm.tsx` | Switch arm for `"schema-ref"` — verify compatibility |
| `client/src/components/EntryFieldInput.tsx` | Switch arm for `"schema-ref"` — verify compatibility |
| `server/test/schemaService.test.ts` | Test fixtures — update field construction patterns |
| `server/test/contentService.test.ts` | Test fixtures — same pattern update |
| `server/test/refIntegrity.test.ts` | Test fixtures — same pattern update |

## Implementation Approach

### Step 1: Define the Discriminated Union in `server/src/types.ts`

Replace the flat interfaces with a discriminated union. Structure the union so that `ref_schema` is required only on the `schema-ref` variant and absent from all scalar variants. Keep `FieldType` as a standalone union for places that need just the type string (e.g., `VALID_TYPES` set in schemaService). The discriminated union is for field objects, not for the type string alone.

**Constraint:** The union must be compatible with existing code that iterates over `FieldInput[]` and narrows by `field.type`. Each variant must include `label`, `type`, and `required` as shared properties, with `ref_schema` only on the schema-ref variant.

### Step 2: Update Client Types in `client/src/lib/api.ts`

Mirror the server's discriminated union structure. Replace `SchemaFieldInput` and `SchemaField` with the same union pattern used on the server.

**Constraint:** Ensure the client's field types are compatible with the server's API contract. The client sends field objects to the server via POST/PATCH, so the shapes must match exactly.

**Do this before Step 3** so client components compile against the new types as they're updated.

### Step 3: Adapt `SchemaDraft` in `client/src/hooks/useSchemas.ts`

Keep `SchemaDraft` as a flat interface with `ref_schema?`. The discriminated union lives on the server-facing types (`SchemaFieldInput`/`SchemaField`), and `SchemaDraft` remains a looser UI draft type that gets validated before sending to the server. This avoids forcing the `deleted?` flag into every union variant. The server validation already catches invalid combinations at runtime, so compile-time enforcement on the draft type is not required.

### Step 4: Update `server/src/services/schemaService.ts`

Remove redundant null checks on `ref_schema`. The discriminated union now guarantees that when `f.type === "schema-ref"`, `f.ref_schema` exists as a non-null string. Apply this across `create()`, `validateAndComputeUpdate()`, the `retargetedFieldIds` computation loop, and `isFieldChangeBreaking()`.

**Constraint:** The DB CHECK constraint (`type != 'schema-ref' OR ref_schema IS NOT NULL`) already enforces this invariant at the database level. The type system change aligns the application layer with what the DB guarantees.

### Step 5: Update `server/src/services/contentService.ts`

Simplify branches that handle schema-ref fields. In `buildRows()`, `isValidValue()`, and `toEntry()`, remove defensive guards on `ref_schema` since the type system now guarantees its presence for schema-ref fields. The fallback defaults in `toEntry()` become unreachable for properly typed schema-ref fields.

### Step 6: Update `server/src/repositories/schemaRepo.ts`

The repository maps between DB rows (where `ref_schema` can be NULL) and TypeScript types. This is the **only** place where null-coalescing (`f.ref_schema ?? null`) is appropriate — it's the boundary between the nullable DB world and the non-null type world. Keep all existing null-coalescing in `insertSchema()`, `getSchema()`, `getFieldsForSchemas()`, `getFields()`, and `updateSchemaFields()`. Ensure the types flowing *out* of the repository are correctly narrowed to the discriminated union.

### Step 7: Update `server/src/services/fieldValidation.ts`

The `isScalarValueValid()` function uses a `switch(type)` that deliberately excludes `"schema-ref"`. Under the discriminated union, narrow the function's signature to accept only scalar field types (exclude `"schema-ref"` from the type parameter). This makes the `default` branch unreachable — remove it. The function now only handles scalar types.

### Step 8: Update Client Components

- `SchemaFieldRow.tsx` — simplify `field.type === "schema-ref"` guards; `ref_schema` is now guaranteed for schema-ref fields
- `ReferenceSelect.tsx` — `field.ref_schema` is now `string` (not `string | undefined`) when narrowed to schema-ref; the `enabled: refSchema != null` guard can be removed since it's redundant
- `DynamicEntryForm.tsx` and `EntryFieldInput.tsx` — verify switch arms still compile; no behavioral change expected

### Step 9: Update Test Fixtures

Test files create mock fields inline. The actual object literals don't change — they already include `ref_schema` for schema-ref fields. The difference is that TypeScript now *enforces* this rather than allowing it to be optional. Verify that all test fixtures in `schemaService.test.ts`, `contentService.test.ts`, and `refIntegrity.test.ts` compile with the new types.

## Edge Cases

1. **DB-to-Type Mapping:** The repository reads from a nullable DB column. When mapping rows to types, ensure the resulting object matches the discriminated union. If `ref_schema` is NULL for a non-schema-ref field, that's fine — it maps to `ScalarFieldWithId`. If `ref_schema` is non-null for a schema-ref field, it maps to `SchemaRefFieldWithId`. The DB CHECK constraint guarantees this invariant.

2. **Type Narrowing in Loops:** When iterating over `fields: FieldInput[]`, TypeScript doesn't automatically narrow each element. Use `if (field.type === "schema-ref")` to narrow within the loop body. This is the same pattern as before, but now the narrowed type includes `ref_schema`.

3. **`SchemaUpdateInput` Type:** The `SchemaUpdateInput` type uses `(FieldWithId | Omit<FieldInput, "id">)[]`. Under the discriminated union, this becomes `(FieldWithId | ScalarFieldInput | SchemaRefFieldInput)[]`. Ensure this still compiles and that the service layer handles both existing fields (with id) and new fields (without id). Note: the `schemaService.update()` method parameter is typed as `(FieldInput & { id?: number })[]` inline, not using the exported `SchemaUpdateInput` type — this pre-existing inconsistency is out of scope for this refactor but should compile correctly with the new union types.

4. **Events Module:** `server/src/services/events.ts` has a `computeSchemaChanges()` function that diffs fields by id. It does NOT handle `ref_schema` changes in its output — it only reports `typeChanged`, not `refSchemaChanged`. This is a pre-existing gap that this refactor doesn't address, but verify the types still compile.

5. **Client-Server Contract:** The client sends field objects to the server via POST/PATCH. Ensure the request body validation still works with the new union types. The server's route handlers (`schemas.ts`) destructure `req.body` as `{ name, fields }: { name: string; fields: FieldInput[] }`. This should still work since the union type is compatible with the incoming JSON shape.

6. **`SchemaDraft.deleted?` flag:** The `deleted?: boolean` property on `SchemaDraft` is a UI concern that has no server equivalent. If Option A is chosen (keeping `SchemaDraft` flat), this means the client won't get compile-time enforcement of `ref_schema` on schema-ref drafts — the server validation catches it instead. This is acceptable since `SchemaDraft` is an intermediate UI state, not a contract type.

## Acceptance Criteria

1. **Build passes:** `pnpm -r build` completes without errors. Both server and client compile successfully.

2. **Tests pass:** `pnpm -r test` runs all tests successfully. No behavioral changes — all existing tests pass with the new types. This covers serialization correctness (client→server→DB→client round-trips) and repository mapping (schema-ref fields read back with `ref_schema` present).

3. **No new migration created:** The refactor produces no new migration file. Verify by checking that no new `.sql` file was added to the migrations directory.

4. **Type enforcement:** The discriminated union rejects invalid field combinations at compile time. Verify by running `tsc --noEmit` on a temporary file containing:
   ```typescript
   import type { FieldInput } from "./types";
   const badField: FieldInput = { label: "test", type: "schema-ref", required: true };
   ```
   The compiler should exit with an error about the missing `ref_schema` property. Delete the temporary file after verification.

(End of file - total 107 lines)