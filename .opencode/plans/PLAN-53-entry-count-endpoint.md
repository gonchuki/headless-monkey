# PLAN-53 — Add entry count aggregation endpoint

**Goal:** Replace the client's `useSchemaEntryCount` hook, which fetches ALL entries just to count them, with a dedicated server endpoint that returns only the count. Eliminates O(n) bandwidth waste on every schema list render.

**Depends on:** none.

## Files

- `server/src/repositories/contentRepo.ts` — add `countBySchema(name)` method
- `server/src/services/contentService.ts` — add `countForSchema(name)` method
- `server/src/routes/entries.ts` — add `GET /count` route
- `server/test/contentService.test.ts` — add count endpoint tests
- `client/src/lib/query.ts` — add `entryCount` query key
- `client/src/lib/api.ts` — add `EntryCountResponse` type
- `client/src/hooks/useSchemas.ts` — rewrite `useSchemaEntryCount` to use new endpoint

## Steps

1. Add `countBySchema(schemaName: string): number` to `ContentRepository`. Single query: `SELECT COUNT(*) AS count FROM content WHERE schema = ?`. Return the count.

2. Add `countForSchema(schemaName: string): number` to `ContentService`. Delegates to `this.repo.countBySchema(schemaName)`.

3. Add `GET /count` route to the entries router (mounted at `/api/schemas/:name/entries`). This route returns `{ count: number }`. It requires the same editor auth guard as the other entries routes.

4. Add `EntryCountResponse = { count: number }` type to `client/src/lib/api.ts`.

5. Add `entryCount: (schema: string) => ["schemas", "entryCount", schema] as const` to the query key factory in `client/src/lib/query.ts`.

6. Rewrite `useSchemaEntryCount` in `client/src/hooks/useSchemas.ts` to use `useQuery` with the new `/api/schemas/:name/entries/count` endpoint and `EntryCountResponse` type. Remove the `select: (rows) => rows.length` hack.

7. Add tests: count returns 0 for empty schema, returns correct count after inserts, returns correct count after deletes.

## Edge cases

- Schema with zero entries — returns `{ count: 0 }`.
- Schema does not exist — 404 (follows existing entries route pattern).

## Acceptance criteria

1. `pnpm --filter server test` passes with new count tests.
2. `pnpm --filter client build` succeeds.
3. `GET /api/schemas/:name/entries/count` returns `{ count: N }` where N matches the actual entry count.
4. The schema editor's `PendingDeletionBanner` displays the correct entry count without fetching all entries (verify by inspecting network tab: only the count endpoint is called, not the full entries list).
