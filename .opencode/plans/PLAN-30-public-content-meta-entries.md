# PLAN-30 — Public content API v0.7 `{meta, entries}` contract

## Goal

Bring the **public** content API in line with the SPEC v0.7 contract authored by PLAN-23 (R15/R18/R19). The two public endpoints currently return a bare label-keyed list (`GET /api/content/:schema`) and a bare label-keyed single entry (`GET /api/content/:schema/:id`); SPEC mandates self-describing `{meta, entries}` wrappers with `values` keyed by `String(field_id)` and a `meta.fields` id→label map. The editor API is already field_id-keyed and stays untouched; the client does not consume the public API.

Contract (from SPEC.md §4, post-PLAN-23):

- `GET /api/content/:schema` → 200 `{ meta: { name, version, fields: { "<field_id>": "<label>", ... } }, entries: [ { id, schema_version, values: { "<field_id>": <value>, ... } } ] }` (valid entries only); 404 unknown schema (R18).
- `GET /api/content/:schema/:id` → the same `{meta, entries}` shape with a one-element `entries` array; 404 unknown id; 422 conflicted (R19).
- Public `values` keys are `String(field_id)` (R15, id-stable unique contract). Labels are supplied by `meta.fields`; consumers detect renames by diffing `meta.version` against the version they were built for. No version header — `meta.version` is authoritative.
- Schema-ref values serialize as `{id: <target_entry_id>, schema: <ref_schema_name>}` under `String(field_id)` keys (unchanged enrichment semantics, new keying).
- An optional schema-ref with no target is omitted (absent key) — unchanged.

This plan is the *runtime* half of PLAN-23. It must not change the editor shape (`GET /api/schemas/:name/entries`: raw field_id keys, raw target numbers, `conflict` flag, `referencer_count`) nor any editor create/update response, nor the internal `ContentEntry`/`ContentListEntry` types, nor the service-level `listPublic`/`getPublic` results and their filtering (valid-only, 404/422 semantics). The public wire shape changes only at the HTTP boundary, in the routes.

## Dependency

- Requires **PLAN-23** executed (SPEC.md now mandating this contract, R18/R19 as quoted above) — the doc contract is the source of truth for the shape, exactly as written in SPEC §4 and §7's serialization example.
- Depends on **PLAN-22's** split between editor and public serializers existing (it does — `toEntry(entry, schema, includeConflict, shape)`), which established that the public and editor shapes differ; this plan re-projects only the public wire shape at the route boundary.
- Interacts with **PLAN-29** test fixtures: after this plan, `server/test/refIntegrity.test.ts` and `server/test/publicApi.test.ts` must be updated to the new shape and still enforce the R34/R35 invariants (the walker and the required-key guard now traverse `{meta, entries}` and `String(field_id)` keys).

## Files involved

- `server/src/routes/content.ts` — the public projection: build `{ meta, entries }` and re-key `values` to `String(field_id)`; response types (if any) can be declared here or near `ContentEntry` in `contentService.ts` — **not** in `server/src/types.ts`, to avoid a `types.ts → contentService.ts → types.ts` cycle since `ContentEntry` lives in `contentService.ts`.
- `server/src/services/contentService.ts` — only if helper types/functions are added; existing `listPublic`/`getPublic`/`toEntry` behavior must stay unchanged.
- `server/test/publicApi.test.ts` — update R18/R19/R20 assertions to the wrapped shape and `String(field_id)` keys.
- `server/test/refIntegrity.test.ts` — update the read-path walker and its raw-value assertions (`entry.values.owner`, `entry.values.garage`, `.map(e => e.id)` on the bare list) to traverse `body.entries` and resolve `String(field_id)` keys; the *invariants* (no dangling refs, required refs present, 404/422 statuses) must be preserved exactly.
- `server/test/contentService.test.ts` — no changes expected (service-level shapes untouched). If a specific assertion turns out to inspect the public HTTP envelope, move that assertion to `publicApi.test.ts` rather than changing the service behavior.
- No client changes; the editor list page consumes `/api/schemas/:name/entries` (already field_id-keyed) and does not read `/api/content/*`.

## Implementation approach

1. **Build the wrapper at the HTTP boundary — do NOT change `toEntry`'s public branch.** `listPublic`/`getPublic` return label-keyed entries today, and their shapes are asserted by `contentService.test.ts` (which must stay green — see AC1). The public wire contract lives only on the routes, so the projection belongs there. In `server/src/routes/content.ts` (or a small dedicated helper imported by it), given the schema and the `listPublic`/`getPublic` results:
   - compute `meta = { name: schema.name, version: schema.version, fields: <id→label map> }` once per request, where the map is `Object.fromEntries(schema.fields.map(f => [String(f.id), f.label]))`;
   - re-project each entry's `values`: for every (label-based) key, find the field with that label in `schema.fields` (labels are unique per R8/DB constraint) and re-key as `values[String(field.id)]`; schema-ref values keep their `{id, schema}` enrichment unchanged — only the key changes;
   - respond `{ meta, entries }` (list) or `{ meta, entries: [ entry ] }` (detail).
   The label→id map is derived once from `schema.fields`, not recomputed per entry.
