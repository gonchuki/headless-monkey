import { useQueries } from "@tanstack/react-query";
import { apiFetch, type ContentListEntry } from "@/lib/api";
import { queryKeys } from "@/lib/query";

export interface AllEntriesQuery {
  data: ContentListEntry[];
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
  refetch: () => Promise<void>;
}

export function useAllEntries(schemaNames: string[]): AllEntriesQuery {
  const schemas = [...new Set(schemaNames.filter((name) => name.length > 0))];

  const queries = useQueries({
    queries: schemas.map((schema) => ({
      queryKey: queryKeys.entries(schema),
      queryFn: () => apiFetch<ContentListEntry[]>(`/api/schemas/${encodeURIComponent(schema)}/entries`),
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
    .flatMap((query) => query.data ?? [])
    .sort((a, b) => (a.last_modified_date < b.last_modified_date ? 1 : a.last_modified_date > b.last_modified_date ? -1 : 0));

  return {
    data,
    isPending,
    isError,
    isSuccess,
    error: errored?.error,
    refetch: async () => {
      await Promise.all(queries.map((query) => query.refetch()));
    },
  };
}
