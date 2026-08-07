import { ArrowDown, ArrowUp, Trash } from "@phosphor-icons/react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FIELD_TYPE_LABELS, FIELD_TYPES, type FieldType } from "@/lib/api";
import type { SchemaDraft } from "@/hooks/useSchemas";

export interface SchemaFieldRowProps {
  field: SchemaDraft;
  index: number;
  total: number;
  refSchemas: string[];
  onChange: (index: number, patch: Partial<Omit<SchemaDraft, "id">>) => void;
  onRemove: (index: number) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
}

export function SchemaFieldRow({
  field,
  index,
  total,
  refSchemas,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: SchemaFieldRowProps) {
  const isLast = index === total - 1;

  return (
    <li className="border-b p-3 last:border-b-0">
      <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_auto_auto] items-center gap-2">
        <Input
          value={field.label}
          onChange={(event) => onChange(index, { label: event.target.value })}
          aria-label={`Field ${index + 1} label`}
          placeholder="Field label"
        />
        <Select value={field.type} onValueChange={(value) => onChange(index, { type: value as FieldType })}>
          <SelectTrigger aria-label={`Field ${index + 1} type`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FIELD_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {FIELD_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Checkbox
          checked={field.required}
          onCheckedChange={(checked) => onChange(index, { required: checked })}
          aria-label={`Field ${index + 1} required`}
        />
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={index === 0}
            onClick={() => onMoveUp(index)}
            aria-label={`Move field ${index + 1} up`}
          >
            <ArrowUp className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={isLast}
            onClick={() => onMoveDown(index)}
            aria-label={`Move field ${index + 1} down`}
          >
            <ArrowDown className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onRemove(index)}
            aria-label={`Delete field ${index + 1}`}
          >
            <Trash className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {field.type === "schema-ref" && (
        <div className="mt-2 grid gap-1.5">
          <Label htmlFor={`field-${index}-ref`}>Referenced schema</Label>
          <Select
            value={field.ref_schema ?? null}
            onValueChange={(value) => onChange(index, { ref_schema: typeof value === "string" ? value : undefined })}
          >
            <SelectTrigger id={`field-${index}-ref`}>
              <SelectValue placeholder="Select a schema" />
            </SelectTrigger>
            <SelectContent>
              {refSchemas.map((schema) => (
                <SelectItem key={schema} value={schema}>
                  {schema}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </li>
  );
}
