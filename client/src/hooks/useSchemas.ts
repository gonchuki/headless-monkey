import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type FieldType, type SchemaEntry, type SchemaEntryRow } from "@/lib/api";
import { queryKeys } from "@/lib/query";

export interface SchemaDraft {
  id?: number;
  label: string;
  type: FieldType;
  required: boolean;
  ref_schema?: string;
}

export function useSchemas() {
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: queryKeys.schemas(),
    queryFn: () => apiFetch<SchemaEntry[]>("/api/schemas"),
  });

  const createMutation = useMutation({
    mutationFn: (input: { name: string; fields: SchemaDraft[] }) =>
      apiFetch<SchemaEntry>("/api/schemas", {
        method: "POST",
        body: JSON.stringify({ name: input.name, fields: input.fields }),
      }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.schemas() });
      const previous = queryClient.getQueryData<SchemaEntry[]>(queryKeys.schemas());
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.schemas(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schemas() });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, fields }: { name: string; fields: SchemaDraft[] }) =>
      apiFetch<SchemaEntry>(`/api/schemas/${encodeURIComponent(name)}`, {
        method: "PATCH",
        body: JSON.stringify({ fields }),
      }),
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schemas() });
      queryClient.invalidateQueries({ queryKey: queryKeys.schema(vars.name) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch<void>(`/api/schemas/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.schemas() });
      const previous = queryClient.getQueryData<SchemaEntry[]>(queryKeys.schemas());
      queryClient.setQueryData<SchemaEntry[]>(queryKeys.schemas(), (old) =>
        (old ?? []).filter((schema) => schema.name !== name),
      );
      queryClient.removeQueries({ queryKey: queryKeys.schema(name) });
      return { previous };
    },
    onError: (_error, _name, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.schemas(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schemas() });
    },
  });

  return {
    listQuery,
    create: createMutation,
    update: updateMutation,
    remove: deleteMutation,
  };
}

export function useSchemaEntryCount(schemaName: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.entries(schemaName),
    queryFn: () => apiFetch<SchemaEntryRow[]>(`/api/schemas/${encodeURIComponent(schemaName)}/entries`),
    enabled,
    select: (rows) => rows.length,
  });
}
