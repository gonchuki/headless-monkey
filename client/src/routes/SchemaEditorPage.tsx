import { useEffect, useLayoutEffect, useReducer, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "@phosphor-icons/react";
import { PageSkeleton } from "@/components/shared/PageSkeleton";
import { PendingDeletionBanner } from "@/components/PendingDeletionBanner";
import { SchemaFieldGrid } from "@/components/SchemaFieldGrid";
import { SchemaSaveConfirmDialog } from "@/components/SchemaSaveConfirmDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { useEntries } from "@/hooks/useEntries";
import { useRealtime } from "@/hooks/useRealtime";
import {
  useSchemaPatchPreview,
  useSchemas,
  type SchemaDraft,
} from "@/hooks/useSchemas";
import { apiFetch, type SchemaEntry, type SchemaFieldInput } from "@/lib/api";
import { schemaLabelField } from "@/lib/entries";
import { queryKeys } from "@/lib/query";

interface EditorState {
  name: string;
  version: number;
  compatVersion: number;
  fields: SchemaDraft[];
  loadedName: string | null;
  nextNewId: number;
}

type EditorAction =
  | { type: "RESET"; name: string }
  | { type: "LOAD"; name: string; version: number; compatVersion: number; fields: SchemaEntry["fields"] }
  | { type: "SET_NAME"; name: string }
  | { type: "UPDATE_FIELD"; index: number; patch: Partial<Omit<SchemaDraft, "id">> }
  | { type: "ADD_FIELD" }
  | { type: "REMOVE_FIELD"; index: number }
  | { type: "MARK_FIELD_DELETED"; index: number }
  | { type: "RESTORE_FIELD"; index: number }
  | { type: "MOVE_FIELD"; from: number; to: number };

const initialState: EditorState = {
  name: "",
  version: 0,
  compatVersion: 0,
  fields: [],
  loadedName: null,
  nextNewId: -1,
};

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "RESET":
      return { ...initialState, name: action.name };
    case "LOAD":
      return {
        name: action.name,
        version: action.version,
        compatVersion: action.compatVersion,
        fields: action.fields.map((field) => ({
          id: field.id,
          label: field.label,
          type: field.type,
          required: field.required,
          ...(field.type === "schema-ref" ? { ref_schema: field.ref_schema } : {}),
        })),
        loadedName: action.name,
        nextNewId: -1,
      };
    case "SET_NAME":
      return { ...state, name: action.name };
    case "UPDATE_FIELD": {
      const fields = state.fields.map((field, index) =>
        index === action.index ? { ...field, ...action.patch } : field,
      );
      return { ...state, fields };
    }
    case "ADD_FIELD":
      return {
        ...state,
        fields: [...state.fields, { id: state.nextNewId, label: "", type: "text", required: true }],
        nextNewId: state.nextNewId - 1,
      };
    case "REMOVE_FIELD":
      return { ...state, fields: state.fields.filter((_, index) => index !== action.index) };
    case "MARK_FIELD_DELETED":
      return {
        ...state,
        fields: state.fields.map((field, index) => (index === action.index ? { ...field, deleted: true } : field)),
      };
    case "RESTORE_FIELD":
      return {
        ...state,
        fields: state.fields.map((field, index) => (index === action.index ? { ...field, deleted: false } : field)),
      };
    case "MOVE_FIELD": {
      const fields = [...state.fields];
      const [moved] = fields.splice(action.from, 1);
      fields.splice(action.to, 0, moved);
      return { ...state, fields };
    }
    default:
      return state;
  }
}

