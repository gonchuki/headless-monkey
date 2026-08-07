import type { ContentListEntry, ContentValue, SchemaEntry, SchemaField } from "@/lib/api";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isValueValidForField(field: SchemaField, value: unknown): boolean {
  switch (field.type) {
    case "text":
      return typeof value === "string" && (!field.required || value.length > 0);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && isValidDateString(value);
    case "schema-ref":
      return typeof value === "number" && Number.isInteger(value) && value > 0;
    default:
      return false;
  }
}

export function isStoredValueAffected(field: SchemaField, stored: ContentValue | null): boolean {
  if (stored == null) {
    return field.required;
  }
  return !isValueValidForField(field, stored);
}

export function coerceStoredValue(field: SchemaField, stored: ContentValue): ContentValue | null {
  if (field.type === "text" && typeof stored === "number") {
    return String(stored);
  }
  return null;
}

export function deriveInitialValues(
  schema: SchemaEntry,
  entry: Pick<ContentListEntry, "conflict" | "values">,
): Record<string, ContentValue | null> {
  const values: Record<string, ContentValue | null> = {};
  for (const field of schema.fields) {
    const id = String(field.id);
    const stored = entry.values[id] ?? null;
    if (entry.conflict && isStoredValueAffected(field, stored)) {
      values[id] = coerceStoredValue(field, stored);
    } else {
      values[id] = stored;
    }
  }
  return values;
}

export function schemaLabelField(schema: SchemaEntry): number | null {
  return schema.fields.find((field) => field.required)?.id ?? schema.fields[0]?.id ?? null;
}

export function entryLabel(entry: Pick<ContentListEntry, "id" | "values">, labelFieldId: number | null): string {
  if (labelFieldId != null) {
    const raw = entry.values[String(labelFieldId)];
    if (raw !== undefined && raw !== null) {
      const text = String(raw);
      if (text !== "") return text;
    }
  }
  return `Entry #${entry.id}`;
}
