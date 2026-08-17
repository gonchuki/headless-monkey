# PLAN-38: Server Pagination

## Goal

Add bidirectional cursor-based pagination to all content listing endpoints (`GET /api/content/:schema` public route and `GET /api/schemas/:name/entries` editor route). Entries are fetched in chunks of configurable size, with `nextCursor` and `prevCursor` enabling stable forward and backward navigation.

## Files Involved

- `server/src/repositories/contentRepo.ts` — `listEntries` method signature and SQL
- `server/src/services/contentService.ts` — `listForSchema`, `listPublic` signatures
- `server/src/routes/entries.ts` — parse query params for editor API
- `server/src/routes/content.ts` — parse query params for public API
- `server/src/types.ts` — pagination types
- `server/test/contentService.test.ts` — pagination tests
- `server/test/publicApi.test.ts` — public API pagination tests

## Implementation Approach

### 1. Add pagination types to `types.ts`

Define `PaginationParams` interface with `limit?: number`, `cursor?: number`, `direction?: 'forward' | 'backward'`. Define `PaginationResponse` with `nextCursor: number | null` and `prevCursor: number | null`.

### 2. Modify `ContentRepository.listEntries()`

Change the SQL query to support cursor-based pagination:
- Add `LIMIT ?` clause
- For forward direction (default): `WHERE id < ? ORDER BY id DESC` when cursor is provided
- For backward direction: `WHERE id > ? ORDER BY id ASC` when cursor is provided
- Default order: `ORDER BY id DESC` (newest first)
- Fetch `limit + 1` rows to determine if `nextCursor` should be set (the extra row indicates more data exists)
- Return the pagination metadata alongside the entry rows

The query must still join `content_rows` and `content_refs` per entry as it does today—pagination only affects which entries are returned, not how their data is loaded.

### 3. Modify `ContentService.listForSchema()` and `listPublic()`

Add `pagination?: PaginationParams` parameter. Pass through to repository. Return `{ entries: ContentListEntry[], pagination: PaginationResponse }` instead of a plain array. The conflict filter (`conflict: boolean`) and `referencer_count` continue to work as before—pagination applies after filtering.

### 4. Modify routes

**`entries.ts`** (editor route `GET /api/schemas/:name/entries`):
- Parse `limit` (default 50, clamped to [1, 200]), `cursor`, `direction` from query params
- Pass to `contentService.listForSchema()`
- Return `{ entries, pagination }` in response body

**`content.ts`** (public route `GET /api/content/:schema`):
- Same query param parsing
- Pass to `contentService.listPublic()`
- Return `{ schema, entries, pagination }` in response body (the existing `{ schema, entries }` envelope gains `pagination`)

### 5. Update tests

**`contentService.test.ts`**: Tests for forward/backward cursor navigation, limit clamping, edge cases (empty schema, single page, exact multiple of limit).
**`publicApi.test.ts`**: Tests for public API pagination response shape, cursor stability across requests.
**Existing tests in `refIntegrity.test.ts`**: Must continue to pass—pagination defaults should return all entries when no params are provided, or tests must use explicit pagination.

## Edge Cases

- **Limit clamping**: `limit=0` → 1, `limit=999` → 200, negative → 1
- **Invalid cursor**: Non-numeric or negative cursor treated as no cursor (first page)
- **Cursor beyond data**: Returns empty entries with null cursors (graceful handling)
- **Empty schema**: Returns empty entries array with null cursors immediately
- **Exact multiple of limit**: e.g., 100 entries, limit=50, page 2 should have `nextCursor: null`
- **Single entry**: Both cursors null, one entry returned
- **Direction param validation**: Only 'forward' or 'backward' accepted, default is 'forward'

## Acceptance Criteria

1. `GET /api/content/car?limit=2` returns at most 2 entries with `pagination.nextCursor` set when more entries exist
2. `GET /api/content/car?limit=2&cursor=<nextCursor>` returns the next page of entries
3. `GET /api/content/car?limit=2&cursor=<prevCursor>&direction=backward` returns the previous page
4. First page has `pagination.prevCursor: null`, last page has `pagination.nextCursor: null`
5. `GET /api/schemas/car/entries?limit=10` returns paginated response with same shape
6. `limit` clamped to [1, 200]—`?limit=0` returns 1 entry, `?limit=999` returns at most 200
7. Invalid cursor (non-numeric) returns first page as if no cursor provided
8. Empty schema returns `{ entries: [], pagination: { nextCursor: null, prevCursor: null } }`
9. Existing tests in `contentService.test.ts`, `publicApi.test.ts`, and `refIntegrity.test.ts` pass without modification (backward compatibility via sensible defaults)
10. `pnpm test` passes
