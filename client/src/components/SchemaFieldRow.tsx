import { ArrowCounterClockwise, ArrowDown, ArrowUp, Trash } from "@phosphor-icons/react";
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
import { schemaColor } from "@/lib/schemaColors";
import { FIELD_TYPE_LABELS, FIELD_TYPES, type FieldType } from "@/lib/api";
import { FIELD_GRID_TEMPLATE } from "@/lib/schemaGrid";
import { cn } from "@/lib/utils";
import type { SchemaDraft } from "@/hooks/useSchemas";
import { SchemaBadge } from "./shared/SchemaBadge";

export interface SchemaFieldRowProps {
  field: SchemaDraft;
  index: number;
  total: number;
  refSchemas: string[];
  disabled?: boolean;
  /** True when the field is staged for deletion in the draft. */
  deleted?: boolean;
  onChange: (index: number, patch: Partial<Omit<SchemaDraft, "id">>) => void;
  onRemove: (index: number) => void;
  onRestore?: (index: number) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
}

export function SchemaFieldRow({
  field,
  index,
  total,
  refSchemas,
  disabled = false,
  deleted = false,
  onChange,
  onRemove,
  onRestore,
  onMoveUp,
  onMoveDown,
}: SchemaFieldRowProps) {
  const isLast = index === total - 1;
  const inert = disabled || deleted;

  return (
    <li className={cn("border-b p-3 last:border-b-0", deleted && "bg-muted/30")}>
      <div className={FIELD_GRID_TEMPLATE}>
        <Select value={field.type} disabled={inert} onValueChange={(value) => onChange(index, { type: value as FieldType })}>
          <SelectTrigger className="w-full" aria-label={`Field ${index + 1} type`}>
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
        <Input
          value={field.label}
          disabled={inert}
          className={cn(deleted && "line-through")}
          onChange={(event) => onChange(index, { label: event.target.value })}
          aria-label={`Field ${index + 1} label`}
          placeholder="Field label"
        />
        <Checkbox
          checked={field.required}
          disabled={inert}
          onCheckedChange={(checked) => onChange(index, { required: checked })}
          aria-label={`Field ${index + 1} required`}
        />
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={inert || index === 0}
            onClick={() => onMoveUp(index)}
            aria-label={`Move field ${index + 1} up`}
          >
            <ArrowUp className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={inert || isLast}
            onClick={() => onMoveDown(index)}
            aria-label={`Move field ${index + 1} down`}
          >
            <ArrowDown className="size-4" aria-hidden="true" />
          </Button>
          {!deleted && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              onClick={() => onRemove(index)}
              aria-label={`Delete field ${index + 1}`}
            >
              <Trash className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
      {deleted ? (
        onRestore != null && (
          <div className="mt-2 flex">
            <Button type="button" variant="outline" size="sm" onClick={() => onRestore(index)}>
              <ArrowCounterClockwise className="size-3.5" aria-hidden="true" />
              Undo delete
            </Button>
          </div>
        )
      ) : field.type === "schema-ref" ? (
        <div className="mt-2 grid gap-1.5">
          <Label htmlFor={`field-${index}-ref`}>Referenced schema</Label>
          <Select
            value={field.ref_schema ?? null}
            disabled={disabled}
            onValueChange={(value) => onChange(index, { ref_schema: typeof value === "string" ? value : undefined })}
          >
            <SelectTrigger id={`field-${index}-ref`}>
              <SelectValue>
                {(value) => {
                  if (!value) return "Select a schema"

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
              {refSchemas.map((schema) => (
                <SelectItem key={schema} value={schema}>
                  <SchemaBadge bgcolor={schemaColor(schema).background} className="self-center"  />
                  {schema}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </li>
  );
}
