import { useLocation, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "@phosphor-icons/react";
import { DynamicEntryForm, type EntryValues } from "@/components/DynamicEntryForm";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useEntries } from "@/hooks/useEntries";
import { useRealtime } from "@/hooks/useRealtime";
import { apiFetch, type SchemaEntry } from "@/lib/api";
import { deriveInitialValues } from "@/lib/entries";
import { queryKeys } from "@/lib/query";

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export default function ContentEditorPage() {
  const { schema: schemaName = "", id: idParam = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const targetList = typeof location.state?.list === "string" ? location.state.list : "/content";
  const entryId = Number(idParam);

  const schemaQuery = useQuery({
    queryKey: queryKeys.schema(schemaName),
    queryFn: () => apiFetch<SchemaEntry>(`/api/schemas/${encodeURIComponent(schemaName)}`),
  });

  const { listQuery, update } = useEntries(schemaName);

  // Live stream: both schema and entry events affect the open entry.
  const { deletedSchemas } = useRealtime({ schemas: [schemaName] });
  const schemaDeleted = deletedSchemas.has(schemaName);

  if (schemaQuery.isPending || listQuery.isPending) {
    return <PageSkeleton />;
  }

  const schema = schemaQuery.data;
  if (!schema) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="icon" aria-label="Back to content" onClick={() => navigate(targetList)}>
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
          <h1 className="font-heading text-xl font-semibold">Schema not found</h1>
        </div>
        <Alert variant="destructive">
          <AlertTitle>Could not load this schema</AlertTitle>
          <AlertDescription>{errorMessage(schemaQuery.error) ?? "Unknown error"}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const entry = listQuery.data?.find((candidate) => candidate.id === entryId);
  if (!entry) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="icon" aria-label="Back to content" onClick={() => navigate(targetList)}>
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
          <h1 className="font-heading text-xl font-semibold">Entry not found</h1>
        </div>
        <Alert variant="destructive">
          <AlertTitle>Could not load this entry</AlertTitle>
          <AlertDescription>
            Entry #{entryId} does not exist in schema {schemaName}.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const targetEntry = entry;
  const initialValues = deriveInitialValues(schema, targetEntry);
  const loadKey = `${targetEntry.id}:${targetEntry.conflict}:${targetEntry.schema_version}`;

  function handleSubmit(values: EntryValues) {
    update.mutate(
      { id: targetEntry.id, values },
      {
        onSuccess: () => {
          toast.add({ type: "success", title: "Entry saved" });
          navigate(targetList, { replace: true });
        },
      },
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="icon" aria-label="Back to content" onClick={() => navigate(targetList)}>
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
          <div>
            <h1 className="font-heading text-xl font-semibold">Edit entry</h1>
            <p className="text-sm text-muted-foreground">
              {schema.name} · #{targetEntry.id}
              {targetEntry.conflict ? " · conflicted" : ""}
            </p>
          </div>
        </div>
      </div>

      {targetEntry.conflict && (
        <Alert>
          <AlertTitle>This entry is out of date</AlertTitle>
          <AlertDescription>
            The schema changed after this entry was saved. Fields with outdated values appear below — enter a new value
            in each enabled field and save to resolve the conflict.
          </AlertDescription>
        </Alert>
      )}

      {schemaDeleted && (
        <Alert>
          <AlertTitle>This schema was deleted</AlertTitle>
          <AlertDescription>
            {schemaName} was deleted by another editor. This entry can no longer be edited.
          </AlertDescription>
        </Alert>
      )}

      <DynamicEntryForm
        schema={schema}
        initialValues={initialValues}
        storedValues={targetEntry.values}
        conflict={targetEntry.conflict}
        loadKey={loadKey}
        submitLabel={entry.conflict ? "Resolve & save" : "Save changes"}
        pending={update.isPending}
        submitError={update.isError ? errorMessage(update.error) : null}
        disabled={schemaDeleted}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
