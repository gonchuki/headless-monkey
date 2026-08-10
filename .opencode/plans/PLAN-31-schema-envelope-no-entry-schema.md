# PLAN-31 — Public envelope `{schema, entries}`; drop redundant per-entry `schema`

## Goal

Adjust the public v0.7 wire shape from PLAN-30:

- The envelope key `meta` becomes `schema` — `{schema, entries}` instead of `{meta, entries}`.
- Each public entry currently carries a `schema` field equal to the schema name; it is redundant because the envelope's `schema.name` already names the schema, so the public projection must strip it.

Contract after this plan (SPEC §4/R15/R18/R19):

- `GET /api/content/:schema` → 200 `{ schema: { name, version, fields: { "<field_id>": "<label>", ... } }, entries: [ { id, schema_version, values: { "<field_id>": <value>, ... } } ] }` (valid entries only); 404 unknown schema.
- `GET /api/content/:schema/:id` → same `{schema, entries}` shape, one-element `entries` array; 404 unknown id; 422 conflicted.
- Public entries do **not** carry a `schema` field. Everything else in the entry envelope (`id`, `schema_version`, audit timestamps, `values`) is unchanged.
- No version-bump churn: this is the same unreleased v0.7 contract being corrected before first consumption; SPEC's changelog line describing v0.7 is edited in place, not bumped to v0.8.

Explicitly out of scope (unchanged):

- Editor shape (`GET /api/schemas/:name/entries` and editor CRUD responses) — the editor entry **keeps** `schema`; the client's `ContentPage.tsx` navigates via `entry.schema`.
- SSE `RealtimeEvent.schema` (top-level event field naming the topic) — unrelated to the entry envelope.
- Schema-ref values `{ id, schema }` inside `values` — that `schema` is the target's schema name, required by the R29 enrichment contract, not the redundant entry-level name.
- Service layer: `ContentEntry`/`ContentListEntry`/`toEntry`/`listPublic`/`getPublic` — untouched. The strip happens only in the route-level public projection.

## Dependency

- Requires **PLAN-30** executed (current public projection lives at the HTTP boundary in `server/src/routes/content.ts`, service shapes untouched).
- Interacts with the PLAN-29 walker in `server/test/refIntegrity.test.ts` (`PublicEntryBody` type + `body.meta` assertions) and `server/test/publicApi.test.ts` — both must be updated to the new envelope and to assert the entry no longer carries `schema`.

## Files involved

- `server/src/routes/content.ts` — rename envelope key `meta` → `schema`; strip per-entry `schema` in the projection (both list and detail routes).
- `SPEC.md` — update R15, R18, R19, §4, §5, §7, and the v0.7 changelog line from `meta` to `schema`; the §4/§7 public entry examples drop the per-entry `schema` key (the examples currently do not show one — verify and keep consistent).
- `server/test/publicApi.test.ts` — `body.meta` → `body.schema` everywhere; remove the `entries[0].schema === "car"` assertion (L163); add/keep a negative assertion that the entry has no `schema` property.
- `server/test/refIntegrity.test.ts` — `body.meta` → `body.schema` (L113-115, L122-123); remove `schema: string` from `PublicEntryBody` (L39) and from the `broken` fixture (L271); verify the walker never reads `entry.schema` (it uses `schema.name` from the passed `SchemaEntry`).
- No client changes; the client does not consume `/api/content/*`.

## Implementation approach

1. **Rename the envelope key in the route projection.** In `server/src/routes/content.ts`:
   - Rename `PublicContentMeta` → `PublicSchemaDescriptor` (or similar) and `buildMeta` → `buildSchema` — or keep the helper name and only change the response interface field. Prefer a clear rename so no `meta` token remains on the public wire.
   - `PublicContentResponse { schema: PublicSchemaDescriptor; entries: ContentEntry[] }`.
   - Both routes emit `{ schema: buildSchema(schema), entries: ... }`.
