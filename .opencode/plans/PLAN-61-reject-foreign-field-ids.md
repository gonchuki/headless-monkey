# PLAN-61 — Reject foreign field ids in schema PATCH (cross-schema corruption)

## Goal

A schema PATCH (`PATCH /api/schemas/:name`, both the real update and the `?preview=true` dry-run) must reject with **422** any incoming field whose `id` is not one of the target schema's existing field ids.

Today, an incoming field carrying another schema's field id is written through as-is: the repository's field-update statement is scoped only by field id (not by schema), so a PATCH to schema A with a field carrying schema B's field id rewrites B's `schema_fields` row (label, type, required, ref_schema, sort_order) with no version bump on B, silently desyncing B's entries. Any editor can do this to any schema. New fields (no `id`) must remain legal.

## Files involved

- `server/src/services/schemaService.ts` — `validateAndComputeUpdate`, the single validation path shared by `update()` and `previewUpdate()`. This is the only place the fix goes in production code.
- `server/test/schemaService.test.ts` — new regression test, plus repairs to two existing tests that accidentally depended on the old behavior (see Edge cases).
- `server/test/schemaRoutes.test.ts` — repair to one existing test that accidentally depended on the old behavior (see Edge cases).

## Approach

1. **Reject foreign ids in `validateAndComputeUpdate`.** In that function, where the target schema's existing field ids are already gathered into a set for the deleted-field computation, add a check: for every incoming field carrying a numeric `id`, if the id is not in that set, throw `SchemaServiceError(422, ...)` naming the offending id (match the existing 422 message style in that function). Incoming fields without an id are new fields and must pass. The check runs before any write — the whole function is pre-write, and `update()` runs it inside its transaction — so a rejection leaves nothing behind.
2. **Do not touch the repository.** `SchemaRepository.updateSchemaFields` keeps its unguarded field-update statement; the service check is the contract, and `update()` is the repository method's only caller.
3. **Add the regression test** in `server/test/schemaService.test.ts` (follow the file's existing conventions — `createService()`, `SchemaServiceError` assertions, direct `db` queries for DB state):
   - Create two schemas in one db, e.g. `car` and `boat`.
   - Call `service.update("car", ...)` with a field list containing a field that carries `boat`'s field id (look it up from the returned `SchemaEntry`, never hardcode).
   - Assert the call throws `SchemaServiceError` with `statusCode === 422`.
   - Assert no corruption: `boat`'s field row is unchanged (label/type/required/ref_schema as created) and `car` is unchanged (version still 1, its fields intact).
   - Assert `service.previewUpdate("car", ...)` with the same payload throws the same 422.
4. **Repair the three existing tests** listed in Edge cases so they use the target schema's real field ids.

## Edge cases

- **Three existing tests accidentally depend on the bug.** Each hardcodes field ids starting at 1 in a PATCH to a schema that was *not* created first in its test db. Today they pass by corrupting the earlier-created schemas (rewriting those schemas' field rows and deleting the target's real fields), and their `compat_version` assertions hold for the wrong reason — a coincidental field deletion is what makes the update breaking. After the fix they 422. Repair each by looking up the target schema's actual field ids from the returned `SchemaEntry` by label (the convention the R35 tests already use: `schema.fields.find((f) => f.label === ...)`):
  - `server/test/schemaService.test.ts`, test "sets compat_version = version for into schema-ref (§7)": creates `person` first, then `car`; the PATCH to `car` uses ids `{1, 2}` but `car`'s real ids are `{2, 3}`.
  - `server/test/schemaService.test.ts`, test "sets compat_version = version for ref_schema target change (§7)": creates `person`, `company`, then `car`; the PATCH to `car` uses ids `{1, 2}` but `car`'s real ids are `{3, 4}`.
  - `server/test/schemaRoutes.test.ts`, the `"ref target change"` case in the §7-table `it.each` ("compat_version transitions (§7 table)"): creates `person`, `company`, then `car`; the PATCH to `car` uses ids `{1, 2}` but `car`'s real ids are `{3, 4}`. **Critical:** if left unrepaired, this case passes *vacuously* after the fix — the PATCH 422s, nothing changes, and `compat_version === version` holds trivially at `1`. It must be repaired to keep testing the retarget.
- **Non-existent ids are rejected too.** The acceptance condition is "id is among the target schema's existing field ids", not "id exists somewhere". A PATCH carrying id `999999` (in no schema) is rejected by the same check; no separate handling needed.
- **Duplicate incoming ids remain unvalidated** (two incoming fields sharing one existing id). Out of scope — do not add handling for it.
- The preview path gets the rejection for free (same validation function); the regression test asserts it so a future split of the two paths is caught.

## Acceptance criteria

1. `pnpm --filter server test` passes — the full server suite, including the new regression test and the three repaired tests, with no other test modified.
2. `pnpm --filter server typecheck` passes.
3. Mutation check (manual): temporarily remove the new rejection from `validateAndComputeUpdate`. `pnpm --filter server test` then fails on the new regression test specifically — the update succeeds and the victim schema's field row is rewritten — proving the test exercises the fix. Restore the check; the suite is green again.
