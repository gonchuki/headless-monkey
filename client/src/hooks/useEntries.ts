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
 * Pagination params as carried by one entries list request. Direction tokens
 * on the wire are the canonical `"forward"`/`"backward"` only (see
 * `PaginationParams`); they are carried verbatim into both the query key and
 * the URL.
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
 * Every caller that reads a single-schema listing — the `useEntries` hook and
 * the page-reconstruction walk — builds its request here so that identical
 * params always produce identical query keys and hit the same list URL (and
 * therefore the same cache entry). The all-view equivalent is
 * {@link buildAllEntriesRequest}.
 */
export interface EntriesRequest {
  schema: string;
  /** Paginated request when present. Listings always pass `limit`. */
  pagination?: EntriesPagination;
  /** Sort is single-schema only; omitted for all-view requests. */
  sort?: SortParams;
  conflicted: boolean;
}

/**
 * Build the query key + fetch function for one schema-entries request.
 * `queryKey` mirrors the historical key shapes exactly (keys nest
 * `{ pagination }`/`{ sort }`) so cache behavior is unchanged.
 */
export function buildEntriesRequest({ schema, pagination, sort, conflicted }: EntriesRequest): {
  queryKey: readonly unknown[];
  queryFn: () => Promise<PaginatedEntries | ContentListEntry[]>;
} {
  const queryKey = pagination
    ? ([...queryKeys.entries(schema), { pagination }, { sort }, { conflicted }] as const)
    : ([...queryKeys.entries(schema), { sort }, { conflicted }] as const);

  const queryFn = () => {
    const params = new URLSearchParams();
    if (pagination?.limit != null) params.set("limit", String(pagination.limit));
    if (pagination?.cursor != null) params.set("cursor", String(pagination.cursor));
    if (pagination?.direction) params.set("direction", pagination.direction);
    if (sort?.sortField) params.set("sort_field", sort.sortField);
    if (sort?.sortOrder) params.set("sort_order", sort.sortOrder);
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

/**
 * One global (all-schemas) listing request against `GET /api/content`:
 * query key + fetch function. The key is the `allEntries` family (object
 * sentinel `{ view: "all" }`, so no schema name can collide) plus ONE stable
 * params object. No sort params ever — server order is authoritative.
 */
export interface AllEntriesRequest {
  limit?: number;
  cursor?: string;
  direction?: "forward" | "backward";
  conflicted: boolean;
}

export function buildAllEntriesRequest({ limit, cursor, direction, conflicted }: AllEntriesRequest): {
  queryKey: readonly unknown[];
  queryFn: () => Promise<PaginatedEntries>;
} {
  const queryKey = [
    ...queryKeys.allEntries(),
    { limit, cursor, direction, conflicted },
  ] as const;

  const queryFn = () => {
    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    if (cursor != null) params.set("cursor", cursor);
    if (direction) params.set("direction", direction);
    if (conflicted) params.set("conflicted", "1");
    const qs = params.toString();
    return apiFetch<PaginatedEntries>(`/api/content${qs ? `?${qs}` : ""}`);
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
