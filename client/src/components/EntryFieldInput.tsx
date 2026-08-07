import { ReferenceSelect } from "@/components/ReferenceSelect";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { ContentValue, SchemaField } from "@/lib/api";

export interface EntryFieldInputProps {
  field: SchemaField;
  value: ContentValue | null;
  disabled?: boolean;
  invalid?: boolean;
  onChange: (value: ContentValue | null) => void;
}

export function EntryFieldInput({
  field,
  value,
  disabled = false,
  invalid = false,
  onChange,
}: EntryFieldInputProps) {
  switch (field.type) {
    case "text":
      return (
        <Input
          type="text"
          value={typeof value === "string" ? value : value == null ? "" : String(value)}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        />
      );
    case "number":
      return (
        <Input
          type="number"
          value={typeof value === "string" || typeof value === "number" ? value : ""}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") {
              onChange(null);
              return;
            }
            const parsed = Number(raw);
            onChange(Number.isFinite(parsed) ? parsed : raw);
          }}
        />
      );
    case "date":
      return (
        <Input
          type="date"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        />
      );
    case "boolean":
      return (
        <Checkbox
          checked={typeof value === "boolean" ? value : false}
          disabled={disabled}
          aria-invalid={invalid}
          onCheckedChange={(checked) => onChange(Boolean(checked))}
        />
      );
    case "schema-ref":
      return (
        <ReferenceSelect field={field} value={value} disabled={disabled} invalid={invalid} onChange={onChange} />
      );
    default:
      return null;
  }
}
