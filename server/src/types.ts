export type FieldType = "text" | "number" | "boolean" | "date" | "schema-ref";

export interface ScalarFieldInput {
  label: string;
  type: "text" | "number" | "boolean" | "date";
  required: boolean;
}

export interface SchemaRefFieldInput {
  label: string;
  type: "schema-ref";
  required: boolean;
  ref_schema: string;
}

export type FieldInput = ScalarFieldInput | SchemaRefFieldInput;

export interface ScalarFieldWithId extends ScalarFieldInput {
  id: number;
  sort_order: number;
}

export interface SchemaRefFieldWithId extends SchemaRefFieldInput {
  id: number;
  sort_order: number;
}

export type FieldWithId = ScalarFieldWithId | SchemaRefFieldWithId;

export interface SchemaCreateInput {
  name: string;
  fields: FieldInput[];
}

export interface SchemaUpdateInput {
  fields: (FieldWithId | ScalarFieldInput | SchemaRefFieldInput)[];
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

// ── Pagination ───────────────────────────────────────────────────────

export const DEFAULT_LIMIT = 50;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 200;

export interface PaginationParams {
  limit?: number;
  cursor?: number;
  direction?: "forward" | "backward";
}

export interface PaginationResponse {
  nextCursor: number | null;
  prevCursor: number | null;
}

/** Clamp a raw limit to [MIN_LIMIT, MAX_LIMIT]; undefined → DEFAULT_LIMIT. */
export function clampLimit(raw?: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(raw)));
}

/**
 * Parse a cursor value. Non-finite, zero, or negative → null (treated as
 * "no cursor" / first page).
 */
export function parseCursor(raw?: number): number | null {
  if (raw === undefined || raw === null || !Number.isFinite(raw) || raw < 1)
    return null;
  return Math.floor(raw);
}
