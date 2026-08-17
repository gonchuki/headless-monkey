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
  const key = pagination
    ? [...queryKeys.entries(schemaName), { pagination }, { sort }, { conflicted: conflictedOnly }] as const
    : [...queryKeys.entries(schemaName), { sort }, { conflicted: conflictedOnly }] as const;

  const query = useQuery<PaginatedEntries | ContentListEntry[]>({
    queryKey: key,
    queryFn: () => {
      const params = new URLSearchParams();
      if (pagination?.limit != null) params.set("limit", String(pagination.limit));
      if (pagination?.cursor != null) params.set("cursor", String(pagination.cursor));
      if (pagination?.direction) params.set("direction", pagination.direction);
      if (sort?.sortField) params.set("sort_field", sort.sortField);
      if (sort?.sortOrder) params.set("sort_order", sort.sortOrder);
      if (conflictedOnly) params.set("conflicted", "1");
      const qs = params.toString();
      const url = `/api/schemas/${encodeURIComponent(schemaName)}/entries${qs ? `?${qs}` : ""}`;
      if (pagination) {
        return apiFetch<PaginatedEntries>(url);
      }
      return apiFetch<ContentListEntry[]>(url);
    },
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
