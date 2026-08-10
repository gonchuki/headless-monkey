import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/shared/Skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch, type ContentListEntry, type ContentValue, type SchemaEntry, type SchemaField } from "@/lib/api";
import { entryLabel, schemaLabelField } from "@/lib/entries";
import { queryKeys } from "@/lib/query";

const EMPTY_OPTION = "__none__";

export interface ReferenceSelectProps {
  field: SchemaField;
  value: ContentValue | null;
  disabled?: boolean;
  invalid?: boolean;
  onChange: (value: ContentValue | null) => void;
}

export function ReferenceSelect({
  field,
  value,
  disabled = false,
  invalid = false,
  onChange,
}: ReferenceSelectProps) {
  const refSchema = field.ref_schema;

  const schemaQuery = useQuery({
    queryKey: queryKeys.schema(refSchema ?? ""),
    queryFn: () => apiFetch<SchemaEntry>(`/api/schemas/${encodeURIComponent(refSchema ?? "")}`),
    enabled: refSchema != null,
  });

  const entriesQuery = useQuery({
    queryKey: queryKeys.entries(refSchema ?? ""),
    queryFn: () => apiFetch<ContentListEntry[]>(`/api/schemas/${encodeURIComponent(refSchema ?? "")}/entries`),
    enabled: refSchema != null,
  });

  if (schemaQuery.isPending || entriesQuery.isPending) {
    return <Skeleton className="h-8 w-full" />;
  }

  const labelFieldId = schemaQuery.data ? schemaLabelField(schemaQuery.data) : null;
  const entries = entriesQuery.data ?? [];

  return (
    <Select
      value={typeof value === "number" ? String(value) : field.required ? null : EMPTY_OPTION}
      onValueChange={(selected) => onChange(selected === EMPTY_OPTION ? null : Number(selected))}
    >
      <SelectTrigger disabled={disabled || (field.required && entries.length === 0)} aria-invalid={invalid}>
        <SelectValue placeholder={entries.length === 0 ? "No entries to reference" : "Select an entry"}>
          {(selectedValue) => {
            if (selectedValue === EMPTY_OPTION) {
              return "[empty]";
            }
            const selectedEntry = entries.find((entry) => String(entry.id) === selectedValue);
            return selectedEntry ? entryLabel(selectedEntry, labelFieldId) : null;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {!field.required && <SelectItem value={EMPTY_OPTION}>[empty]</SelectItem>}
        {entries.map((entry) => (
          <SelectItem key={entry.id} value={String(entry.id)}>
            {entryLabel(entry, labelFieldId)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
