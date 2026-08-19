import { useQuery } from "@tanstack/react-query";
import type { ContentListEntry, PaginationResponse } from "@/lib/api";
import { buildAllEntriesRequest, type PaginatedEntries } from "@/hooks/useEntries";

export interface AllEntriesQuery {
  entries: ContentListEntry[];
  pagination: PaginationResponse;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<void>;
}

/**
 * The global (all-schemas) content listing: a single `useQuery` on
 * `GET /api/content`. The server owns which schemas exist and returns one
 * globally-ordered, keyset-paginated page — no client-side merge or re-sort.
 *
 * `anchor` is the `{ cursor?, direction? }` position for pages > 1 (page 1
 * is implicitly anchored). `enabled` gates the fetch (e.g. the all-view is
 * not active, or schemas have not loaded yet on a fresh install).
 */
export function useAllEntries(
  limit: number,
  conflictedOnly = false,
  anchor?: { cursor?: string; direction?: "forward" | "backward" },
  enabled = true,
): AllEntriesQuery {
  const { queryKey, queryFn } = buildAllEntriesRequest({
    limit,
    cursor: anchor?.cursor,
    direction: anchor?.direction,
    conflicted: conflictedOnly,
  });

  const query = useQuery<PaginatedEntries>({ queryKey, queryFn, enabled });

  return {
    entries: query.data?.entries ?? [],
    pagination: query.data?.pagination ?? { nextCursor: null, prevCursor: null },
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: async () => {
      await query.refetch();
    },
  };
}
