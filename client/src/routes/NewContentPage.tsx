import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "@phosphor-icons/react";
import { DynamicEntryForm, type EntryValues } from "@/components/DynamicEntryForm";
import { NewEntrySelector } from "@/components/NewEntrySelector";
import { PageSkeleton } from "@/components/shared/PageSkeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useEntries } from "@/hooks/useEntries";
import { useSchemas } from "@/hooks/useSchemas";
import { apiFetch, type SchemaEntry } from "@/lib/api";
import { queryKeys } from "@/lib/query";

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export default function NewContentPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const targetList = typeof location.state?.list === "string" ? location.state.list : "/content";
  const { listQuery: schemasQuery } = useSchemas();
  const [schemaName, setSchemaName] = useState<string | null>(null);

  const schemas = schemasQuery.data ?? [];
  const selected = schemaName ?? schemas[0]?.name ?? null;

  const schemaQuery = useQuery({
    queryKey: queryKeys.schema(selected ?? ""),
    queryFn: () => apiFetch<SchemaEntry>(`/api/schemas/${encodeURIComponent(selected ?? "")}`),
    enabled: selected != null,
  });

  const { create } = useEntries(selected ?? "");

  useEffect(() => {
    if (schemaName == null && schemas[0] != null) {
      setSchemaName(schemas[0].name);
    }
  }, [schemaName, schemas]);

  function handleSubmit(values: EntryValues) {
    if (selected == null) return;
    create.mutate(
      { schema: selected, values },
      {
        onSuccess: () => {
          toast.add({ type: "success", title: "Entry created" });
          navigate(targetList, { replace: true });
        },
      },
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Button type="button" variant="ghost" size="icon" aria-label="Back to content" onClick={() => navigate(targetList)}>
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Button>
        <div>
          <h1 className="font-heading text-xl font-semibold">New content</h1>
          <p className="text-sm text-muted-foreground">Create an entry for a schema.</p>
        </div>
      </div>

      <div className="max-w-xs">
        <NewEntrySelector value={selected ?? undefined} onChange={setSchemaName} />
      </div>

      {schemasQuery.isSuccess && schemas.length === 0 && (
        <Alert>
          <AlertTitle>No schemas yet</AlertTitle>
          <AlertDescription>Create a schema before adding content.</AlertDescription>
        </Alert>
      )}

      {selected != null && schemaQuery.isPending && <PageSkeleton />}

      {selected != null && schemaQuery.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load schema</AlertTitle>
          <AlertDescription>{errorMessage(schemaQuery.error) ?? "Unknown error"}</AlertDescription>
        </Alert>
      )}

      {selected != null && schemaQuery.isSuccess && schemaQuery.data && (
        <DynamicEntryForm
          key={`new-${selected}`}
          schema={schemaQuery.data}
          initialValues={Object.fromEntries(schemaQuery.data.fields.map((field) => [String(field.id), null]))}
          loadKey={`new-${selected}`}
          submitLabel="Create entry"
          pending={create.isPending}
          submitError={create.isError ? errorMessage(create.error) : null}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}
