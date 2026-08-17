import { useQueries } from "@tanstack/react-query";
import { apiFetch, type ContentListEntry, type PaginationResponse } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { mergeAllEntriesPages } from "@/lib/allEntriesMerge";
import type { PaginationParams, SortParams, PaginatedEntries } from "@/hooks/useEntries";

export interface AllEntriesQuery {
  data: ContentListEntry[];
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
  refetch: () => Promise<void>;
  pagination: PaginationResponse;
}

export function useAllEntries(schemaNames: string[], pagination?: PaginationParams, sort?: SortParams): AllEntriesQuery {
  const schemas = [...new Set(schemaNames.filter((name) => name.length > 0))];

  const queries = useQueries({
    queries: schemas.map((schema) => ({
      queryKey: pagination
        ? [...queryKeys.entries(schema), { pagination }, { sort }] as const
        : queryKeys.entries(schema),
      queryFn: () => {
        const params = new URLSearchParams();
        if (pagination?.limit != null) params.set("limit", String(pagination.limit));
        if (pagination?.cursor != null) params.set("cursor", String(pagination.cursor));
        if (pagination?.direction) params.set("direction", pagination.direction);
        if (sort?.sortField) params.set("sort_field", sort.sortField);
        if (sort?.sortOrder) params.set("sort_order", sort.sortOrder);
        const qs = params.toString();
        const url = `/api/schemas/${encodeURIComponent(schema)}/entries${qs ? `?${qs}` : ""}`;
        if (pagination) {
          return apiFetch<PaginatedEntries>(url);
        }
        return apiFetch<ContentListEntry[]>(url);
      },
      enabled: schema.length > 0,
    })),
  });

  const errored = queries.find((query) => query.isError);
  const anyPending = queries.some((query) => query.isPending);
  const anySuccess = queries.some((query) => query.isSuccess);

  const isError = errored != null;
  const isPending = !isError && anyPending && !anySuccess;
  const isSuccess = !isError && !isPending;

  const pages = queries.map((query) => {
    if (pagination) {
      const paginated = query.data as PaginatedEntries | undefined;
      return {
        entries: paginated?.entries ?? [],
        pagination: paginated?.pagination,
      };
    }
    return {
      entries: (query.data as ContentListEntry[] | undefined) ?? [],
      pagination: undefined,
    };
  });

  const { data, pagination: mergedPagination } = mergeAllEntriesPages(
    pages,
    pagination != null,
  );

  return {
    data,
    isPending,
    isError,
    isSuccess,
    error: errored?.error,
    refetch: async () => {
      await Promise.all(queries.map((query) => query.refetch()));
    },
    pagination: mergedPagination,
  };
}