2. **Where the shape conversion happens:** the service's `toEntry` public branch keeps its current label-keyed behavior. The remap to `String(field_id)` happens only in the route-level projection. This keeps every existing service-level test green and isolates the wire change to one place.
3. **Emit `meta`.** `meta.fields` covers all fields of the schema (not only those with stored values); `meta.name` = schema name; `meta.version` = schema version. Ordering of `fields` keys does not matter; field ids are id-stable by R13.
4. **Routes.** `GET /api/content/:schema` returns `{ meta, entries }`; `GET /api/content/:schema/:id` returns `{ meta, entries: [ ... ] }` with a one-element array. Keep the `/` route error handling (404 unknown schema, 422 conflicted, 500 internal) exactly as it is — status codes and `{ error }` bodies are unchanged.
5. **Keep the editor contract untouched.** `listForSchema`/`toEntry` editor branch, POST/PATCH/DELETE editor responses, `conflict`/`referencer_count` flags all unchanged. SSE event payloads carry only `type/schema/entryId/version/compatVersion/by/changes` — never entry `values` — so no SSE change is needed (already verified).

6. **Update tests.** In `publicApi.test.ts` and `refIntegrity.test.ts`, adjust:
   - list assertions: `body.entries` instead of bare array; `body.meta.name`/`meta.version`/`meta.fields` shape checks;
   - `values` access: `entry.values[String(fieldId)]` instead of `entry.values.<label>`;
   - the `refIntegrity` walker: iterate over `entries` keys with `String(field_id)`, resolve labels via `meta.fields`, and continue asserting the target `id` exists in the matching `db` schema and that required refs appear (when the required field's value is awaited) — the invariants and their fail-behaviour must be conserved.
   - Keep at least one test asserting the *old* shape is gone (a test that `GET /api/content/car` response has a `meta` and `entries` keys, and that values keys are digits = `String(field_id)`).

## Edge cases

- **Linear metadata** is assembled from the *schema*, not from the page of entries: `meta.fields` contains every field of the schema, not only those with values (matches the spec's self-describing intent).
- **Entry envelope keys**: §4's `{ id, schema_version, values }` enumeration lists the required keys and is **not** exhaustive. Entries keep the current extra envelope keys (`schema`, audit timestamps) — only the `values` object is re-projected; nothing extra is stripped.
- **Conflicted entries**: the public shape still excludes them (list filter) / 422s (detail). The conflict logic (`schema_version < compat_version`) is untouched.
- **Empty schemas**: `{ meta, entries: [] }`, a valid 200; `meta.fields` non-empty even when `entries` is empty.
- **Optional absent optional ref**: absent key — no `undefined`/`null` in `values`.
- **References into a deleted/mismatched schema** (regression guard): the walker fixups must not weaken; the R34/R35 tests must still pass with the new shape; not part of scope to change the enforcement logic.
- **Meta.version**: from `schema.version` (schema current version), not per-entry.
- **old label-keyed claims in SPEC.md**: the old phrase must remain absent; this plan only implements the same contract — no further SPEC edits.
- **`schema-ref` values in the example**: SPEC §7 shows `"5": "Ada", "6": 36` under `String(field_id)`, and a schema-ref value as `{ "id": 42, "schema": "person" }`.

## Acceptance criteria

1. `pnpm --filter server test` passes in full — the updated `publicApi.test.ts` and `refIntegrity.test.ts`, the unchanged `contentService.test.ts`/`events.test.ts`/`schemaService.test.ts`/`schemaRoutes.test.ts`/`database.test.ts` suites, all green, and `pnpm --filter server build` passes (strict TS).
2. `pnpm --filter server test -- publicApi` passes with an assertion that `GET /api/content/car` returns a body with a `meta` object (`name`, `version`, `fields`) and an `entries` array, and that `meta.fields` maps each `String(field_id)` of the schema to its label; same for `GET /api/content/car/:id` returning `{ meta, entries: [ entry ] }` with the same meta. (The old expectation — a bare array — fails.)
3. `pnpm --filter server test -- publicApi` passes with an assertion that public `values` keys are `String(field_id)` (not field labels — e.g., a schema with a non-numeric label cannot validly produce a `values[label]` key in the body), including a schema-ref field's value: `values[String(field_id)]` equals `{ id: <target>, schema: <ref_schema_name> }` for a referenced entry.
4. `pnpm --filter server test -- refIntegrity` passes with the adapted walker: for every schema-ref value exposed through the public endpoints (list and detail), the target entry exists in `content` with the schema matching the field's `ref_schema`. The walker's required-field key guard is pinned by a **negative case**: a test constructs a public entry object missing the required schema-ref key and asserts the guard fails (the `expect(...)` fails with the required field absent), so that removing or weakening the guard makes the suite fail — the same fail-behavior the guard must keep. (The suite passes is the verdict; the specific invariant is checked in the test.)
5. The R34/R35 invariants from the earlier batch are preserved end-to-end: `DELETE /api/entries/:id` for a referenced entry still returns 409 (with count in `body.error`), a blocked delete emits no `entry.deleted` SSE, and after a retarget purge the affected entry stays excluded from the public list and 422s on the detail route. The full-suite run in AC1 already enforces these statuses — this criterion exists to call out that the projection must not weaken them; it is verified by the same `pnpm --filter server test` gate as AC1.
6. `git diff` over `server/src` for this plan touches only `server/src/routes/content.ts` (plus `server/src/services/contentService.ts` only if helper types/functions are added there) — no changes to `client/`, no changes to `server/src/types.ts`, editor routes, `events.ts`, schema services/repos, or the editor serializers. (A test-file change is expected in `server/test/publicApi.test.ts` and `server/test/refIntegrity.test.ts`.)

## Verify notes

Run `pnpm --filter server build` then `pnpm --filter server test`. Manual sanity is optional: hit `GET /api/content/<schema>` in a browser to confirm the wrapped shape renders as documented.

## Traceability

- SPEC.md R15, R18, R19 and §4 (post-PLAN-23) — implement these in the runtime.
- SPEC.md §7 example — shape assertions align.
- No edit to SPEC.md this plan; it is the source of truth.