import { Skeleton } from "@/components/shared/Skeleton";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { schemaColor } from "@/lib/schemaColors";
import { useSchemas } from "@/hooks/useSchemas";

export interface NewEntrySelectorProps {
  value?: string;
  onChange: (schemaName: string) => void;
}

export function NewEntrySelector({ value, onChange }: NewEntrySelectorProps) {
  const { listQuery } = useSchemas();
  const schemas = listQuery.data ?? [];

  if (listQuery.isPending) {
    return <Skeleton className="h-8 w-full" />;
  }

  const empty = schemas.length === 0;

  return (
    <div className="grid gap-1.5">
      <Label htmlFor="new-entry-schema">Schema</Label>
      <Select
        value={value ?? null}
        onValueChange={(schemaName) => {
          if (typeof schemaName === "string") {
            onChange(schemaName);
          }
        }}
      >
        <SelectTrigger id="new-entry-schema" disabled={empty}>
          <SelectValue placeholder={empty ? "No schemas yet" : "Select a schema"} />
        </SelectTrigger>
        <SelectContent>
          {schemas.map((schema) => (
            <SelectItem key={schema.name} value={schema.name}>
              <span
                className="inline-block size-4 shrink-0 rounded-full"
                style={{ backgroundColor: schemaColor(schema.name).background }}
                aria-hidden="true"
              />
              {schema.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {empty && <p className="text-xs text-muted-foreground">Create a schema before adding content.</p>}
    </div>
  );
}
