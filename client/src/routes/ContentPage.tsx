import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowDown, ArrowUp, ArrowLeft, PencilSimple, Plus, Trash, WarningCircle } from "@phosphor-icons/react";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { Skeleton } from "@/components/shared/Skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
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
import type { PaginationParams, SortParams } from "@/hooks/useEntries";
import { useRealtime } from "@/hooks/useRealtime";
import { useSchemas } from "@/hooks/useSchemas";
import type { ContentListEntry, PaginationResponse } from "@/lib/api";
import { entryLabel, schemaLabelField } from "@/lib/entries";
import { schemaColor } from "@/lib/schemaColors";
import { cn } from "@/lib/utils";
import { SchemaBadge } from "@/components/shared/SchemaBadge";
import { Switch } from "@/components/ui/switch";

const ALL_SCHEMAS_VALUE = "__all__";
const PAGE_LIMIT = 50;

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/** Derive a stable list URL for editor return flows. */
function buildListUrl(opts: { allView: boolean; selected: string | null; conflictedOnly: boolean; sortField?: string | null; sortOrder?: string | null }): string {
  const base = opts.allView ? "/content" : `/content/${encodeURIComponent(opts.selected ?? "")}`;
  const params = new URLSearchParams();
  if (opts.conflictedOnly) params.set("conflicted", "1");
  if (opts.sortField) params.set("sort_field", opts.sortField);
  if (opts.sortOrder) params.set("sort_order", opts.sortOrder);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Build a URL for a specific page, preserving conflicted filter and sort. */
function buildPageUrl(opts: {
  allView: boolean;
  selected: string | null;
  conflictedOnly: boolean;
  targetPage: number;
  pagination?: PaginationParams;
  sortField?: string | null;
  sortOrder?: string | null;
}): string {
  const base = opts.allView ? "/content" : `/content/${encodeURIComponent(opts.selected ?? "")}`;
  const params = new URLSearchParams();
  if (opts.conflictedOnly) params.set("conflicted", "1");
  if (opts.targetPage > 1) params.set("page", String(opts.targetPage));
  if (opts.pagination) {
    if (opts.pagination.direction === "forward" && opts.pagination.cursor != null) {
      params.set("cursor_next", String(opts.pagination.cursor));
    } else if (opts.pagination.direction === "backward" && opts.pagination.cursor != null) {
      params.set("cursor_prev", String(opts.pagination.cursor));
    }
  }
  if (opts.sortField) params.set("sort_field", opts.sortField);
  if (opts.sortOrder) params.set("sort_order", opts.sortOrder);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export default function ContentPage() {
  const navigate = useNavigate();
  const { schema: schemaParam } = useParams();
  const [searchParams] = useSearchParams();
  const { listQuery: schemasQuery } = useSchemas();
  const [entryToDelete, setEntryToDelete] = useState<ContentListEntry | null>(null);

  const schemas = schemasQuery.data ?? [];
  const selected = schemaParam ?? null;
  const allView = selected == null;
  const conflictedOnly = searchParams.get("conflicted") === "1";

  // Sort state from URL
  const sortFieldRaw = searchParams.get("sort_field");
  const sortOrderRaw = searchParams.get("sort_order");
  const sortField = sortFieldRaw ?? "id";
  const sortOrder: "asc" | "desc" = sortOrderRaw === "asc" ? "asc" : "desc";
  const sort: SortParams = { sortField, sortOrder };

  // Pagination state from URL
  const page = Number(searchParams.get("page")) || 1;
  const cursorNext = searchParams.get("cursor_next");
  const cursorPrev = searchParams.get("cursor_prev");

  const hasCursorState = cursorNext != null || cursorPrev != null;
  // Cursors are opaque strings: carried from the URL to the query and back,
  // unchanged.
  const paginationParams: PaginationParams | undefined = hasCursorState
    ? {
        limit: PAGE_LIMIT,
        ...(cursorNext != null ? { cursor: cursorNext, direction: "forward" as const } : {}),
        ...(cursorPrev != null ? { cursor: cursorPrev, direction: "backward" as const } : {}),
      }
    : undefined;

  const listUrl = buildListUrl({ allView, selected, conflictedOnly, sortField: sortFieldRaw, sortOrder: sortOrderRaw });

  // The delete mutation is always keyed to the deleted entry's own schema
  const deleteSource = useEntries(entryToDelete?.schema ?? "");
  const remove = deleteSource.remove;

  // Filtered view: always pass pagination params (undefined on first page = non-paginated)
  const filtered = useEntries(selected ?? "", true, paginationParams, allView ? undefined : sort);

  const allEntriesQuery = useAllEntries(allView ? schemas.map((schema) => schema.name) : [], paginationParams);

  // Determine entries and pagination based on view type
  let entries: ContentListEntry[];
  let pagination: PaginationResponse;
  let entriesIsPending: boolean;
  let entriesIsError: boolean;
  let entriesError: unknown;
  let entriesRefetch: () => Promise<void>;

  if (allView) {
    entries = allEntriesQuery.data;
    pagination = allEntriesQuery.pagination;
    entriesIsPending = allEntriesQuery.isPending;
    entriesIsError = allEntriesQuery.isError;
    entriesError = allEntriesQuery.error;
    entriesRefetch = allEntriesQuery.refetch;
  } else {
    entries = filtered.entries;
    pagination = filtered.pagination;
    entriesIsPending = filtered.isPending;
    entriesIsError = filtered.isError;
    entriesError = filtered.error;
    entriesRefetch = filtered.refetch;
  }

  const visibleEntries = conflictedOnly ? entries.filter((entry) => entry.conflict) : entries;
  const hasNextPage = pagination.nextCursor != null;
  const hasPrevPage = hasCursorState && pagination.prevCursor != null;

  const labelFieldIds = new Map(schemas.map((schema) => [schema.name, schemaLabelField(schema)]));
  const schemaNotFound =
    selected != null && schemasQuery.isSuccess && !schemas.some((schema) => schema.name === selected);

  // Live stream
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

  function goToNextPage() {
    if (!hasNextPage || pagination.nextCursor == null) return;
    navigate(
      buildPageUrl({
        allView,
        selected,
        conflictedOnly,
        targetPage: page + 1,
        pagination: { limit: PAGE_LIMIT, cursor: pagination.nextCursor, direction: "forward" },
        sortField: sortFieldRaw,
        sortOrder: sortOrderRaw,
      }),
    );
  }

  function goToPrevPage() {
    if (!hasPrevPage || pagination.prevCursor == null) return;
    navigate(
      buildPageUrl({
        allView,
        selected,
        conflictedOnly,
        targetPage: page - 1,
        pagination: { limit: PAGE_LIMIT, cursor: pagination.prevCursor, direction: "backward" },
        sortField: sortFieldRaw,
        sortOrder: sortOrderRaw,
      }),
    );
  }

  if (schemaNotFound) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="icon" aria-label="Back to content" onClick={() => navigate(buildListUrl({ allView: true, selected: null, conflictedOnly }))}>
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
        <div className="flex flex-row justify-between items-end">
          <div className="flex flex-row gap-3 items-end">
            <div className="grid max-w-xs gap-1.5">
              <Label htmlFor="content-schema">Schema</Label>
              <Select
                value={selected ?? ALL_SCHEMAS_VALUE}
                onValueChange={(value) => {
                  if (value == null) return;
                  // Reset pagination and sort on schema change
                  const base = value === ALL_SCHEMAS_VALUE ? "/content" : `/content/${encodeURIComponent(value)}`;
                  const params = new URLSearchParams();
                  if (conflictedOnly) params.set("conflicted", "1");
                  const qs = params.toString();
                  navigate(qs ? `${base}?${qs}` : base);
                }}
              >
                <SelectTrigger id="content-schema">
                  <SelectValue>
                    {(value) => {
                      if (!value || value === ALL_SCHEMAS_VALUE) {
                        return (
                          <>
                            <span className="h-1 w-4 self-center border-dotted border-t-2 border-t-gray-600" />
                            All schemas
                          </>
                        )
                      }

                      return (
                        <>
                          <SchemaBadge bgcolor={schemaColor(value).background} />
                          {value}
                        </>
                      )
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SCHEMAS_VALUE}>
                    <span className="h-1 w-4 self-center border-dotted border-t-2 border-t-gray-600" />
                    All schemas
                  </SelectItem>
                  {schemas.map((schema) => (
                    <SelectItem key={schema.name} value={schema.name}>
                      <SchemaBadge bgcolor={schemaColor(schema.name).background} className="self-center" />
                      {schema.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Sort selector — only when a schema is selected */}
            {selected != null && (() => {
              const selectedSchema = schemas.find((s) => s.name === selected);
              const sortableFields = selectedSchema?.fields.filter((f) =>
                f.type === "text" || f.type === "number" || f.type === "date"
              ) ?? [];
              const selectedSchemaName = selected;

              function handleSortChange(newValue: string | null) {
                if (newValue == null) return;
                const params = new URLSearchParams();
                if (conflictedOnly) params.set("conflicted", "1");
                // Preset options encode both field and order
                if (newValue === "newest") {
                  params.set("sort_field", "id");
                  params.set("sort_order", "desc");
                } else if (newValue === "oldest") {
                  params.set("sort_field", "id");
                  params.set("sort_order", "asc");
                } else if (newValue === "date") {
                  params.set("sort_field", "date");
                  params.set("sort_order", "asc");
                } else {
                  // Custom field: use field id, default asc
                  params.set("sort_field", newValue);
                  params.set("sort_order", "asc");
                }
                const qs = params.toString();
                navigate(`/content/${encodeURIComponent(selectedSchemaName)}?${qs}`);
              }

              function handleSortOrderToggle() {
                const newOrder = sortOrder === "asc" ? "desc" : "asc";
                const params = new URLSearchParams();
                if (conflictedOnly) params.set("conflicted", "1");
                params.set("sort_field", sortField);
                params.set("sort_order", newOrder);
                const qs = params.toString();
                navigate(`/content/${encodeURIComponent(selectedSchemaName)}?${qs}`);
              }

              // Derive select value from current URL sort state
              const selectValue = sortField === "id" && sortOrder === "desc"
                ? "newest"
                : sortField === "id" && sortOrder === "asc"
                  ? "oldest"
                  : sortField === "date"
                    ? "date"
                    : sortField;

              const sortLabel =
                selectValue === "newest" ? "Newest first"
                : selectValue === "oldest" ? "Oldest first"
                : selectValue === "date" ? "Creation date"
                : sortableFields.find((f) => String(f.id) === selectValue)
                  ? `${sortableFields.find((f) => String(f.id) === selectValue)!.label} (${sortableFields.find((f) => String(f.id) === selectValue)!.type})`
                : sortField;

              return (
                <div className="grid gap-1.5">
                  <Label htmlFor="content-sort">Sort by</Label>
                  <div className="flex items-center gap-1">
                    <Select value={selectValue} onValueChange={handleSortChange}>
                      <SelectTrigger id="content-sort" className="w-[180px]">
                        <SelectValue>{sortLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="newest">Newest first</SelectItem>
                        <SelectItem value="oldest">Oldest first</SelectItem>
                        <SelectItem value="date">Creation date</SelectItem>
                        {sortableFields.map((field) => (
                          <SelectItem key={field.id} value={String(field.id)}>
                            {field.label} ({field.type})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={`Sort ${sortOrder === "asc" ? "descending" : "ascending"}`}
                      onClick={handleSortOrderToggle}
                    >
                      {sortOrder === "asc" ? (
                        <ArrowUp className="size-4" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="size-4" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                </div>
              );
            })()}
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="conflicted-only"
              checked={conflictedOnly}
              onCheckedChange={(checked) => {
                // Reset pagination when toggling conflicted filter
                const base = allView ? "/content" : `/content/${encodeURIComponent(selected ?? "")}`;
                const params = new URLSearchParams();
                if (checked) params.set("conflicted", "1");
                const qs = params.toString();
                navigate(qs ? `${base}?${qs}` : base);
              }}
            />
            <Label htmlFor="conflicted-only" className="cursor-pointer font-normal">
              Conflicted content only
            </Label>
          </div>
        </div>
      )}

      {schemas.length > 0 && entriesIsPending && (
        <ul className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index}>
              <Skeleton className="h-12 w-full" />
            </li>
          ))}
        </ul>
      )}

      {schemas.length > 0 && entriesIsError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load entries</AlertTitle>
          <AlertDescription>{errorMessage(entriesError) ?? "Unknown error"}</AlertDescription>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => entriesRefetch()}>
            Retry
          </Button>
        </Alert>
      )}

      {schemas.length > 0 && !entriesIsPending && !entriesIsError && entries.length === 0 && (
        <Alert>
          <AlertTitle>No entries yet</AlertTitle>
          <AlertDescription>{allView ? "Add the first entry to a schema." : "Add the first entry to this schema."}</AlertDescription>
        </Alert>
      )}

      {schemas.length > 0 && !entriesIsPending && !entriesIsError && entries.length > 0 && conflictedOnly && visibleEntries.length === 0 && (
        <Alert>
          <AlertTitle>No conflicted entries</AlertTitle>
          <AlertDescription>
            {allView ? "No entries are conflicted across all schemas." : "No entries are conflicted in this schema."}
          </AlertDescription>
        </Alert>
      )}

      {schemas.length > 0 && !entriesIsPending && !entriesIsError && visibleEntries.length > 0 && (
        <>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {visibleEntries.map((entry) => {
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
                    <SchemaBadge
                      bgcolor={schemaColor(entry.schema).background}
                      textcolor={schemaColor(entry.schema).foreground}
                    >
                      {entry.schema}
                    </SchemaBadge>
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

          {(hasNextPage || hasPrevPage) && (
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    text="Previous"
                    onClick={(e) => {
                      e.preventDefault();
                      goToPrevPage();
                    }}
                    aria-disabled={!hasPrevPage}
                    className={cn(!hasPrevPage && "pointer-events-none opacity-50")}
                  />
                </PaginationItem>
                <PaginationItem>
                  <span className="px-3 text-sm text-muted-foreground">Page {page}</span>
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    text="Next"
                    onClick={(e) => {
                      e.preventDefault();
                      goToNextPage();
                    }}
                    aria-disabled={!hasNextPage}
                    className={cn(!hasNextPage && "pointer-events-none opacity-50")}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </>
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
              {entryToDelete.referencer_count > 0 && (
                <span className="mt-2 block text-sm text-amber-700 dark:text-amber-400">
                  This entry is referenced by {entryToDelete.referencer_count}{" "}
                  {entryToDelete.referencer_count === 1 ? "other entry" : "other entries"}. Deleting will clear those references.
                </span>
              )}
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