2. **Strip per-entry `schema` in the projection.** The projection currently maps `entries.map((entry) => ({ ...entry, values: rekeyValues(entry, labelToId) }))`. Change to destructure the redundant field away, e.g. `const { schema: _schema, ...rest } = entry; return { ...rest, values: rekeyValues(entry, labelToId) };`. Do **not** touch the service `ContentEntry` type — the editor shape needs `schema`.
3. **Update SPEC.md** text per the contract above. Keep the changelog at v0.7 (same unreleased contract) but reword the shape to `{schema, entries}`. Verify §4's example lines and §7's serialization example use `schema` and do not include per-entry `schema`.
4. **Update tests:**
   - `publicApi.test.ts`: replace every `body.meta` / `list.body.meta` / `res.body.meta` with `body.schema` etc. Remove L163's `expect(res.body.entries[0].schema).toBe("car")`. Add an assertion that `res.body.entries[0]` does **not** have a `schema` property (e.g. `expect(res.body.entries[0]).not.toHaveProperty("schema")`) — this is the negative case that makes the strip real.
   - `refIntegrity.test.ts`: `body.meta` → `body.schema` in the type casts and assertions; drop `schema` from `PublicEntryBody` and the `broken` fixture object. Confirm `assertNoDanglingRefs` reads only `entry.id`/`entry.values` + the passed `SchemaEntry` — no other change.
5. **Keep the fail-open/closed discipline:** the new `not.toHaveProperty("schema")` assertion fails pre-change and passes post-change; the old `body.meta` assertions fail post-change if the rename is reverted. Both directions are pinned by the suite.

## Edge cases

- **Editor shape must keep `schema`** — `ContentPage.tsx` (client) uses `entry.schema` from the editor list to navigate. Only the public projection strips it.
- **SSE**: `RealtimeEvent.schema` is the event's topic field, never an entry envelope — no change.
- **Schema-ref values**: `values[String(fieldId)] === { id, schema: "<ref_schema_name>" }` — the inner `schema` stays; it identifies the referenced entry's schema.
- **Detail route**: the one-element array must also strip `schema`.
- **Audit timestamps**: `creation_date`/`created_by`/`last_modified_date`/`last_modified_by` remain on public entries (unchanged from PLAN-30's envelope).
- **README/docs outside SPEC**: grep for other `{meta, entries}` or `body.meta` references; if a README documents the public API, update it in this plan (the repo has no such README section today — verify and only touch what exists).

## Acceptance criteria

1. `pnpm --filter server test` passes in full and `pnpm --filter server build` passes (strict TS) — the updated `publicApi.test.ts`/`refIntegrity.test.ts`, and unchanged `contentService.test.ts`/`events.test.ts`/`schemaService.test.ts`/`schemaRoutes.test.ts`/`database.test.ts`, all green.
2. `pnpm --filter server test -- publicApi` passes with an assertion that `GET /api/content/car` returns `body.schema` with `{ name, version, fields }` (and `body.meta` is absent — the old key fails), plus a negative assertion that `body.entries[0]` has no `schema` property while `schema_version` remains. Same for `GET /api/content/car/:id`.
3. `pnpm --filter server test -- refIntegrity` passes with the adapted walker: `body.schema.name` assertions and `PublicEntryBody` without `schema`; the required-field key guard and the no-dangling-refs invariant are unchanged (the negative-case test for the guard still fails if the guard is removed).
4. `grep -rn "body.meta\|res.body.meta\|list.body.meta" server/test` returns nothing, and `grep -rn '"meta"' SPEC.md` returns nothing except where the word "metadata" legitimately appears (verify; if a hit remains it is a miss).
5. `git diff` for this plan touches only `server/src/routes/content.ts`, `SPEC.md`, `server/test/publicApi.test.ts`, `server/test/refIntegrity.test.ts` — no changes to `server/src/services/`, `server/src/repositories/`, `server/src/routes/` other than `content.ts`, `client/`, or `events.ts`.

## Verify notes

Run `pnpm --filter server build` then `pnpm --filter server test`. The negative assertions (no `meta`, no per-entry `schema`) are the behavioral gates; the full suite passing is the verdict.

## Traceability

- User-driven adjustment on the PLAN-30 v0.7 shape: envelope `{meta, entries}` → `{schema, entries}`, per-entry `schema` redundant because `schema.name` already names it.
- SPEC.md R15/R18/R19, §4, §5, §7 — edited in place (same v0.7 line in the changelog).
