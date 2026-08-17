import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type ContentEntry, type ContentListEntry } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type { EntryValues } from "@/hooks/useEntries";

/** Delete a single entry by id. Optimistically removes it from every cache under the entries prefix. */
export function useDeleteEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: { id: number; schema: string }) =>
      apiFetch<void>(`/api/entries/${vars.id}`, { method: "DELETE" }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.entries(vars.schema) });

      // Optimistically remove from every cached query under the entries prefix.
      // Handles both flat list (ContentListEntry[]) and paginated ({ entries, pagination }) shapes.
      const previous = queryClient.setQueriesData(
        { queryKey: queryKeys.entries(vars.schema) },
        (old: ContentListEntry[] | { entries: ContentListEntry[]; pagination: unknown } | undefined) => {
          if (!old) return old;
          if (Array.isArray(old)) {
            return old.filter((entry) => entry.id !== vars.id);
          }
          if ("entries" in old) {
            return { ...old, entries: old.entries.filter((entry) => entry.id !== vars.id) };
          }
          return old;
        },
      );

      return { previous };
    },
    onError: (_error, _vars, context) => {
      // Rollback optimistic removal.
      if (context?.previous) {
        for (const entry of context.previous) {
          queryClient.setQueryData(entry[0], entry[1]);
        }
      }
    },
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.entries(vars.schema) });
    },
  });
}

/** Update a single entry by id. No optimistic write — the editor navigates away on success. */
export function useUpdateEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, values }: { id: number; values: EntryValues }) =>
      apiFetch<ContentEntry>(`/api/entries/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ values }),
      }),
    onSettled: () => {
      // Invalidate all entry queries so lists refetch with fresh data.
      queryClient.invalidateQueries({ queryKey: ["schemas", "entries"] });
    },
  });
}
