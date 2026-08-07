import { useEffect, useReducer, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "@phosphor-icons/react";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { PageSkeleton } from "@/components/shared/PageSkeleton";
import { SchemaFieldGrid } from "@/components/SchemaFieldGrid";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { useRealtime } from "@/hooks/useRealtime";
import { useSchemaEntryCount, useSchemas, type SchemaDraft } from "@/hooks/useSchemas";
import { apiFetch, type SchemaEntry, type SchemaFieldInput } from "@/lib/api";
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
          ref_schema: field.ref_schema,
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
        fields: [...state.fields, { id: state.nextNewId, label: "", type: "text", required: false }],
        nextNewId: state.nextNewId - 1,
      };
    case "REMOVE_FIELD":
      return { ...state, fields: state.fields.filter((_, index) => index !== action.index) };
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
  return fields.map((field) => {
    const { id, ...rest } = field;
    return id !== undefined && id > 0 ? { id, ...rest } : rest;
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
  const [fieldToDelete, setFieldToDelete] = useState<number | null>(null);

  // Live stream: only schema events affect the schema editor view.
  const { deletedSchemas } = useRealtime({
    schemas: isCreateRoute ? [] : [name],
    includeEntries: false,
    enabled: !isCreateRoute,
  });

  const isCreate = isCreateRoute;
  const schemaMissing = !isCreateRoute && schemaQuery.isError;
  const deleted = !isCreateRoute && deletedSchemas.has(name);

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

  const refSchemas = (listQuery.data ?? [])
    .map((schema) => schema.name)
    .filter((schemaName) => schemaName !== state.name);

  const fieldDeleteCount = useSchemaEntryCount(name, fieldToDelete != null && !isCreate);
  const affectedFieldCount = isCreate ? 0 : fieldDeleteCount.data;
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
    if (state.fields.length === 0) return;
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
  }

  if (!isCreateRoute && schemaQuery.isPending) {
    return <PageSkeleton />;
  }

  if (schemaMissing) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
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

  const canSave = state.fields.length === 0 || (isCreate && state.name.trim() === "") || pending || deleted;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
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
        <Button type="button" disabled={canSave} onClick={handleSave}>
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

      <SchemaFieldGrid
        fields={state.fields}
        refSchemas={refSchemas}
        disabled={deleted}
        onFieldChange={handleFieldChange}
        onAddField={() => dispatch({ type: "ADD_FIELD" })}
        onRemoveField={setFieldToDelete}
        onMoveUp={handleMoveUp}
        onMoveDown={handleMoveDown}
      />

      <DeleteConfirmDialog
        open={fieldToDelete != null}
        onOpenChange={(open) => {
          if (!open) setFieldToDelete(null);
        }}
        title="Delete field?"
        description={
          fieldToDelete != null && (
            <>
              Delete the field{" "}
              <span className="font-medium text-foreground">{state.fields[fieldToDelete]?.label || "Unnamed"}</span>? Its
              stored values are removed from this schema&apos;s content.
              <span className="mt-1 block">
                {affectedFieldCount == null
                  ? "Counting affected entries…"
                  : `This affects ${affectedFieldCount} ${affectedFieldCount === 1 ? "entry" : "entries"}.`}
              </span>
            </>
          )
        }
        confirmLabel="Delete field"
        pending={false}
        onConfirm={() => {
          if (fieldToDelete != null) {
            dispatch({ type: "REMOVE_FIELD", index: fieldToDelete });
          }
          setFieldToDelete(null);
        }}
      />
    </div>
  );
}
