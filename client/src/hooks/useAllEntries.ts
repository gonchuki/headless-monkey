import { useQueries } from "@tanstack/react-query";
import { apiFetch, type ContentListEntry, type PaginationResponse } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type { PaginationParams, PaginatedEntries } from "@/hooks/useEntries";

export interface AllEntriesQuery {
  data: ContentListEntry[];
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
  refetch: () => Promise<void>;
  pagination: PaginationResponse;
}

export function useAllEntries(schemaNames: string[], pagination?: PaginationParams): AllEntriesQuery {
  const schemas = [...new Set(schemaNames.filter((name) => name.length > 0))];

  const queries = useQueries({
    queries: schemas.map((schema) => ({
      queryKey: pagination
        ? [...queryKeys.entries(schema), { pagination }] as const
        : queryKeys.entries(schema),
      queryFn: () => {
        const params = new URLSearchParams();
        if (pagination?.limit != null) params.set("limit", String(pagination.limit));
        if (pagination?.cursor != null) params.set("cursor", String(pagination.cursor));
        if (pagination?.direction) params.set("direction", pagination.direction);
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

  const data = queries
    .flatMap((query) => {
      if (pagination) {
        return (query.data as PaginatedEntries | undefined)?.entries ?? [];
      }
      return (query.data as ContentListEntry[] | undefined) ?? [];
    })
    .sort((a, b) => (a.last_modified_date < b.last_modified_date ? 1 : a.last_modified_date > b.last_modified_date ? -1 : 0));

  // Merge pagination from all queries: nextCursor is the smallest non-null,
  // prevCursor is the largest non-null (any schema having more = "has more").
  const mergedPagination: PaginationResponse = pagination
    ? {
        nextCursor: queries.reduce<number | null>((acc, q) => {
          const p = (q.data as PaginatedEntries | undefined)?.pagination;
          if (p?.nextCursor == null) return null;
          return acc == null ? p.nextCursor : Math.min(acc, p.nextCursor);
        }, null),
        prevCursor: queries.reduce<number | null>((acc, q) => {
          const p = (q.data as PaginatedEntries | undefined)?.pagination;
          if (p?.prevCursor == null) return null;
          return acc == null ? p.prevCursor : Math.max(acc, p.prevCursor);
        }, null),
      }
    : { nextCursor: null, prevCursor: null };

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
