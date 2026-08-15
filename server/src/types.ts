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
  /** Opaque cursor string (see {@link encodeCursor} / {@link parseCursor}). */
  cursor?: string;
  direction?: "forward" | "backward";
}

export interface PaginationResponse {
  nextCursor: string | null;
  prevCursor: string | null;
}

/** Clamp a raw limit to [MIN_LIMIT, MAX_LIMIT]; undefined → DEFAULT_LIMIT. */
export function clampLimit(raw?: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(raw)));
}

/**
 * A decoded pagination cursor: the anchor row's sort-column value plus its
 * `content.id` tiebreak. `value === null` means the anchor row has a SQL NULL
 * sort value (custom-field sorts only); it is distinct from any string value.
 */
export interface DecodedCursor {
  value: number | string | null;
  id: number;
  /** True when decoded from a legacy bare-id cursor (valid for id sorts only). */
  legacy: boolean;
}

/**
 * Encode an opaque cursor from the anchor row's sort-column value and its
 * `content.id`. The encoding is base64url of a small JSON pair, so it is safe
 * to carry in a URL query param and reversible. JSON `null` distinguishes a
 * SQL NULL sort value from any string value.
 */
export function encodeCursor(value: number | string | null, id: number): string {
  return Buffer.from(JSON.stringify({ v: value, i: id }), "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor. Returns null (treated as "no cursor" / first page)
 * for missing or undecodable input, preserving the lenient behavior for
 * garbage input. A bare positive integer is accepted as a legacy id cursor
 * (`value` and `id` both the integer); callers must treat legacy cursors as
 * valid only for id sorts.
 */
export function parseCursor(raw?: string | null): DecodedCursor | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === "") return null;

  // Legacy bare-id cursor from pre-keyset clients.
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    return { value: n, id: n, legacy: true };
  }

  // Opaque cursor: base64url of JSON { v, i }.
  try {
    const json = Buffer.from(s, "base64url").toString("utf8");
    const obj: unknown = JSON.parse(json);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    const { v, i } = obj as { v?: unknown; i?: unknown };
    if (v !== null && typeof v !== "string" && typeof v !== "number") return null;
    if (typeof i !== "number" || !Number.isSafeInteger(i) || i < 1) return null;
    return { value: v, id: i, legacy: false };
  } catch {
    return null;
  }
}

// ── Sorting ──────────────────────────────────────────────────────────

export interface SortParams {
  /** Field id (number), 'id' for content.id, or 'date' for creation_date. */
  sortField: number | "id" | "date";
  sortOrder?: "asc" | "desc";
}

/** Resolved sort params after service-layer validation. Carries field type for SQL generation. */
export interface ResolvedSortParams {
  sortField: number | "id" | "date";
  sortOrder: "asc" | "desc";
  /** When sortField is a number, this is the field's scalar type. */
  sortFieldType?: "text" | "number" | "date";
}
