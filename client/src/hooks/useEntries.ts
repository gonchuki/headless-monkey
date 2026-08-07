import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type ContentEntry, type ContentListEntry, type ContentValue } from "@/lib/api";
import { queryKeys } from "@/lib/query";

export type EntryValues = Record<string, ContentValue | null>;

export function useEntries(schemaName: string) {
  const queryClient = useQueryClient();
  const key = queryKeys.entries(schemaName);

  const listQuery = useQuery({
    queryKey: key,
    queryFn: () => apiFetch<ContentListEntry[]>(`/api/schemas/${encodeURIComponent(schemaName)}/entries`),
    enabled: schemaName.length > 0,
  });

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

  const update = useMutation({
    mutationFn: ({ id, values }: { id: number; values: EntryValues }) =>
      apiFetch<ContentEntry>(`/api/entries/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ values }),
      }),
    onMutate: async ({ id, values }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ContentListEntry[]>(key);
      queryClient.setQueryData<ContentListEntry[]>(key, (old) =>
        (old ?? []).map((entry) =>
          entry.id === id ? { ...entry, values: values as Record<string, ContentValue> } : entry,
        ),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(key, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiFetch<void>(`/api/entries/${id}`, { method: "DELETE" }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ContentListEntry[]>(key);
      queryClient.setQueryData<ContentListEntry[]>(key, (old) => (old ?? []).filter((entry) => entry.id !== id));
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(key, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key });
    },
  });

  return { listQuery, create, update, remove };
}
