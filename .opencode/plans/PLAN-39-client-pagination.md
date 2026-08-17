# PLAN-39: Client Pagination

## Goal

Add URL-based pagination state and shadcn `<Pagination />` UI to content listings in the control panel. Users can navigate between pages using prev/next buttons, with pagination state persisted in URL search params for bookmarking and sharing.

**Depends on:** PLAN-38 (server pagination must be implemented first).

## Files Involved

- `client/src/hooks/useEntries.ts` — pagination state management
- `client/src/hooks/useAllEntries.ts` — pagination state management for all schemas view
- `client/src/routes/ContentPage.tsx` — `<Pagination />` UI integration
- `client/src/lib/api.ts` — type updates for paginated responses

## Implementation Approach

### 1. Update API types in `lib/api.ts`

Add `PaginationResponse` type matching the server's `{ nextCursor: number | null, prevCursor: number | null }` shape. Update content listing response types to include `pagination` field.

### 2. Modify `useEntries` hook

Add pagination state management:
- Read `page`, `cursor_next`, `cursor_prev` from URL search params
- Pass `limit`, `cursor`, `direction` to API requests based on current pagination state
- Expose `nextPage()`, `prevPage()`, `resetPagination()` methods
- Track `hasNextPage` and `hasPrevPage` from response's `pagination.nextCursor` and `pagination.prevCursor`
- Default `limit=50`

When navigating to next page: store `nextCursor` as `cursor_next`, clear `cursor_prev`.
When navigating to prev page: store `prevCursor` as `cursor_prev`, clear `cursor_next`.

### 3. Modify `useAllEntries` hook

Same pagination pattern as `useEntries`, but applied across all schemas. Each schema's query uses the same pagination params so the merged list is consistent.

### 4. Update `ContentPage.tsx`

Add shadcn `<Pagination />` component below the entries list:
- Render prev button disabled when `!hasPrevPage`
- Render next button disabled when `!hasNextPage`
- Show "Page N" indicator (computed from cursor depth or simple page counter)
- Pagination component appears only when entries exist and are paginable
- Skeleton loader during page transitions

URL state shape: `?page=2&cursor_next=42&cursor_prev=20` — the `page` param is informational (for display), the cursors drive the actual queries.

### 5. Integrate with existing filters

The conflicted filter (`?conflicted=1`) composes with pagination—both persist in URL state. Schema selector changes reset pagination to first page.

## Edge Cases

- **Direct URL access**: Opening `?page=3&cursor_next=42` should work correctly (server validates cursor)
- **Stale cursors**: If entries are deleted between pages, the cursor may return fewer entries—graceful handling
- **Empty result after navigation**: Show "No entries" alert instead of empty pagination
- **Pagination reset on schema change**: When switching schemas in the selector, reset to page 1
- **Conflicted filter + pagination**: Both filters compose correctly in URL state

## Acceptance Criteria

1. `ContentPage` renders shadcn `<Pagination />` component below entries list when entries exist
2. Clicking "Next" advances to next page, URL updates with new cursors
3. Clicking "Prev" goes to previous page, URL updates with new cursors
4. First page: "Prev" button disabled, `cursor_prev` not in URL
5. Last page: "Next" button disabled, `cursor_next` is null or absent
6. URL `?page=2&cursor_next=42` loads correctly when opened directly
7. Switching schema selector resets pagination to first page
8. Conflicted filter (`?conflicted=1`) persists across page navigation
9. `useEntries` hook exposes `nextPage()`, `prevPage()` methods that update URL state
10. `pnpm build` succeeds (client compiles without errors)
