export type FieldType = "text" | "number" | "boolean" | "date" | "schema-ref";

export interface FieldInput {
  label: string;
  type: FieldType;
  required: boolean;
  ref_schema?: string;
}

export interface FieldWithId extends FieldInput {
  id: number;
  sort_order: number;
}

export interface SchemaCreateInput {
  name: string;
  fields: FieldInput[];
}

export interface SchemaUpdateInput {
  fields: (FieldWithId | Omit<FieldInput, "id">)[];
}

export interface SchemaEntry {
  name: string;
  version: number;
  compat_version: number;
  creation_date: string;
  created_by: string;
  last_modified_date: string;
  last_modified_by: string;
  fields: FieldWithId[];
}

export interface SchemaListEntry {
  name: string;
  version: number;
  compat_version: number;
  field_count: number;
  entry_count: number;
}

export interface SchemaUpdatePreviewEntry {
  id: number;
  label: string; // first-required-field value by sort_order (listing convention), else `Entry #<id>`
  affectedFieldIds: number[];
}

export interface SchemaUpdatePreview {
  breaking: boolean;
  version: number;        // the version the PATCH would produce
  compatVersion: number;  // the compat_version the PATCH would produce
  affectedEntries: SchemaUpdatePreviewEntry[];
}