function toPayload(fields: SchemaDraft[]): SchemaFieldInput[] {
  return fields
    .filter((field) => !field.deleted)
    .map((field) => {
      if (field.type === "schema-ref" && field.ref_schema != null) {
        return {
          label: field.label,
          type: "schema-ref" as const,
          required: field.required,
          ref_schema: field.ref_schema,
          ...(field.id != null && field.id > 0 ? { id: field.id } : {}),
        };
      }
      return {
        label: field.label,
        type: field.type as "text" | "number" | "boolean" | "date",
        required: field.required,
        ...(field.id != null && field.id > 0 ? { id: field.id } : {}),
      };
    });
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export default function SchemaEditorPage() {
  const { name = "" } = useParams();
  const navigate = useNavigate();
  const isCreateRoute = name === "new";

  const schemaQuery = useQuery({
    queryKey: queryKeys.schema(name),
    queryFn: () => apiFetch<SchemaEntry>(`/api/schemas/${encodeURIComponent(name)}`),
    enabled: !isCreateRoute,
  });

  const { listQuery, create, update } = useSchemas();
  const [state, dispatch] = useReducer(editorReducer, initialState);
  const [pendingSave, setPendingSave] = useState<{ fields: SchemaFieldInput[] } | null>(null);

  // Live stream: only schema events affect the schema editor view.
  const { deletedSchemas } = useRealtime({
    schemas: isCreateRoute ? [] : [name],
    includeEntries: false,
    enabled: !isCreateRoute,
  });

  const isCreate = isCreateRoute;
  const schemaMissing = !isCreateRoute && schemaQuery.isError;
  const deleted = !isCreateRoute && deletedSchemas.has(name);
  const entriesSchemaName = isCreateRoute ? "" : name;

  useEffect(() => {
    dispatch({ type: "RESET", name: isCreateRoute ? "" : name });
  }, [name, isCreateRoute]);

  useEffect(() => {
    if (schemaQuery.isSuccess && schemaQuery.data && state.loadedName !== name) {
      dispatch({
        type: "LOAD",
        name: schemaQuery.data.name,
        version: schemaQuery.data.version,
        compatVersion: schemaQuery.data.compat_version,
        fields: schemaQuery.data.fields,
      });
    }
  }, [schemaQuery.isSuccess, schemaQuery.data, state.loadedName, name]);

  const previewMutation = useSchemaPatchPreview();

  // Auto-proceed: a non-breaking change applies immediately after the preview resolves.
  // `useLayoutEffect` closes the dialog before the browser paints, so the resolved
  // dialog state ("This will affect 0 entries.") never renders for a non-breaking save.
  // Guarded on `pendingSave` still being set so the effect is idempotent.
  useLayoutEffect(() => {
    if (
      pendingSave != null &&
      !deleted &&
      previewMutation.isSuccess &&
      previewMutation.data?.breaking === false
    ) {
      const { fields } = pendingSave;
      setPendingSave(null);
      update.mutate(
        { name: state.name, fields },
        {
          onSuccess: (schema) => {
            toast.add({ type: "success", title: "Schema saved", description: `Version ${schema.version}` });
            navigate("/schemas", { replace: true });
          },
        },
      );
    }
  }, [pendingSave, deleted, previewMutation.isSuccess, previewMutation.data, state.name, update, navigate]);

  const refSchemas = (listQuery.data ?? [])
    .map((schema) => schema.name)
    .filter((schemaName) => schemaName !== state.name);

  const activeFields = state.fields.filter((field) => !field.deleted);
  const tombstonedFields = state.fields.filter((field) => field.deleted);
  const hasTombstones = tombstonedFields.length > 0;

  const { entries: entriesList, isPending: entriesPending } = useEntries(entriesSchemaName, hasTombstones && !deleted);

  const saveBlockReason =
    hasTombstones && activeFields.length === 0
      ? "This schema needs at least one field — restore a field to save."
      : hasTombstones && activeFields.some((field) => field.label.trim() === "")
        ? "A field label is empty — fill it in or restore a field to save."
        : hasTombstones && !activeFields.some((field) => field.required)
          ? "A schema needs at least one required field — restore a field to save."
          : null;

  const pending = isCreate ? create.isPending : update.isPending;
  const saveError = isCreate ? create.error : update.error;

  function handleFieldChange(index: number, patch: Partial<Omit<SchemaDraft, "id">>) {
    if (patch.type === "schema-ref" && state.fields[index]?.type !== "schema-ref") {
      dispatch({ type: "UPDATE_FIELD", index, patch: { ...patch, ref_schema: refSchemas[0] } });
      return;
    }
    dispatch({ type: "UPDATE_FIELD", index, patch });
  }

  function handleMoveUp(index: number) {
    if (index > 0) {
      dispatch({ type: "MOVE_FIELD", from: index, to: index - 1 });
    }
  }

  function handleMoveDown(index: number) {
    if (index < state.fields.length - 1) {
      dispatch({ type: "MOVE_FIELD", from: index, to: index + 1 });
    }
  }

  function handleSave() {
    if (activeFields.length === 0) return;
    if (activeFields.some((field) => field.label.trim() === "")) return;
    if (!activeFields.some((field) => field.required)) return;
    const fields = toPayload(state.fields);

    if (isCreate) {
      if (state.name.trim() === "") return;
      create.mutate(
        { name: state.name.trim(), fields },
        {
          onSuccess: () => {
            toast.add({ type: "success", title: "Schema created" });
            navigate("/schemas", { replace: true });
          },
        },
      );
    } else {
      setPendingSave({ fields });
      previewMutation.mutate({ name: state.name, fields });
    }
  }

  function handleSaveConfirm() {
    if (pendingSave == null || deleted) return;
    // Defense in depth: do not proceed without a preview result.
    // The confirm button is disabled while the preview is pending or errored,
    // but the handler should not depend on the button state.
    if (previewMutation.data == null) return;
    const breakingAtConfirm = previewMutation.data.breaking;
    const { fields } = pendingSave;
    setPendingSave(null);
    update.mutate(
      { name: state.name, fields },
      {
        onSuccess: (schema) => {
          toast.add({ type: "success", title: "Schema saved", description: `Version ${schema.version}` });
          if (breakingAtConfirm) {
            navigate(`/content/${encodeURIComponent(state.name)}?conflicted=1`, { replace: true });
          } else {
            navigate("/schemas", { replace: true });
          }
        },
      },
    );
  }

  const labelFieldId = schemaQuery.data ? schemaLabelField(schemaQuery.data) : null;

  if (!isCreateRoute && schemaQuery.isPending) {
    return <PageSkeleton />;
  }

  if (schemaMissing) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="icon" aria-label="Back to schemas" onClick={() => navigate("/schemas")}>
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

  const saveDisabled =
    activeFields.length === 0 ||
    (isCreate && state.name.trim() === "") ||
    activeFields.some((field) => field.label.trim() === "") ||
    !activeFields.some((field) => field.required) ||
    pending ||
    deleted;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="icon" aria-label="Back to schemas" onClick={() => navigate("/schemas")}>
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
          <div>
            <h1 className="font-heading text-xl font-semibold">{isCreate ? "New schema" : state.name}</h1>
            {!isCreate && state.version > 0 && (
              <p className="text-xs text-muted-foreground">
                Version {state.version}
                {state.compatVersion !== state.version ? ` · Compatible since v${state.compatVersion}` : ""}
              </p>
            )}
          </div>
        </div>
        <Button type="button" disabled={saveDisabled} onClick={handleSave}>
          {isCreate ? "Create schema" : "Save changes"}
        </Button>
      </div>

      {saveError && (
        <Alert variant="destructive">
          <AlertTitle>{isCreate ? "Could not create schema" : "Could not save schema"}</AlertTitle>
          <AlertDescription>{errorMessage(saveError) ?? "Unknown error"}</AlertDescription>
        </Alert>
      )}

      {deleted && (
        <Alert>
          <AlertTitle>This schema was deleted</AlertTitle>
          <AlertDescription>
            {name} was deleted by another editor. It can no longer be edited.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="schema-name">Schema name</Label>
        <Input
          id="schema-name"
          value={state.name}
          readOnly={!isCreate}
          disabled={deleted}
          onChange={(event) => dispatch({ type: "SET_NAME", name: event.target.value })}
          placeholder="e.g. article"
        />
        {!isCreate && <p className="text-xs text-muted-foreground">Schema names cannot be renamed after creation.</p>}
      </div>

      {!isCreate && !deleted && hasTombstones && (
        <PendingDeletionBanner
          deletedFields={tombstonedFields}
          entryCount={entriesPending ? undefined : entriesList.length}
          entries={entriesList}
          entriesPending={entriesPending}
          blockReason={saveBlockReason}
          labelFieldId={labelFieldId}
        />
      )}

      <SchemaFieldGrid
        fields={state.fields}
        refSchemas={refSchemas}
        disabled={deleted}
        onFieldChange={handleFieldChange}
        onAddField={() => dispatch({ type: "ADD_FIELD" })}
        onRemoveField={(index) => {
          const field = state.fields[index];
          if (!field) return;
          if (field.id != null && field.id < 0) {
            dispatch({ type: "REMOVE_FIELD", index });
            return;
          }
          dispatch({ type: "MARK_FIELD_DELETED", index });
        }}
        onRestoreField={(index) => dispatch({ type: "RESTORE_FIELD", index })}
        onMoveUp={handleMoveUp}
        onMoveDown={handleMoveDown}
      />

      <SchemaSaveConfirmDialog
        open={pendingSave != null}
        onOpenChange={(open) => {
          if (!open) setPendingSave(null);
        }}
        schemaName={state.name}
        previewPending={pendingSave != null && previewMutation.isPending}
        previewError={pendingSave != null ? (errorMessage(previewMutation.error) ?? null) : null}
        affectedCount={previewMutation.data?.affectedEntries.length ?? null}
        affectedEntries={previewMutation.data?.affectedEntries ?? null}
        savePending={update.isPending}
        saveError={errorMessage(update.error) ?? null}
        onConfirm={handleSaveConfirm}
      />
    </div>
  );
}
