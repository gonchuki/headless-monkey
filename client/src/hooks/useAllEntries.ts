import { useQueries } from "@tanstack/react-query";
import { apiFetch, type ContentListEntry } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type { PaginatedEntries } from "@/hooks/useEntries";
import { isStuck } from "@/lib/allViewPagination";
import type { AllViewState } from "@/lib/allViewPagination";

export interface AllEntriesQuery {
  data: ContentListEntry[];
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
  refetch: () => Promise<void>;
  /** Per-schema next cursors from live responses (for transition computation). */
  nextCursors: Record<string, string | null>;
  /** Per-schema prev cursors from live responses (for transition computation). */
  prevCursors: Record<string, string | null>;
}

export function useAllEntries(
  schemaNames: string[],
  state: AllViewState,
  limit: number,
): AllEntriesQuery {
  const schemas = [...new Set(schemaNames.filter((name) => name.length > 0))];

  // Build query configs only for visible (non-stuck) schemas
  const visibleSchemas = schemas.filter((schema) => !isStuck(state, schema));

  const queryConfigs = visibleSchemas.map((schema) => {
    const schemaState = state.schemas[schema];
    const cursor = schemaState?.cursor;
    const direction = schemaState?.direction;
    return { schema, cursor, direction };
  });

  const queries = useQueries({
    queries: queryConfigs.map(({ schema, cursor, direction }) => ({
      queryKey: [
        ...queryKeys.entries(schema),
        { allView: true, cursor, direction },
      ] as const,
      queryFn: () => {
        const params = new URLSearchParams();
        params.set("limit", String(limit));
        if (cursor != null) params.set("cursor", cursor);
        if (direction) params.set("direction", direction);
        const qs = params.toString();
        const url = `/api/schemas/${encodeURIComponent(schema)}/entries${qs ? `?${qs}` : ""}`;
        return apiFetch<PaginatedEntries>(url);
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

  // Extract per-schema cursors from live responses and collect entries
  const nextCursors: Record<string, string | null> = {};
  const prevCursors: Record<string, string | null> = {};
  const entries: ContentListEntry[] = [];

  for (let i = 0; i < queryConfigs.length; i++) {
    const schema = queryConfigs[i].schema;
    const paginated = queries[i].data as PaginatedEntries | undefined;
    if (paginated) {
      entries.push(...paginated.entries);
      nextCursors[schema] = paginated.pagination.nextCursor;
      prevCursors[schema] = paginated.pagination.prevCursor;
    }
  }

  // Sort by last_modified_date descending (existing behavior)
  const data = entries.sort(
    (a, b) =>
      a.last_modified_date < b.last_modified_date
        ? 1
        : a.last_modified_date > b.last_modified_date
          ? -1
          : 0,
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
    nextCursors,
    prevCursors,
  };
}
