# PLAN-27 — Front 2: block deletion of referenced entries (R34)

## Goal

Implement **R34**: deleting an entry that other entries reference via a schema-ref field is blocked with **409** naming the referencer count, mirroring R22's schema-level rule. Two halves:

- **Server**: `ContentService.delete(entryId)` checks `content_refs` for any row whose `target_content_id` equals the entry; if found, throw 409 with the count and the usual `{ error }` body. The delete route (`server/src/routes/entries.ts`) must **not** emit `entry.deleted` SSE when the delete is blocked.
- **Client**: the entry list already renders per-entry data; add a `referencer_count` to the editor list shape so the delete confirmation can warn with the count **before** the attempt, per SPEC R34 ("the delete confirmation warns with that count before the attempt"). The server stays the enforcement point (the dialog warning is informational).

This plan requires Front 1 (PLAN-26) — refs live in `content_refs`; without it the count query has no source.

## Dependency

- Requires **PLAN-26** (content_refs storage): the referencer-count check reads `content_refs` for `target_content_id`.
- Blocks/feeds **PLAN-29** (read-path proofs), which asserts the no-dangle invariant relies on R34 being enforced.

## Files involved

- `server/src/repositories/contentRepo.ts` — add a referencer-count query (`countReferencesTo(targetContentId)`); optionally fold the count into `listEntries` for the editor shape.
- `server/src/services/contentService.ts` — `delete()`: 409 with count before `repo.delete`.
- `server/src/routes/entries.ts` — unchanged in behavior; verify the throw path skips the SSE emit (it already only emits after `contentService.delete` returns successfully).
- `server/test/publicApi.test.ts` (or a new entries-routes describe) — route-level 409 test + no-SSE-on-blocked test.
- `server/test/contentService.test.ts` — service-level 409 test.
- `server/test/events.test.ts` — no `entry.deleted` emitted for a blocked delete.
- `client/src/lib/api.ts` — `ContentListEntry` gains `referencer_count: number`.
- `client/src/routes/ContentPage.tsx` — show the count in the `DeleteConfirmDialog` description when the entry is referenced.
- `client/src/hooks/useEntries.ts` — unchanged (the delete mutation already surfaces the server 409 as an error that keeps the dialog open).

## Implementation approach

1. **Add the count query.** In `ContentRepository`, add a method returning the **distinct referencing-entry count** for a target: `SELECT COUNT(DISTINCT content_id) FROM content_refs WHERE target_content_id = ?` (indexed via `idx_content_refs_target`). Semantics resolved from SPEC R34's "target of any other entry's schema-ref value" and the dialog copy "referenced by K other entries": the count counts **referencing entries**, not reference rows — if one entry has two schema-ref fields pointing at the same target, the count is 1, not 2. Document this on the method.

2. **Enforce in `ContentService.delete`.** Before `repo.delete`, resolve the entry (404 path stays as-is), run the count query, and if `> 0` throw a `ContentServiceError(409, ...)` whose message includes the count (e.g. "Cannot delete entry N: referenced by K other entry/entries"). The count is the distinct-referencing-entry count (see step 1). The 404 behavior and the successful-delete path are unchanged.

3. **Route behavior.** In `server/src/routes/entries.ts`, the delete handler already calls `contentService.delete(id)` and only then emits `entry.deleted`; since the service throws for a referenced entry, the `catch` returns 409 and the emit never runs. Verify this ordering holds after the change and add a regression test.

4. **Expose the count to the client.** Extend the editor list shape so each entry carries `referencer_count`. The cleanest source is `listEntries`/`listForSchema`: include a correlated distinct count (`SELECT COUNT(DISTINCT content_id) FROM content_refs WHERE target_content_id = content.id`) per entry. Add `referencer_count: number` to the `ContentListEntry` interface in `client/src/lib/api.ts`. This is additive; the editor still uses `String(field_id)` keys and raw schema-ref numbers (unchanged by this plan).

