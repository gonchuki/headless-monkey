import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ArrowLeft, PencilSimple, Plus, Trash, WarningCircle } from "@phosphor-icons/react";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { Skeleton } from "@/components/shared/Skeleton";
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
import { useAllEntries } from "@/hooks/useAllEntries";
import { useEntries } from "@/hooks/useEntries";
import { useRealtime } from "@/hooks/useRealtime";
import { useSchemas } from "@/hooks/useSchemas";
import type { ContentListEntry } from "@/lib/api";
import { entryLabel, schemaLabelField } from "@/lib/entries";
import { schemaColor } from "@/lib/schemaColors";
import { cn } from "@/lib/utils";

const ALL_SCHEMAS_VALUE = "all";

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export default function ContentPage() {
  const navigate = useNavigate();
  const { schema: schemaParam } = useParams();
  const { listQuery: schemasQuery } = useSchemas();
  const [entryToDelete, setEntryToDelete] = useState<ContentListEntry | null>(null);

  const schemas = schemasQuery.data ?? [];
  const selected = schemaParam ?? null;
  const allView = selected == null;
  const listUrl = allView ? "/content" : `/content/${encodeURIComponent(selected)}`;

  // The delete mutation is always keyed to the deleted entry's own schema so
  // the All view's merged list (per-schema queries) observes its optimistic
  // removal; in the filtered view that equals the selected schema.
  const deleteSource = useEntries(entryToDelete?.schema ?? "");
  const remove = deleteSource.remove;

  // Filtered view reads the selected schema's entries directly; the All view
  // merges one query per schema.
  const filtered = useEntries(selected ?? "");
  const allEntriesQuery = useAllEntries(allView ? schemas.map((schema) => schema.name) : []);
  const entriesQuery = allView ? allEntriesQuery : filtered.listQuery;
  const entries = entriesQuery.data ?? [];

  const labelFieldIds = new Map(schemas.map((schema) => [schema.name, schemaLabelField(schema)]));
  const schemaNotFound =
    selected != null && schemasQuery.isSuccess && !schemas.some((schema) => schema.name === selected);

  // Live stream: the All view passes every schema so reconnect re-syncs each
  // schema's entry query; the filtered view watches only its schema.
  const { deletedSchemas } = useRealtime({
    schemas: allView ? schemas.map((schema) => schema.name) : selected != null ? [selected] : [],
    enabled: schemas.length > 0,
  });

  const selectedDeleted = selected != null && deletedSchemas.has(selected);
  const hasLiveSchema = allView
    ? schemas.some((schema) => !deletedSchemas.has(schema.name))
    : selected != null && !deletedSchemas.has(selected);

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

  if (schemaNotFound) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="icon" aria-label="Back to content" onClick={() => navigate("/content")}>
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
          <h1 className="font-heading text-xl font-semibold">Schema not found</h1>
        </div>
        <Alert variant="destructive">
          <AlertTitle>Could not load this schema</AlertTitle>
          <AlertDescription>Schema {selected} does not exist.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold">Content</h1>
          <p className="text-sm text-muted-foreground">Entries stored against your schemas.</p>
        </div>
        <Button
          type="button"
          onClick={() => navigate("/content/new", { state: { list: listUrl, schema: selected } })}
          disabled={!hasLiveSchema}
        >
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

      {schemas.length > 0 && (
        <div className="grid max-w-xs gap-1.5">
          <Label htmlFor="content-schema">Schema</Label>
          <Select
            value={selected ?? ALL_SCHEMAS_VALUE}
            onValueChange={(value) => {
              if (value == null) return;
              if (value === ALL_SCHEMAS_VALUE) {
                navigate("/content");
              } else {
                navigate(`/content/${encodeURIComponent(value)}`);
              }
            }}
          >
            <SelectTrigger id="content-schema">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SCHEMAS_VALUE}>All schemas</SelectItem>
              {schemas.map((schema) => (
                <SelectItem key={schema.name} value={schema.name}>
                  <span
                    className="inline-block size-4 shrink-0 rounded-full"
                    style={{ backgroundColor: schemaColor(schema.name).background }}
                    aria-hidden="true"
                  />
                  {schema.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {schemas.length > 0 && entriesQuery.isPending && (
        <ul className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index}>
              <Skeleton className="h-12 w-full" />
            </li>
          ))}
        </ul>
      )}

      {schemas.length > 0 && entriesQuery.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load entries</AlertTitle>
          <AlertDescription>{errorMessage(entriesQuery.error) ?? "Unknown error"}</AlertDescription>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => entriesQuery.refetch()}>
            Retry
          </Button>
        </Alert>
      )}

      {schemas.length > 0 && entriesQuery.isSuccess && entries.length === 0 && (
        <Alert>
          <AlertTitle>No entries yet</AlertTitle>
          <AlertDescription>{allView ? "Add the first entry to a schema." : "Add the first entry to this schema."}</AlertDescription>
        </Alert>
      )}

      {schemas.length > 0 && entriesQuery.isSuccess && entries.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {entries.map((entry) => {
            const entryDeleted = deletedSchemas.has(entry.schema);
            const labelFieldId = labelFieldIds.get(entry.schema) ?? null;
            return (
              <li
                key={entry.id}
                className={cn(
                  "flex items-center justify-between gap-3 p-3",
                  entry.conflict && "bg-destructive/5",
                  entryDeleted && "pointer-events-none opacity-50",
                )}
              >
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium">{entryLabel(entry, labelFieldId)}</p>
                  <p className="text-xs text-muted-foreground">
                    v{entry.schema_version} · updated {entry.last_modified_by}
                  </p>
                </div>
                {allView && (
                  <span
                    className="flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{
                      backgroundColor: schemaColor(entry.schema).background,
                      color: schemaColor(entry.schema).foreground,
                    }}
                  >
                    {entry.schema}
                  </span>
                )}
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
                    disabled={entryDeleted}
                    onClick={() =>
                      navigate(`/content/${encodeURIComponent(entry.schema)}/${entry.id}`, { state: { list: listUrl } })
                    }
                  >
                    <PencilSimple className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${entryLabel(entry, labelFieldId)}`}
                    disabled={entryDeleted}
                    onClick={() => setEntryToDelete(entry)}
                  >
                    <Trash className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            );
          })}
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
              <span className="font-medium text-foreground">{entryToDelete.schema}</span>? This cannot be undone.
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
