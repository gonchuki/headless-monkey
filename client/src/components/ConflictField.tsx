import { EntryFieldInput } from "@/components/EntryFieldInput";
import { Input } from "@/components/ui/input";
import type { ContentValue, SchemaField } from "@/lib/api";

export interface ConflictFieldProps {
  field: SchemaField;
  storedValue: ContentValue | null;
  newValue: ContentValue | null;
  error?: string | null;
  disabled?: boolean;
  onChange: (value: ContentValue | null) => void;
}

export function ConflictField({
  field,
  storedValue,
  newValue,
  error,
  disabled = false,
  onChange,
}: ConflictFieldProps) {
  return (
    <div className="grid gap-2">
      <div className="grid gap-1">
        <span className="text-xs text-muted-foreground">Previous value</span>
        <Input value={storedValue == null ? "" : String(storedValue)} disabled readOnly />
      </div>
      <div className="grid gap-1">
        <span className="text-xs text-muted-foreground">New value</span>
        <EntryFieldInput
          field={field}
          value={newValue}
          disabled={disabled}
          invalid={Boolean(error)}
          onChange={onChange}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
