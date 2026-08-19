import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
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
import { useDeleteEntry } from "@/hooks/useEntryMutations";
import { useAllEntries } from "@/hooks/useAllEntries";
import { useEntries } from "@/hooks/useEntries";
import {
  buildAllEntriesRequest,
  buildEntriesRequest,
  type PaginationParams,
  type PaginatedEntries,
  type SortParams,
} from "@/hooks/useEntries";
import { useRealtime } from "@/hooks/useRealtime";
import { useSchemas } from "@/hooks/useSchemas";
import type { ContentListEntry, PaginationResponse } from "@/lib/api";
import { entryLabel, schemaLabelField } from "@/lib/entries";
import { schemaColor } from "@/lib/schemaColors";
import { cn } from "@/lib/utils";
import { dropSortParams, isStaleSortError } from "@/lib/sortRecovery";
import { SchemaBadge } from "@/components/shared/SchemaBadge";
import { Switch } from "@/components/ui/switch";

const ALL_SCHEMAS_VALUE = "__all__";
const PAGE_LIMIT = 50;

/**
 * Hard cap on reconstruction-walk steps. Exceeding it is the same early-stop
 * clamp as exhaustion: stop at the reached page and `replace`-rewrite the URL
 * to that page. Bounds pathological `?page=99999` URLs. (Start value; the
 * product owner may tune it.)
 */
const WALK_STEP_CAP = 20;

/**
 * Pagination anchor carried in `location.state.pagination`, for BOTH views
 * (single-schema and all-schemas): the exact fetch params (minus limit) that
 * produced the current page. Page 1 never has a cursor, so the key is omitted
 * entirely there.
 */
interface PageAnchor {
  cursor?: string;
  direction?: "forward" | "backward";
}

/**
 * Build a position-aware URL: base path + optional `conflicted`, `page`
 * (only when > 1), `sort_field`, `sort_order`. Cursors and all-view state
 * never appear in the URL — position rides on `location.state`.
 */
