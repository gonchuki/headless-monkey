import { Fragment, useEffect, useReducer, useState } from "react";
import { ConflictField } from "@/components/ConflictField";
import { EntryFieldInput } from "@/components/EntryFieldInput";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { isStoredValueAffected, isValueValidForField } from "@/lib/entries";
import type { ContentValue, SchemaEntry, SchemaField } from "@/lib/api";

export type EntryValues = Record<string, ContentValue | null>;

interface EntryFormState {
  values: EntryValues;
}

type EntryFormAction =
  | { type: "RESET"; values: EntryValues }
  | { type: "SET_VALUE"; fieldId: string; value: ContentValue | null };

function entryFormReducer(state: EntryFormState, action: EntryFormAction): EntryFormState {
  switch (action.type) {
    case "RESET":
      return { values: action.values };
    case "SET_VALUE":
      return { values: { ...state.values, [action.fieldId]: action.value } };
    default:
      return state;
  }
}

function validateField(field: SchemaField, value: ContentValue | null): string | null {
  if (value == null || value === "") {
    if (!field.required) return null;
    return field.type === "text" ? "This field is required and must not be empty." : "This field is required.";
  }
  if (isValueValidForField(field, value)) return null;
  switch (field.type) {
    case "number":
      return "Enter a valid number.";
    case "date":
      return "Enter a valid date.";
    case "schema-ref":
      return "Select a referenced entry.";
    default:
      return "Enter a valid value.";
  }
}

export interface DynamicEntryFormProps {
  schema: SchemaEntry;
  initialValues: EntryValues;
  storedValues?: EntryValues;
  conflict?: boolean;
  loadKey: string;
  submitLabel: string;
  pending?: boolean;
  submitError?: string | null;
  onSubmit: (values: EntryValues) => void;
}

export function DynamicEntryForm({
  schema,
  initialValues,
  storedValues = {},
  conflict = false,
  loadKey,
  submitLabel,
  pending = false,
  submitError = null,
  onSubmit,
}: DynamicEntryFormProps) {
  const [state, dispatch] = useReducer(entryFormReducer, { values: initialValues });
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    dispatch({ type: "RESET", values: initialValues });
    setErrors({});
  }, [loadKey]);

  function setValue(fieldId: string, value: ContentValue | null) {
    dispatch({ type: "SET_VALUE", fieldId, value });
    setErrors((prev) => {
      if (!(fieldId in prev)) return prev;
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
  }

  function handleSubmit() {
    const nextErrors: Record<string, string> = {};
    for (const field of schema.fields) {
      const message = validateField(field, state.values[String(field.id)] ?? null);
      if (message) nextErrors[String(field.id)] = message;
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    onSubmit(state.values);
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] items-start gap-x-4 gap-y-3">
        {schema.fields.map((field) => {
          const id = String(field.id);
          const stored = storedValues[id] ?? null;
          const affected = conflict && isStoredValueAffected(field, stored);
          const error = errors[id];
          return (
            <Fragment key={id}>
              <Label htmlFor={`entry-field-${id}`} className="justify-start gap-1 pt-2">
                {field.label}
                {field.required && (
                  <span className="text-destructive" aria-hidden="true">
                    *
                  </span>
                )}
              </Label>
              <div className="grid gap-1.5">
                {affected ? (
                  <ConflictField
                    field={field}
                    storedValue={stored}
                    newValue={state.values[id] ?? null}
                    error={error}
                    onChange={(value) => setValue(id, value)}
                  />
                ) : (
                  <>
                    <EntryFieldInput
                      field={field}
                      value={state.values[id] ?? null}
                      invalid={Boolean(error)}
                      onChange={(value) => setValue(id, value)}
                    />
                    {error && <p className="text-xs text-destructive">{error}</p>}
                  </>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>

      {submitError && (
        <Alert variant="destructive">
          <AlertTitle>Could not save entry</AlertTitle>
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}

      <Button type="button" disabled={pending} onClick={handleSubmit}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </div>
  );
}
