import { useState } from "react";
import { useNavigate } from "react-router";
import { PencilSimple, Plus, Trash, WarningCircle } from "@phosphor-icons/react";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { Skeleton } from "@/components/Skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { useEntries } from "@/hooks/useEntries";
import { useRealtime } from "@/hooks/useRealtime";
import { useSchemas } from "@/hooks/useSchemas";
import type { ContentListEntry } from "@/lib/api";
import { entryLabel, schemaLabelField } from "@/lib/entries";
import { cn } from "@/lib/utils";

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export default function ContentPage() {
  const navigate = useNavigate();
  const { listQuery: schemasQuery } = useSchemas();
  const [schemaName, setSchemaName] = useState<string | null>(null);
  const [entryToDelete, setEntryToDelete] = useState<ContentListEntry | null>(null);

  const schemas = schemasQuery.data ?? [];
  const selected = schemaName ?? schemas[0]?.name ?? null;

  const { listQuery: entriesQuery, remove } = useEntries(selected ?? "");

  // Live stream for the selected schema: both schema and entry events affect it.
  const { deletedSchemas } = useRealtime({
    schemas: selected ? [selected] : [],
    enabled: selected != null,
  });

  const entries = entriesQuery.data ?? [];
  const labelFieldId = selected ? schemaLabelField(schemas.find((s) => s.name === selected)!) : null;
  const selectedDeleted = selected != null && deletedSchemas.has(selected);

  function handleDeleteConfirm() {
    if (!entryToDelete) return;
    remove.mutate(entryToDelete.id, {
      onSuccess: () => {
        setEntryToDelete(null);
        toast.add({ type: "success", title: "Entry deleted" });
      },
      onError: () => {
        // The dialog stays open and surfaces the server's message.
      },
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold">Content</h1>
          <p className="text-sm text-muted-foreground">Entries stored against your schemas.</p>
        </div>
        <Button type="button" onClick={() => navigate("/content/new")} disabled={schemas.length === 0 || selectedDeleted}>
          <Plus className="size-4" aria-hidden="true" />
          New entry
        </Button>
      </div>

      {selectedDeleted && (
        <Alert>
          <AlertTitle>This schema was deleted</AlertTitle>
          <AlertDescription>
            {selected} was deleted by another editor. Its content can no longer be changed.
          </AlertDescription>
        </Alert>
      )}

      {schemasQuery.isPending && <Skeleton className="h-8 w-64" />}

      {schemasQuery.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load schemas</AlertTitle>
          <AlertDescription>{errorMessage(schemasQuery.error) ?? "Unknown error"}</AlertDescription>
        </Alert>
      )}

      {schemasQuery.isSuccess && schemas.length === 0 && (
        <Alert>
          <AlertTitle>No schemas yet</AlertTitle>
          <AlertDescription>Create a schema before adding content.</AlertDescription>
        </Alert>
      )}

      {schemas.length > 0 && selected != null && (
        <div className="grid max-w-xs gap-1.5">
          <Label htmlFor="content-schema">Schema</Label>
          <Select value={selected} onValueChange={(value) => setSchemaName(typeof value === "string" ? value : null)}>
            <SelectTrigger id="content-schema">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {schemas.map((schema) => (
                <SelectItem key={schema.name} value={schema.name}>
                  {schema.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {entriesQuery.isPending && (
        <ul className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index}>
              <Skeleton className="h-12 w-full" />
            </li>
          ))}
        </ul>
      )}

      {entriesQuery.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load entries</AlertTitle>
          <AlertDescription>{errorMessage(entriesQuery.error) ?? "Unknown error"}</AlertDescription>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => entriesQuery.refetch()}>
            Retry
          </Button>
        </Alert>
      )}

      {entriesQuery.isSuccess && entries.length === 0 && (
        <Alert>
          <AlertTitle>No entries yet</AlertTitle>
          <AlertDescription>Add the first entry to this schema.</AlertDescription>
        </Alert>
      )}

      {entriesQuery.isSuccess && entries.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className={cn(
                "flex items-center justify-between gap-3 p-3",
                entry.conflict && "bg-destructive/5",
                selectedDeleted && "pointer-events-none opacity-50",
              )}
            >
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate text-sm font-medium">{entryLabel(entry, labelFieldId)}</p>
                <p className="text-xs text-muted-foreground">
                  v{entry.schema_version} · updated {entry.last_modified_by}
                </p>
              </div>
              {entry.conflict && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600">
                  <WarningCircle className="size-3.5" aria-hidden="true" />
                  Conflicted
                </span>
              )}
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${entryLabel(entry, labelFieldId)}`}
                  disabled={selectedDeleted}
                  onClick={() => navigate(`/content/${encodeURIComponent(selected!)}/${entry.id}`)}
                >
                  <PencilSimple className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${entryLabel(entry, labelFieldId)}`}
                  disabled={selectedDeleted}
                  onClick={() => setEntryToDelete(entry)}
                >
                  <Trash className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <DeleteConfirmDialog
        open={entryToDelete != null}
        onOpenChange={(open) => {
          if (!open) {
            setEntryToDelete(null);
            remove.reset();
          }
        }}
        title="Delete entry?"
        description={
          entryToDelete && (
            <>
              Delete {entryToDelete.conflict ? "this conflicted" : "this"} entry from{" "}
              <span className="font-medium text-foreground">{selected}</span>? This cannot be undone.
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