function buildPageUrl(opts: {
  allView: boolean;
  selected: string | null;
  targetPage: number;
  conflictedOnly: boolean;
  sortField?: string | null;
  sortOrder?: string | null;
}): string {
  const base = opts.allView ? "/content" : `/content/${encodeURIComponent(opts.selected ?? "")}`;
  const params = new URLSearchParams();
  if (opts.conflictedOnly) params.set("conflicted", "1");
  if (opts.targetPage > 1) params.set("page", String(opts.targetPage));
  if (opts.sortField) params.set("sort_field", opts.sortField);
  if (opts.sortOrder) params.set("sort_order", opts.sortOrder);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Plain page-1 list URL (no `page` param) for editor-return flows. */
function buildListUrl(opts: {
  allView: boolean;
  selected: string | null;
  conflictedOnly: boolean;
  sortField?: string | null;
  sortOrder?: string | null;
}): string {
  return buildPageUrl({ ...opts, targetPage: 1 });
}

/** Type guard for the pagination anchor in `location.state` (both views). */
function isPageAnchor(value: unknown): value is PageAnchor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if ("cursor" in v && typeof v.cursor !== "string") return false;
  if ("direction" in v && v.direction !== "forward" && v.direction !== "backward") return false;
  return true;
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export default function ContentPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { schema: schemaParam } = useParams();
  const [searchParams] = useSearchParams();
  const { listQuery: schemasQuery } = useSchemas();
  const [entryToDelete, setEntryToDelete] = useState<ContentListEntry | null>(null);
  const [walkPending, setWalkPending] = useState(false);

  const schemas = schemasQuery.data ?? [];
  const selected = schemaParam ?? null;
  const allView = selected == null;
  const conflictedOnly = searchParams.get("conflicted") === "1";

  // Sort state from URL
  const sortFieldRaw = searchParams.get("sort_field");
  const sortOrderRaw = searchParams.get("sort_order");
  const sortField = sortFieldRaw ?? "modified";
  const sortOrder: "asc" | "desc" = sortOrderRaw === "asc" ? "asc" : "desc";
  const sort: SortParams = { sortField, sortOrder };

  // ---- Page counter (URL): an integer >= 1. Absent -> page 1 (no rewrite).
  // Present but invalid -> page 1, and the param is rewritten away below.
  const pageRaw = searchParams.get("page");
  const pageRawNumber = pageRaw != null ? Number(pageRaw) : 1;
  const pageParamValid = pageRaw == null || (Number.isInteger(pageRawNumber) && pageRawNumber >= 1);
  const page = pageParamValid ? pageRawNumber : 1;

  // ---- Position (location.state.pagination) ----
  // Both views carry the same anchor shape. Missing or mismatched state is
  // never an error — the reconstruction walk handles it.
  const stateRecord =
    location.state != null && typeof location.state === "object" && !Array.isArray(location.state)
      ? (location.state as Record<string, unknown>)
      : null;
  const rawPagination = stateRecord?.pagination;

  const candidateAnchor = isPageAnchor(rawPagination) ? rawPagination : null;
  // An anchor must actually carry a cursor (page 1 is implicitly anchored).
  const anchor: PageAnchor | null =
    candidateAnchor != null && candidateAnchor.cursor != null ? candidateAnchor : null;
  const stateMatchesPage = page === 1 || anchor != null;

  // Fetch params, built once for both views. Always include `limit` —
  // including on the first page — so the server returns a bounded page with
  // cursors. Page > 1 adds the location-state anchor (the only remaining
  // cursor source); while a walk is pending there is no anchor, so page-1
  // params are requested — the very key the walk's first step uses, so both
  // coalesce into one fetch.
  const paginationParams: PaginationParams = { limit: PAGE_LIMIT };
  if (page > 1 && anchor != null) {
    paginationParams.cursor = anchor.cursor;
    if (anchor.direction != null) paginationParams.direction = anchor.direction;
  }

  // Walk trigger: page > 1 with no position state for this page.
  const walkNeeded = page > 1 && !stateMatchesPage;

  const listUrl = buildListUrl({ allView, selected, conflictedOnly, sortField: sortFieldRaw, sortOrder: sortOrderRaw });

  // The delete mutation is always keyed to the deleted entry's own schema
  const remove = useDeleteEntry();

  const filtered = useEntries(
    allView ? "" : (selected ?? ""),
    !allView,
    paginationParams,
    allView ? undefined : sort,
    conflictedOnly,
  );

  // All-view entries: one global request, identical to the reconstruction
  // walk's, so walked pages are cache-warm for the interactive navigation.
  // Gated on the all-view and on loaded schemas so a fresh install shows
  // "No schemas yet" rather than a stuck pending skeleton.
  const allEntriesQuery = useAllEntries(
    PAGE_LIMIT,
    conflictedOnly,
    anchor ?? undefined,
    allView && schemas.length > 0,
  );

  let entries: ContentListEntry[];
  let pagination: PaginationResponse;
  let entriesIsPending: boolean;
  let entriesIsError: boolean;
  let entriesError: unknown;
  let entriesRefetch: () => Promise<void>;

  if (allView) {
    entries = allEntriesQuery.entries;
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

  // --------------------------------------------------------------------
  // Reconstruction walk.
  //
  // Missing position state (shared link in a fresh tab, address-bar entry,
  // restored tabs, evicted sessions) is the *common* path, not an error:
  // walk forward from page 1 under the URL's current sort/filter and land
  // on the requested page — or clamp to the reached page when the data is
  // exhausted or the step cap is hit. Requests go through the same helpers
  // and cache keys as the listing hooks, so walked pages render from cache.
  // --------------------------------------------------------------------
  useEffect(() => {
    if (!walkNeeded) return;
    // The single-schema walk waits for the schema list (the not-found check
    // renders first); the all-view walk does not — the server lists
    // everything.
    if (!allView && (schemasQuery.isPending || schemasQuery.data == null)) return;

    const urlOpts = {
      allView,
      selected,
      conflictedOnly,
      sortField: sortFieldRaw,
      sortOrder: sortOrderRaw,
    };
    const base = allView ? "/content" : `/content/${encodeURIComponent(selected ?? "")}`;

    let disposed = false;
    setWalkPending(true);

    /**
     * Land the walk result: replace the current entry at the reached page
     * and stamp `location.state.pagination` (or drop the key on page/depth 1)
     * so a refresh resumes without re-walking. Stamps and clamps always share
     * one navigation so the state and URL page agree.
     */
    const finish = (reachedPage: number, stateValue: unknown) => {
      if (disposed) return;
      const currentState = { ...(stateRecord ?? {}) };
      if (stateValue == null) {
        delete currentState.pagination;
      } else {
        currentState.pagination = stateValue;
      }
      const state = Object.keys(currentState).length > 0 ? currentState : null;
      navigate(buildPageUrl({ ...urlOpts, targetPage: reachedPage }), { replace: true, state });
      setWalkPending(false);
    };

    /** Abort with a clean rewrite — never a fatal listing error. */
    const fail = (error: unknown) => {
      if (disposed) return;
      if (isStaleSortError(error)) {
        // Same rewrite the stale-sort recovery performs: drop sort (which also
        // drops page), keep conflicted, replace.
        const cleaned = dropSortParams(searchParams);
        if (cleaned != null) {
          const qs = cleaned.toString();
          navigate(qs ? `${base}?${qs}` : base, { replace: true });
          setWalkPending(false);
          return;
        }
      }
      // Unknown failure (or nothing to drop): restart at page 1 under the
      // current criteria.
      navigate(buildPageUrl({ ...urlOpts, targetPage: 1 }), { replace: true });
      setWalkPending(false);
    };

    // ---- unified forward walk: fetch pages 1..target ----
    // Parameterized only by which request builder feeds it (all-view:
    // `buildAllEntriesRequest`, no sort; single-schema: `buildEntriesRequest`
    // with `sort`). The walk's fetches use the SAME builders — and therefore
    // the SAME query keys — as the interactive hooks, so walked pages are
    // cache-warm on render.
    async function walk() {
      for (let step = 1, cursor: string | undefined = undefined, pageAnchor: PageAnchor = {}; step <= Math.min(page, WALK_STEP_CAP); step++) {
        const pagination: PaginationParams = { limit: PAGE_LIMIT };
        if (cursor != null) {
          pagination.cursor = cursor;
          pagination.direction = "forward";
        }
        const config = allView
          ? buildAllEntriesRequest({
              limit: pagination.limit,
              cursor: pagination.cursor,
              direction: pagination.direction,
              conflicted: conflictedOnly,
            })
          : buildEntriesRequest({ schema: selected!, conflicted: conflictedOnly, sort, pagination });
        const data = (await queryClient.fetchQuery({ queryKey: config.queryKey, queryFn: config.queryFn })) as PaginatedEntries;
        if (disposed) return;
        pageAnchor = cursor != null ? { cursor, direction: "forward" } : {};
        cursor = data.pagination.nextCursor ?? undefined;
        const reached = step;
        if (cursor == null) {
          finish(reached, reached === 1 ? null : pageAnchor); // exhausted — reached is the last real page
          return;
        }
        if (step === page || step === WALK_STEP_CAP) {
          finish(reached, pageAnchor); // target reached or cap hit
          return;
        }
      }
    }

    (async () => {
      try {
        await walk();
      } catch (error) {
        fail(error);
      }
    })();

    return () => {
      // Generation guard: any navigation/filter change disposes the in-flight
      // run before its result can be applied.
      disposed = true;
      setWalkPending(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkNeeded, schemasQuery.data, allView, selected, page, sortFieldRaw, sortOrderRaw, conflictedOnly]);

  // --------------------------------------------------------------------
  // Invalid `page` param -> rewrite it away (treat as page 1). Only fires on
  // present-but-invalid values; an absent page is page 1 with no rewrite.
  // Defined before stale-sort recovery so that on a simultaneous stale-sort
  // 422 the sort rewrite (which also drops page) stays the final URL.
  // --------------------------------------------------------------------
  useEffect(() => {
    if (pageRaw == null || pageParamValid) return;
    const cleaned = new URLSearchParams(searchParams);
    cleaned.delete("page");
    const qs = cleaned.toString();
    const base = allView ? "/content" : `/content/${encodeURIComponent(selected ?? "")}`;
    navigate(qs ? `${base}?${qs}` : base, { replace: true });
  }, [pageRaw, pageParamValid, searchParams, allView, selected, navigate]);

  // --------------------------------------------------------------------
  // Stale sort recovery (live listing path): a 422 stale-sort error rewrites
  // the URL to drop sort — and with it the page, any page derived under a
  // dead sort is meaningless (the walk path handles this failure itself).
  // --------------------------------------------------------------------
  useEffect(() => {
    if (walkPending) return;
    if (!entriesIsError) return;
    if (!isStaleSortError(entriesError)) return;

    const cleaned = dropSortParams(searchParams);
    if (cleaned == null) return; // no sort params to drop

    const qs = cleaned.toString();
    const base = allView ? "/content" : `/content/${encodeURIComponent(selected ?? "")}`;
    navigate(qs ? `${base}?${qs}` : base, { replace: true });
  }, [entriesIsError, entriesError, searchParams, allView, selected, navigate, walkPending]);

  // --------------------------------------------------------------------
  // Pagination availability — both views read the same single `pagination`
  // response (the server's cursors are authoritative for either).
  // --------------------------------------------------------------------
  const hasNextPage = pagination.nextCursor != null;
  const hasPrevPage = page > 1 && pagination.prevCursor != null;
  const displayPage = page;

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
    remove.mutate({ id: entryToDelete.id, schema: entryToDelete.schema }, {
      onSuccess: () => {
        setEntryToDelete(null);
        toast.add({ type: "success", title: "Entry deleted" });
      },
      onError: () => {
        // The dialog stays open and surfaces the server's message.
      },
    });
  }

  function viewOptsForUrl() {
    return {
      allView,
      selected,
      conflictedOnly,
      sortField: sortFieldRaw,
      sortOrder: sortOrderRaw,
    };
  }

  function navigateToPage(targetPage: number, paginationState: unknown) {
    const state = { ...(stateRecord ?? {}) };
    if (targetPage > 1) {
      state.pagination = paginationState;
    } else {
      // Page 1 / depth 1 never carries position state.
      delete state.pagination;
    }
    const nextState = Object.keys(state).length > 0 ? state : null;
    navigate(buildPageUrl({ ...viewOptsForUrl(), targetPage }), { state: nextState });
  }

  function goToNextPage() {
    if (!hasNextPage || pagination.nextCursor == null) return;
    navigateToPage(page + 1, { cursor: pagination.nextCursor, direction: "forward" });
  }

  function goToPrevPage() {
    if (!hasPrevPage || pagination.prevCursor == null) return;
    navigateToPage(
      page - 1,
      page - 1 === 1 ? undefined : { cursor: pagination.prevCursor, direction: "backward" },
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
                  const targetAll = value === ALL_SCHEMAS_VALUE;
                  navigate(
                    buildPageUrl({
                      allView: targetAll,
                      selected: targetAll ? null : value,
                      conflictedOnly,
                      targetPage: 1,
                    }),
                  );
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
                // Reset pagination on sort change: any anchor derived under the
                // previous sort is invalid, so pagination restarts at page 1.
                // Preset options encode both field and order.
                const order = newValue === "date" ? "asc" : newValue === "modified" ? sortOrder : "asc";
                navigate(
                  buildPageUrl({
                    allView: false,
                    selected: selectedSchemaName,
                    conflictedOnly,
                    targetPage: 1,
                    sortField: newValue,
                    sortOrder: order,
                  }),
                );
              }

              function handleSortOrderToggle() {
                // Reset pagination; normalize the legacy "id" token on rewrite.
                const newOrder = sortOrder === "asc" ? "desc" : "asc";
                navigate(
                  buildPageUrl({
                    allView: false,
                    selected: selectedSchemaName,
                    conflictedOnly,
                    targetPage: 1,
                    sortField: sortField === "id" ? "modified" : sortField,
                    sortOrder: newOrder,
                  }),
                );
              }

              // Derive select value from current URL sort state. Both the
              // "modified" token and the legacy "id" token map to the
              // "Modified date" option.
              const selectValue =
                sortField === "modified" || sortField === "id"
                  ? "modified"
                  : sortField === "date"
                    ? "date"
                    : sortField;

              const sortLabel =
                selectValue === "modified" ? "Modified date"
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
                        <SelectItem value="modified">Modified date</SelectItem>
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
                // Reset pagination (and sort) on conflicted-filter change
                navigate(buildPageUrl({ allView, selected, conflictedOnly: checked, targetPage: 1 }));
              }}
            />
            <Label htmlFor="conflicted-only" className="cursor-pointer font-normal">
              Conflicted content only
            </Label>
          </div>
        </div>
      )}

      {schemas.length > 0 && (entriesIsPending || walkPending) && (
        <ul className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index}>
              <Skeleton className="h-12 w-full" />
            </li>
          ))}
        </ul>
      )}

      {schemas.length > 0 && entriesIsError && !walkPending && (
        <Alert variant="destructive">
          <AlertTitle>Could not load entries</AlertTitle>
          <AlertDescription>{errorMessage(entriesError) ?? "Unknown error"}</AlertDescription>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => entriesRefetch()}>
            Retry
          </Button>
        </Alert>
      )}

      {schemas.length > 0 && !entriesIsPending && !entriesIsError && !walkPending && entries.length === 0 && (
        <Alert>
          <AlertTitle>{conflictedOnly ? "No conflicted entries" : "No entries yet"}</AlertTitle>
          <AlertDescription>
            {conflictedOnly
              ? allView ? "No entries are conflicted across all schemas." : "No entries are conflicted in this schema."
              : allView ? "Add the first entry to a schema." : "Add the first entry to this schema."}
          </AlertDescription>
        </Alert>
      )}

      {schemas.length > 0 && !entriesIsPending && !entriesIsError && !walkPending && entries.length > 0 && (
        <>
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
                  <span className="px-3 text-sm text-muted-foreground">Page {displayPage}</span>
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
