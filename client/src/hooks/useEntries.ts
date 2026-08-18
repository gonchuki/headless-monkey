import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type ContentEntry, type ContentListEntry, type ContentValue, type PaginationResponse } from "@/lib/api";
import { queryKeys } from "@/lib/query";

export type EntryValues = Record<string, ContentValue | null>;

export interface PaginationParams {
  limit?: number;
  /** Opaque cursor string from the server's pagination response. */
  cursor?: string;
  direction?: "forward" | "backward";
}

export interface SortParams {
  sortField: string;
  sortOrder: "asc" | "desc";
}

export interface PaginatedEntries {
  entries: ContentListEntry[];
  pagination: PaginationResponse;
}

/**
 * Pagination params as carried by one entries list request.
 *
 * `direction` is intentionally a plain string: single-schema requests use the
 * wire tokens `"forward"`/`"backward"` (see `PaginationParams`), while the
 * all-view state machine uses `"fwd"`/`"bwd"`. Values are carried verbatim
 * into both the query key and the URL, preserving each caller's historical
 * request byte-for-byte.
 */
export interface EntriesPagination {
  /** Without `limit` the server returns all rows flat (no cursors). */
  limit?: number;
  cursor?: string;
  direction?: string;
}

/**
 * One entries list request: query key, fetch function, and list URL.
 *
 * Every caller that reads the content listing — the single-schema hook, the
 * all-view per-schema hook, and the page-reconstruction walk — builds its
 * request here so that identical params always produce identical query keys
 * and hit the same list URL (and therefore the same cache entry).
 */
export interface EntriesRequest {
  schema: string;
  /** Paginated request when present. Listings always pass `limit`. */
  pagination?: EntriesPagination;
  /** Sort is single-schema only; omitted for all-view requests. */
  sort?: SortParams;
  conflicted: boolean;
  /** All-view marker: no sort params, and the `allView` key shape. */
  allView?: boolean;
}

/**
 * Build the query key + fetch function for one schema-entries request.
 * `queryKey` mirrors the historical key shapes exactly (single-schema keys
 * nest `{ pagination }`/`{ sort }`, all-view keys carry
 * `{ allView, cursor, direction, conflicted }`) so cache behavior is unchanged.
 */
export function buildEntriesRequest({ schema, pagination, sort, conflicted, allView = false }: EntriesRequest): {
  queryKey: readonly unknown[];
  queryFn: () => Promise<PaginatedEntries | ContentListEntry[]>;
} {
  const queryKey = allView
    ? ([
        ...queryKeys.entries(schema),
        { allView: true, cursor: pagination?.cursor, direction: pagination?.direction, conflicted },
      ] as const)
    : pagination
      ? ([...queryKeys.entries(schema), { pagination }, { sort }, { conflicted }] as const)
      : ([...queryKeys.entries(schema), { sort }, { conflicted }] as const);

  const queryFn = () => {
    const params = new URLSearchParams();
    if (pagination?.limit != null) params.set("limit", String(pagination.limit));
    if (pagination?.cursor != null) params.set("cursor", String(pagination.cursor));
    if (pagination?.direction) params.set("direction", pagination.direction);
    if (!allView) {
      if (sort?.sortField) params.set("sort_field", sort.sortField);
      if (sort?.sortOrder) params.set("sort_order", sort.sortOrder);
    }
    if (conflicted) params.set("conflicted", "1");
    const qs = params.toString();
    const url = `/api/schemas/${encodeURIComponent(schema)}/entries${qs ? `?${qs}` : ""}`;
    if (pagination) {
      return apiFetch<PaginatedEntries>(url);
    }
    return apiFetch<ContentListEntry[]>(url);
  };

  return { queryKey, queryFn };
}

export interface UseEntriesResult {
  entries: ContentListEntry[];
  pagination: PaginationResponse;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<void>;
  create: ReturnType<typeof useMutation<ContentEntry, Error, { schema: string; values: EntryValues }>>;
}

export function useEntries(
  schemaName: string,
  enabled = true,
  pagination?: PaginationParams,
  sort?: SortParams,
  conflictedOnly = false
): UseEntriesResult {
  const queryClient = useQueryClient();
  const { queryKey, queryFn } = buildEntriesRequest({
    schema: schemaName,
    pagination,
    sort,
    conflicted: conflictedOnly,
  });

  const query = useQuery<PaginatedEntries | ContentListEntry[]>({
    queryKey,
    queryFn,
    enabled: enabled && schemaName.length > 0,
  });

  // Normalize: always expose flat entries + pagination
  const data = query.data;
  let entries: ContentListEntry[];
  let paginationResponse: PaginationResponse;

  if (pagination && data != null && "entries" in data) {
    const paginated = data as PaginatedEntries;
    entries = paginated.entries;
    paginationResponse = paginated.pagination;
  } else if (Array.isArray(data)) {
    entries = data;
    paginationResponse = { nextCursor: null, prevCursor: null };
  } else {
    entries = [];
    paginationResponse = { nextCursor: null, prevCursor: null };
  }

  const create = useMutation({
    mutationFn: ({ schema, values }: { schema: string; values: EntryValues }) =>
      apiFetch<ContentEntry>(`/api/schemas/${encodeURIComponent(schema)}/entries`, {
        method: "POST",
        body: JSON.stringify({ values }),
      }),
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.entries(vars.schema) });
    },
  });

  return {
    entries,
    pagination: paginationResponse,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: async () => { await query.refetch(); },
    create,
  };
}
