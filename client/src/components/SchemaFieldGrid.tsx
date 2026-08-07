import { Plus } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { SchemaFieldRow } from "@/components/SchemaFieldRow";
import { FIELD_GRID_TEMPLATE } from "@/lib/schemaGrid";
import type { SchemaDraft } from "@/hooks/useSchemas";

export interface SchemaFieldGridProps {
  fields: SchemaDraft[];
  refSchemas: string[];
  disabled?: boolean;
  onFieldChange: (index: number, patch: Partial<Omit<SchemaDraft, "id">>) => void;
  onAddField: () => void;
  onRemoveField: (index: number) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
}

export function SchemaFieldGrid({
  fields,
  refSchemas,
  disabled = false,
  onFieldChange,
  onAddField,
  onRemoveField,
  onMoveUp,
  onMoveDown,
}: SchemaFieldGridProps) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className={`${FIELD_GRID_TEMPLATE} border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground`}>
        <span>Field type</span>
        <span>Field label</span>
        <span>Required</span>
        <span className="sr-only">Actions</span>
      </div>
      {fields.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No fields yet. Add at least one required field to save this schema.</p>
      ) : (
        <ul>
          {fields.map((field, index) => (
            <SchemaFieldRow
              key={field.id ?? `new-${index}`}
              field={field}
              index={index}
              total={fields.length}
              refSchemas={refSchemas}
              disabled={disabled}
              onChange={onFieldChange}
              onRemove={onRemoveField}
              onMoveUp={onMoveUp}
              onMoveDown={onMoveDown}
            />
          ))}
        </ul>
      )}
      <div className="border-t p-3">
        <Button type="button" variant="outline" size="sm" onClick={onAddField} disabled={disabled}>
          <Plus className="size-4" aria-hidden="true" />
          Add field
        </Button>
      </div>
    </div>
  );
}
