import { useState } from "react";
import { useNavigate } from "react-router";
import { Plus, Trash } from "@phosphor-icons/react";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { Skeleton } from "@/components/Skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useRealtime } from "@/hooks/useRealtime";
import { useSchemaEntryCount, useSchemas } from "@/hooks/useSchemas";
import { type SchemaEntry } from "@/lib/api";
import { cn } from "@/lib/utils";

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export default function SchemasPage() {
  const navigate = useNavigate();
  const { listQuery, remove } = useSchemas();
  const [schemaToDelete, setSchemaToDelete] = useState<SchemaEntry | null>(null);

  // Live stream: entry events don't affect this view; schema events do.
  const { deletedSchemas } = useRealtime({ schemas: [], includeEntries: false });

  const affectedCount = useSchemaEntryCount(schemaToDelete?.name ?? "", schemaToDelete != null);
  const schemas = listQuery.data ?? [];

  function handleDeleteConfirm() {
    if (!schemaToDelete) return;
    remove.mutate(schemaToDelete.name, {
      onSuccess: () => {
        setSchemaToDelete(null);
        toast.add({ type: "success", title: "Schema deleted" });
      },
      onError: () => {
        // The dialog stays open and surfaces the server's message (e.g. 409 when referenced).
      },
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold">Schemas</h1>
          <p className="text-sm text-muted-foreground">Build the shapes that content entries follow.</p>
        </div>
        <Button type="button" onClick={() => navigate("/schemas/new")}>
          <Plus className="size-4" aria-hidden="true" />
          New schema
        </Button>
      </div>

      {listQuery.isPending && (
        <ul className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index}>
              <Skeleton className="h-12 w-full" />
            </li>
          ))}
        </ul>
      )}

      {listQuery.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load schemas</AlertTitle>
          <AlertDescription>{errorMessage(listQuery.error) ?? "Unknown error"}</AlertDescription>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => listQuery.refetch()}>
            Retry
          </Button>
        </Alert>
      )}

      {listQuery.isSuccess && schemas.length === 0 && (
        <Alert>
          <AlertTitle>No schemas yet</AlertTitle>
          <AlertDescription>Create the first schema to start adding content.</AlertDescription>
        </Alert>
      )}

      {listQuery.isSuccess && schemas.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {schemas.map((schema) => {
            const deleted = deletedSchemas.has(schema.name);
            return (
              <li
                key={schema.name}
                className={cn(
                  "flex items-center justify-between gap-3 p-3",
                  deleted && "pointer-events-none opacity-50",
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  disabled={deleted}
                  onClick={() => navigate(`/schemas/${encodeURIComponent(schema.name)}`)}
                >
                  <p className="truncate text-sm font-medium">{schema.name}</p>
                  <p className="text-xs text-muted-foreground">
                    v{schema.version} · {schema.fields.length} {schema.fields.length === 1 ? "field" : "fields"}
                  </p>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${schema.name}`}
                  disabled={deleted}
                  onClick={() => setSchemaToDelete(schema)}
                >
                  <Trash className="size-4" aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <DeleteConfirmDialog
        open={schemaToDelete != null}
        onOpenChange={(open) => {
          if (!open) {
            setSchemaToDelete(null);
            remove.reset();
          }
        }}
        title="Delete schema?"
        description={
          schemaToDelete && (
            <>
              Delete <span className="font-medium text-foreground">{schemaToDelete.name}</span> and all of its content?
              <span className="mt-1 block">
                {affectedCount.data == null
                  ? "Counting affected entries…"
                  : `This will delete ${affectedCount.data} ${affectedCount.data === 1 ? "entry" : "entries"}.`}
              </span>
            </>
          )
        }
        error={remove.isError ? errorMessage(remove.error) : null}
        pending={remove.isPending}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}
