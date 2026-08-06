# PLAN-04: M3 — Content + public API (server)

**Originating milestone:** M3
**Depends on:** PLAN-02 (schemas + fields + propagation), PLAN-03 (auth middleware + role guards — confirm both suites pass before starting)

## Goal

Editors create/edit/delete entries against schemas with type validation, value coercion, and conflict tracking; the unauthenticated public data API returns valid entries and distinguishes unknown (404) from conflicted (422).

## Spec refs (verbatim from milestone M3)

SPEC §2 R16–R20; §4 content routes, public API shapes, value serialization; §7 status + serialization examples; §5 service-layer tests.

## Files involved

- `server/src/repositories/contentRepo.ts`
- `server/src/services/contentService.ts`
- `server/src/routes/content.ts` — public API (no auth).
- `server/src/routes/entries.ts` — guarded editor routes.
- `server/src/app.ts` — mount both; public routes must stay unauthenticated.
- `server/test/contentService.test.ts`, `server/test/publicApi.test.ts`.

## Approach

1. **Content repo:** insert entry + `content_rows`, replace rows on update, delete entry, list entries for a schema (with `conflict: boolean` = `schema_version < compat_version`), get entry by id.
2. **Validation (`contentService`, R16):** required fields must be present and type-valid — a required `text` field must be non-empty; unknown `field_id` → 422; a `schema-ref` value must reference an existing entry id in the target schema → 422. Values serialize per SPEC §4 (JSON-encoded TEXT: text→string, number→number, boolean→boolean, date→`"YYYY-MM-DD"`, schema-ref→number).
3. **Save semantics (R17):** set `schema_version` = schema's current `version`. When a field's type changed breaking-ly and the stored value no longer matches, auto-coerce losslessly (`number`→`text`) and carry it over; otherwise reject the save until the editor supplies a valid value.
4. **Editor routes (guarded):** `GET /api/schemas/:name/entries` (all entries incl. conflicted with `conflict` flag), `POST /api/schemas/:name/entries`, `PATCH /api/entries/:id`, `DELETE /api/entries/:id`.
5. **Public routes (NO auth, R20):** `GET /api/content/:schema` → 200 with only valid entries, 404 unknown schema (R18). `GET /api/content/:schema/:id` → 200 valid entry / 404 unknown id / 422 conflicted, mutually exclusive (R19).
6. **Tests:** R16–R20; the §7 serialization example (`values` keyed by field id); editing a conflicted entry resolves it (R17); coercion case (`number`→`text` carries over, `text`→`number` rejected until re-entered).

## Edge cases

- Conflict is per-entry (`schema_version < compat_version`), not per-schema — the public list must still return valid entries when others are conflicted.
- `GET /api/content/:schema/:id` returns exactly one of 200/404/422 (R19).
- Deleting an entry removes its `content_rows` (cascade).
- A `schema-ref` value must be validated against the target schema's existence at save time; a valid id for the wrong schema is invalid.
- The public routes bypass auth entirely — do not mount them behind `requireAuth`.

## Acceptance criteria

1. `pnpm --filter server test` passes, including `contentService.test.ts` and `publicApi.test.ts`.
2. Validation tests: missing required field → 422; required `text` set to `""` → 422; unknown `field_id` → 422; `schema-ref` pointing at a non-existent (or wrong-schema) entry → 422 (R16).
3. A test saves an entry, performs a breaking schema change (e.g. add a required field), and confirms the public detail route returns 422 and the editor entries route reports `conflict: true`; after re-editing, the entry is valid again (R17, R19).
4. A test asserts `GET /api/content/:schema` returns only valid entries and 404 for an unknown schema (R18); `GET /api/content/:schema/:id` covers 200/404/422 (R19); the public routes work with no `Authorization` header (R20).
5. The §7 serialization example passes: `values` keyed by numeric `field_id` with per-type JSON values, and the entry object exposes the full §4 shape — `id, schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by, values`.
6. Coercion test (R17, resolved decision #4): changing a `number` field's type to `text` and saving carries the value over as a coerced string; changing a `text` field to `number` rejects the save with 422 until a valid number is provided.

Milestone M3 verify gate (preserved): `pnpm --filter server test` passes (content + public API suites).
