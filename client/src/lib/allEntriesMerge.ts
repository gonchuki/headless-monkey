import { compareRawCursors } from "@/lib/cursor";
import type { ContentListEntry, PaginationResponse } from "@/lib/api";

/** Per-schema query result as consumed by the merge function. */
export interface SchemaPage {
  entries: ContentListEntry[];
  pagination: PaginationResponse | undefined;
}

/** Merged output combining entries and pagination across schemas. */
export interface MergedAllEntries {
  data: ContentListEntry[];
  pagination: PaginationResponse;
}

/**
 * Merge per-schema query results into a single cross-schema view.
 *
 * Entries are concatenated and sorted by `last_modified_date` descending.
 * Pagination cursors are merged using `compareRawCursors`:
 * - `nextCursor` = minimum across schemas (null if any schema's is null — known bug, pinned for PLAN-64).
 * - `prevCursor` = maximum across schemas (null if any schema's is null).
 *
 * When `paginated` is false, returns flat entries with all-null pagination.
 */
export function mergeAllEntriesPages(
  pages: SchemaPage[],
  paginated: boolean,
): MergedAllEntries {
  if (!paginated) {
    return {
      data: pages.flatMap((page) => page.entries),
      pagination: { nextCursor: null, prevCursor: null },
    };
  }

  const data = pages
    .flatMap((page) => page.entries)
    .sort(
      (a, b) =>
        a.last_modified_date < b.last_modified_date
          ? 1
          : a.last_modified_date > b.last_modified_date
            ? -1
            : 0,
    );

  const nextCursor = pages.reduce<string | null>((acc, page) => {
    const p = page.pagination;
    if (p?.nextCursor == null) return null;
    if (acc == null) return p.nextCursor;
    const cmp = compareRawCursors(p.nextCursor, acc);
    return cmp !== null && cmp <= 0 ? p.nextCursor : acc;
  }, null);

  const prevCursor = pages.reduce<string | null>((acc, page) => {
    const p = page.pagination;
    if (p?.prevCursor == null) return null;
    if (acc == null) return p.prevCursor;
    const cmp = compareRawCursors(p.prevCursor, acc);
    return cmp !== null && cmp >= 0 ? p.prevCursor : acc;
  }, null);

  return {
    data,
    pagination: { nextCursor, prevCursor },
  };
}
