# PLAN-29 — Front 5: read-path referential-integrity proofs

## Goal

Prove with tests that the public read path **cannot** emit a dangling schema-ref after Fronts 1–3 land. "Dangling" = a public `{id, schema}` value whose target entry does not exist in `schema` (or belongs to a different schema than the field's `ref_schema`). The application already guarantees this by construction — R34 blocks deleting referenced entries, R35 purges refs on retarget, and `content_refs.target_content_id` is `ON DELETE RESTRICT` at the DB level — so this plan adds **no feature logic**. It adds the missing test layer that pins the invariant, plus documents the edges where the guarantee could break.

This is primarily a `server/test` plan with at most trivial, in-file test-helper changes. No production behavior changes; no client changes.

## Dependency

- Requires **PLAN-26** (content_refs storage), **PLAN-27** (R34 blocked delete), and **PLAN-28** (R35 retarget purge) to be executed — the tests exercise those behaviors end-to-end.
- Relies on the PLAN-24 cascade/RESTRICT DDL.

## Files involved

- `server/test/publicApi.test.ts` — new describe block(s) for the read-path invariants (this is the current public-API test home; if a dedicated `server/test/refIntegrity.test.ts` fits better, a new file is acceptable — keep it consistent with the existing `createTestApp()` pattern).
- `server/src/routes/content.ts` — read-only; may add no changes. If a test must inject a dangle, it does so via direct SQL against `db`, not by weakening the routes.
- Optional: `server/test/contentService.test.ts` — service-level invariant assertions if route-level coverage leaves a gap.

## Implementation approach

1. **Write a "no dangling refs on public read" test.** Using the existing `createTestApp()` helper: create `person` and `company`; create `car` with a schema-ref field `owner → person`; create person entries and car entries referencing them; call `GET /api/content/car` and `GET /api/content/car/:id`. For every schema-ref value in the response, assert via direct `db` query that the target id exists in a `content` row whose `schema` equals `person` (the field's `ref_schema`). This is the core invariant test.

2. **Prove R34 holds across the read path.** Extend the test: after the setup above, attempt `DELETE /api/entries/:personEntryId` (referenced) → 409; then re-run the public read and assert the reference is still present and still resolves. Then delete the *referencing* car entries, retry the delete → 204, and assert the public read no longer contains the now-removed referencing entries and still contains no dangling refs.

3. **Prove R35 holds across the read path.** Retarget `car.owner` from `person` to `company` via `PATCH /api/schemas/car`; assert: (a) the affected car entry is excluded from `GET /api/content/car` (conflicted) and `GET /api/content/car/:id` returns 422; (b) **the purge surface is observed directly**: assert via `db` that `SELECT COUNT(*) FROM content_refs WHERE field_id = <ownerId> AND content_id = <carEntry>` is `0` (or, on the editor shape, that `GET /api/schemas/car/entries` no longer contains `values[String(ownerId)]`) — without this, the test would stay green even if PLAN-28's purge were deleted, because the public read hides the entry behind the conflict gate anyway; (c) re-editing the car entry with a valid `company` target un-conflicts it and the public read then shows `{id: <company entry>, schema: "company"}` which resolves; (d) at no point in the sequence does the public read emit `{id: <person entry>, schema: "company"}` or a dangling target. Note for the implementer: the property that actually keeps the public read clean after a retarget is the **no-bump** (PLAN-28 keeps `schema_version` below `compat_version`), not the purge; the purge's job is the editor/DB surface.

4. **DB-backstop test.** Directly insert a `content_refs` row whose `target_content_id` points at a nonexistent content id and assert the FK rejects it. PLAN-24's `database.test.ts` already covers the RESTRICT throw itself — this plan **reuses** that fact rather than duplicating the throw; it adds the read-path aftermath: assert that after a raw `DELETE FROM content` on a referenced target throws, the public read path is unaffected (no partial/dangling state observed). One test, two assertions, non-duplicative.

5. **Negative test for the "would-be" dangle.** Construct the situation the redesign exists to prevent and assert it cannot be reached through the API: a schema-ref whose target was deleted (R34 409), a schema-ref whose `ref_schema` changed (R35 purge + conflict 422) — in both cases, the public read never yields a reference that fails to resolve.

6. **Keep the suite green.** No changes to existing `publicApi.test.ts` assertions unless a test explicitly contradicts the new invariant (it shouldn't). Verify `pnpm --filter server test` passes with the new block.

## Edge cases

- **Reference into a schema that still exists but has zero matching entries** (target deleted from a *different* schema via cascade): since R34 blocks the delete at the entry level, this is unreachable through the API; the test documents that the DB RESTRICT is the last line of defense (assert a raw delete throws rather than silently succeeding).
- **Entries deleted by schema deletion**: deleting a *referencing* schema removes its entries and therefore their refs (cascade `content_refs.content_id`) — no dangles remain; add an assertion for it (delete schema `car`, assert `GET /api/content/person` unaffected and no `content_refs` rows target dangling entries).
- **`listPublic` vs `getPublic` divergence**: both must uphold the invariant; test both shapes (list array and `:id` single-entry).
- **Conflicted entries**: they are excluded from the public read (that is the R35 proof's mechanism); the test must not expect conflicted entries to appear with refs.
- **Required schema-ref key absence (the green-while-broken trap)**: if a regression re-enables the R21-style bump on retarget, the entry un-conflicts and appears in the public read with the retargeted field's key **absent** (purge worked, bump didn't). A test that only iterates schema-ref *values present in the response* stays green for this — a worse bug than a dangle, since a required field is silently missing. The invariant test must therefore also walk each returned entry's `schema.fields` schema-ref entries and assert the key is present when the field is `required` (absent allowed only when optional).
- **Type-flip retarget (`schema-ref → text → schema-ref`)**: two sequential PATCHes never match PLAN-28's `retargetedFieldIds` rule (the old type on the second step is `text`, not `schema-ref`), so stale `content_refs` for the old person target can survive. The public read stays clean (conflict gate), so no dangle — but the plan should assert directly that the stale ref is also not observable on the editor shape or by a `content_refs` query. (The *fix* for this is PLAN-28 scope, not here; do not widen this plan into feature logic.)
- **Self-references**: do not test entry self-reference here. Today's `checkCycle` (R10) rejects a schema-ref field pointing at its own schema, so an entry cannot reference an entry in its own schema at write time; a plan asserting the editor shape could incorrectly assume self-refs are legal. Note this so a future implementer does not "fix" the editor shape to hand self-refs.

## Acceptance criteria

1. `pnpm --filter server test` passes in full — existing `publicApi.test.ts` assertions (R18/R19/R20, enrichment tests) remain green.
2. `pnpm --filter server test -- publicApi` passes with the invariant test that, after creating person + company + car (owner→person) with cross-schema references, iterates **every** schema-ref value returned by `GET /api/content/car` and `GET /api/content/car/:id` and asserts via `db` that the target exists in `content` with the matching schema — and, for each returned entry, walks its `schema.fields` schema-ref entries asserting the value key is present when the field is `required`. The test must fail if a target id stops resolving (dangling) or a required ref key is absent while the entry is served. (The suite run is the verdict; the assertions are in that test.)
3. `pnpm --filter server test -- publicApi` passes with the R34 read-path test: `DELETE /api/entries/:id` on a referenced entry returns 409, the reference still resolves on the next public read, and after deleting the referencing entries the delete succeeds and the public read contains no dangling refs. This test must fail if `ContentService.delete` stops throwing 409 on a referenced entry.
4. `pnpm --filter server test -- publicApi` passes with the R35 read-path test: after retargeting `car.owner` to `company`, the affected entry is excluded from `GET /api/content/car`, `GET /api/content/car/:id` returns 422, a direct `db` query shows the `content_refs` purge (count 0 for that field/entry), and after re-saving with a company target the public read shows a resolving `{id, schema: "company"}` value. This test must fail if PLAN-28's purge were removed (the direct-query assertion) **and** if the no-bump were reverted (the 422/exclusion stops holding).
5. `pnpm --filter server test -- publicApi` passes with the DB-backstop test: a raw `DELETE FROM content` on a referenced target throws a SQLite constraint error, and the public read path afterward shows no partial/dangling state. (Reuses PLAN-24's RESTRICT fact; the read-path assertion is new.)
6. `git diff` for this plan touches only `server/test/` files (no `server/src/` production changes, no `client/` changes).

## Verify notes

`pnpm --filter server test`. If a new test file is created, ensure it is discovered by the existing vitest config (default `test/**/*.test.ts` glob — confirm by running the suite). The dev `data/` DB must be wiped before running `pnpm dev` as per PLAN-24's dev-DB note (the new baseline table).