5. **Warn in the delete dialog.** In `client/src/routes/ContentPage.tsx`, the `DeleteConfirmDialog` description currently reads "Delete this entry from X? This cannot be undone." When `entryToDelete.referencer_count > 0`, append a warning naming the count (e.g. "This entry is referenced by K other entries and cannot be deleted."). Keep the server 409 as the authoritative response; the optimistic `useEntries.remove` rollback already restores the list on error. Update any copy that assumed the count is per-reference (it is per-referencing-entry, per step 1/4).

## Edge cases

- **Single entry with two refs to the same target**: count is 1 (distinct `content_id`), matching "referenced by K other entries"; the 409 still blocks. Test this exact case so the semantic is pinned.
- **Self-reference**: entry self-reference is **unreachable** today — the R10 `checkCycle` in `SchemaService` rejects a schema-ref field pointing at its own schema (422), so an entry cannot reference an entry in its own schema. No test should assume self-refs are legal; the count query itself is agnostic and would handle them if they ever became reachable.
- **Cross-schema refs**: count includes references from entries in other schemas; the 409 message should not assume same-schema references.
- **Concurrent delete between check and count**: the count and delete are both fast statements; wrap check+delete in one transaction in the repository/service if review requires, but do not over-engineer — the FK `ON DELETE RESTRICT` on `target_content_id` (PLAN-24) is the hard backstop for a lost race.
- **SSE**: a blocked delete must not broadcast `entry.deleted`; verify no emit occurs on the 409 path (the existing emit-after-success ordering guarantees it).
- **Count display granularity**: "1 entry" vs "K entries" — the client may render simply; the server message can stay singular/plural-simple. Do not split into a separate count endpoint — the list already carries it.

## Acceptance criteria

1. `pnpm --filter server test` passes in full (existing delete/SSE/route tests remain green).
2. `pnpm --filter server test -- contentService` passes with a service-level test: create schema `person`, schema `car` with schema-ref `owner → person`; create a person entry and two car entries referencing it → `contentService.delete(personEntryId)` throws with `statusCode === 409` and message containing `2`; deleting a referenced entry with a *different* schema also 409s; deleting an unreferenced entry succeeds. Also: one entry with **two** schema-ref fields pointing at the same target deletes with a count of `1` (distinct-referencing-entries semantic). Each assertion can fail independently.
3. `pnpm --filter server test -- publicApi` passes with a route-level test: `DELETE /api/entries/:id` for a referenced entry returns `409` and `body.error` contains the count; deleting an unreferenced entry returns `204` as before.
4. `pnpm --filter server test -- events` passes with a no-SSE test mirroring the existing `waitForEvent` pattern in `server/test/events.test.ts`: subscribe to `entry.deleted`, attempt a blocked delete (409), and assert no matching `entry.deleted` SSE event fires within the bounded wait; then assert a successful delete of an unreferenced entry *does* emit the event (proving the subscription works, so the negative assertion is meaningful).
5. `pnpm --filter client typecheck` passes stern-typed compiling of the new `referencer_count: number` field in `client/src/lib/api.ts` and the count-aware `DeleteConfirmDialog` description in `client/src/routes/ContentPage.tsx`. (No client test harness exists — `client/package.json` has `typecheck`/`build` only — so the automated verdict for the client half is the typecheck; the dialog behavior is additionally covered by the manual sanity step in Verify notes.)
6. `pnpm --filter client build` passes (full TS strict + Vite production build).

## Verify notes

The dev `data/` DB must be wiped before running `pnpm dev` as per PLAN-24's dev-DB note (the new baseline table).

Server: `pnpm --filter server test`. Client: `pnpm --filter client typecheck` then `pnpm --filter client build`. Manual sanity (optional, since no client test harness exists): create person + referenced car entries in the UI, open delete on the person entry, confirm the dialog warns with the count and the server 409s; also create two car entries (and a car with two fields pointing at the same person) to confirm the count reads as distinct entries.