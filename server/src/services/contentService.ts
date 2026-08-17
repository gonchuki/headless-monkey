import type { Db } from "../db/database";
import { ContentRepository, ContentEntryRow } from "../repositories/contentRepo";
import { SchemaRepository } from "../repositories/schemaRepo";
import {
  coerceScalarValue,
  isScalarValueValid,
} from "./fieldValidation";
import type { FieldWithId, SchemaEntry, PaginationParams, PaginationResponse, SortParams, ResolvedSortParams } from "../types";

export interface SchemaRefValue {
  id: number;
  schema: string;
}

export type ContentValue = string | number | boolean | SchemaRefValue;

export interface ContentEntry {
  id: number;
  schema: string;
  schema_version: number;
  creation_date: string;
  created_by: string;
  last_modified_date: string;
  last_modified_by: string;
  values: Record<string, ContentValue>;
}

export interface ContentListEntry extends ContentEntry {
  conflict: boolean;
  /** Distinct entries that reference this one via a schema-ref (R34 warning). */
  referencer_count: number;
}

/**
 * Editor shape: `values` keyed by `String(field_id)` with schema-ref values as raw
 * target content-id numbers (what the client consumes via the editor routes).
 * Public shape: `values` keyed by field label with schema-ref values enriched to
 * `{id, schema}` (self-describing read API).
 */
export type EntryShape = "editor" | "public";

export class ContentServiceError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
}

interface BuiltEntryValues {
  /** Scalar rows (text|number|boolean|date) to store in content_rows. */
  rows: Map<number, string>;
  /** Schema-ref targets (field_id → target content id) to store in content_refs. */
  refs: Map<number, number>;
}

export class ContentService {
  private db: Db;
  private repo: ContentRepository;
  private schemaRepo: SchemaRepository;

  constructor(db: Db) {
    this.db = db;
    this.repo = new ContentRepository(db);
    this.schemaRepo = new SchemaRepository(db);
  }

  create(
    schemaName: string,
    values: Record<string, unknown>,
    createdBy: string
  ): ContentEntry {
    const schema = this.requireSchema(schemaName);
    // Wrap validation + insert in one transaction so a concurrent DELETE of a
    // schema-ref target cannot slip between entryExistsInSchema and the FK check.
    return this.db.transaction(() => {
      try {
        const built = this.buildRows(schema, null, values);
        const id = this.repo.insert(
          schema.name,
          schema.version,
          createdBy,
          built.rows,
          built.refs
        );
        return this.toEntry(this.requireEntry(id), schema, false, "editor");
      } catch (err) {
        // If the FK constraint fires (target deleted between validation and insert),
        // better-sqlite3 throws a SqliteError. Convert to 422 so the route handler
        // returns a proper error instead of 500.
        if (typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string" && (err as { code: string }).code.includes("FOREIGNKEY")) {
          throw new ContentServiceError(422, `Schema-ref target entry no longer exists`);
        }
        throw err;
      }
    })();
  }

  update(
    entryId: number,
    values: Record<string, unknown>,
    modifiedBy: string
  ): ContentEntry {
    // Wrap read + validate + write in one transaction so a concurrent PATCH
    // cannot interleave between getEntry and replaceRows (TOCTOU lost-update).
    // better-sqlite3 serializes transactions: the second caller blocks until
    // the first commits, then re-reads the fresh state.
    return this.db.transaction(() => {
      const existing = this.repo.getEntry(entryId);
      if (!existing) {
        throw new ContentServiceError(404, `Entry ${entryId} not found`);
      }
      const schema = this.requireSchema(existing.record.schema);
      const built = this.buildRows(schema, existing, values);
      this.repo.replaceRows(
        entryId,
        schema.version,
        modifiedBy,
        built.rows,
        built.refs
      );
      return this.toEntry(this.requireEntry(entryId), schema, false, "editor");
    })();
  }

  delete(entryId: number): void {
    const existing = this.repo.getEntry(entryId);
    if (!existing) {
      throw new ContentServiceError(404, `Entry ${entryId} not found`);
    }
    // R34 (updated): clear all content_refs pointing at the target before
    // removing the entry itself. Both operations are wrapped in a single
    // transaction so either both succeed or neither does.
    this.db.transaction(() => {
      this.repo.clearReferencesTo(entryId);
      this.repo.delete(entryId);
    })();
  }

  getEntryMeta(entryId: number): { id: number; schema: string } | null {
    const existing = this.repo.getEntry(entryId);
    if (!existing) return null;
    return { id: existing.record.id, schema: existing.record.schema };
  }

  countForSchema(schemaName: string): number {
    this.requireSchema(schemaName);
    return this.repo.countBySchema(schemaName);
  }

  /** Returns the schema for the public route projection; unknown schema → 404 (same as listPublic/getPublic). */
  getSchema(schemaName: string): SchemaEntry {
    return this.requireSchema(schemaName);
  }

  listForSchema(schemaName: string): ContentListEntry[];
  listForSchema(
    schemaName: string,
    pagination: PaginationParams,
    sort?: SortParams,
    conflictedOnly?: boolean
  ): { entries: ContentListEntry[]; pagination: PaginationResponse };
  listForSchema(
    schemaName: string,
    sort: SortParams,
    conflictedOnly?: boolean
  ): ContentListEntry[];
  listForSchema(
    schemaName: string,
    arg1?: PaginationParams | SortParams | boolean,
    arg2?: SortParams | boolean,
    arg3?: boolean
  ):
    | ContentListEntry[]
    | { entries: ContentListEntry[]; pagination: PaginationResponse } {
    const schema = this.requireSchema(schemaName);

    // Determine if first arg is pagination or sort.
    // SortParams requires sortField (a number, 'id', 'date', or 'modified');
    // PaginationParams has only optional fields (limit, cursor, direction).
    // When the first arg has sortField, it's a sort; otherwise treat as pagination.
    let pagination: PaginationParams | undefined;
    let resolvedSort: ResolvedSortParams | undefined;
    let conflictedOnly = false;

    if (typeof arg1 === "boolean") {
      // listForSchema(name, conflictedOnly)
      conflictedOnly = arg1;
    } else if (arg1 && typeof arg1 === "object" && "sortField" in arg1) {
      // listForSchema(name, sort, conflictedOnly?)
      resolvedSort = this.resolveSort(schema, arg1 as SortParams);
      if (typeof arg2 === "boolean") conflictedOnly = arg2;
    } else if (arg1 && typeof arg1 === "object") {
      // listForSchema(name, pagination, sort?, conflictedOnly?)
      pagination = arg1 as PaginationParams;
      if (arg2 && typeof arg2 === "object" && "sortField" in arg2) {
        resolvedSort = this.resolveSort(schema, arg2 as SortParams);
        if (typeof arg3 === "boolean") conflictedOnly = arg3;
      } else if (typeof arg2 === "boolean") {
        conflictedOnly = arg2;
      } else if (typeof arg3 === "boolean") {
        // pagination, undefined sort, conflictedOnly
        conflictedOnly = arg3;
      }
    }

    const maxVersion = conflictedOnly ? schema.compat_version : undefined;

    if (pagination !== undefined) {
      const result = this.repo.listEntriesPaginated(schemaName, pagination, resolvedSort, undefined, maxVersion);
      return {
        entries: result.entries.map((entry) =>
          this.toEntry(entry, schema, true, "editor")
        ),
        pagination: result.pagination,
      };
    }
    return this.repo
      .listEntries(schemaName, resolvedSort, undefined, maxVersion)
      .map((entry) => this.toEntry(entry, schema, true, "editor"));
  }

  listPublic(schemaName: string): ContentEntry[];
  listPublic(
    schemaName: string,
    pagination: PaginationParams,
    sort?: SortParams
  ): { entries: ContentEntry[]; pagination: PaginationResponse };
  listPublic(
    schemaName: string,
    sort: SortParams
  ): ContentEntry[];
  listPublic(
    schemaName: string,
    paginationOrSort?: PaginationParams | SortParams,
    sort?: SortParams
  ):
    | ContentEntry[]
    | { entries: ContentEntry[]; pagination: PaginationResponse } {
    const schema = this.requireSchema(schemaName);

    let pagination: PaginationParams | undefined;
    let resolvedSort: ResolvedSortParams | undefined;

    if (paginationOrSort && "sortField" in paginationOrSort) {
      resolvedSort = this.resolveSort(schema, paginationOrSort as SortParams);
      if (sort) {
        resolvedSort = this.resolveSort(schema, sort);
      }
    } else if (paginationOrSort) {
      pagination = paginationOrSort as PaginationParams;
      resolvedSort = sort ? this.resolveSort(schema, sort) : undefined;
    }

    if (pagination !== undefined) {
      const result = this.repo.listEntriesPaginated(schemaName, pagination, resolvedSort, schema.compat_version);
      return {
        entries: result.entries.map((entry) => this.toEntry(entry, schema, false)),
        pagination: result.pagination,
      };
    }
    return this.repo
      .listEntries(schemaName, resolvedSort, schema.compat_version)
      .map((entry) => this.toEntry(entry, schema, false));
  }

  getPublic(schemaName: string, entryId: number): ContentEntry {
    const schema = this.requireSchema(schemaName);
    const entry = this.repo.getEntry(entryId);
    if (!entry || entry.record.schema !== schemaName) {
      throw new ContentServiceError(404, `Entry ${entryId} not found`);
    }
    if (entry.record.schema_version < schema.compat_version) {
      throw new ContentServiceError(
        422,
        `Entry ${entryId} is in conflict with schema '${schemaName}' and must be re-edited`
      );
    }
    return this.toEntry(entry, schema, false);
  }

  private requireSchema(schemaName: string): SchemaEntry {
    const schema = this.schemaRepo.getSchema(schemaName);
    if (!schema) {
      throw new ContentServiceError(404, `Schema '${schemaName}' not found`);
    }
    return schema;
  }

  private resolveSort(schema: SchemaEntry, sort: SortParams): ResolvedSortParams {
    const sortOrder = sort.sortOrder ?? "asc";

    if (sort.sortField === "id" || sort.sortField === "date" || sort.sortField === "modified") {
      return { sortField: sort.sortField, sortOrder };
    }

    // Validate field_id
    const field = schema.fields.find((f) => f.id === sort.sortField);
    if (!field) {
      throw new ContentServiceError(422, `Unknown sort field_id: ${sort.sortField}`);
    }
    if (field.type === "boolean" || field.type === "schema-ref") {
      throw new ContentServiceError(
        422,
        `Cannot sort by field '${field.label}' (type: ${field.type})`
      );
    }

    return { sortField: sort.sortField, sortOrder, sortFieldType: field.type };
  }

  private requireEntry(id: number): ContentEntryRow {
    const entry = this.repo.getEntry(id);
    if (!entry) {
      throw new ContentServiceError(404, `Entry ${id} not found`);
    }
    return entry;
  }

  private buildRows(
    schema: SchemaEntry,
    existing: ContentEntryRow | null,
    values: Record<string, unknown>
  ): BuiltEntryValues {
    const knownIds = new Set(schema.fields.map((f) => f.id));
    const submittedIds = new Set<number>();

    for (const key of Object.keys(values)) {
      const id = Number(key);
      if (!Number.isInteger(id) || !knownIds.has(id)) {
        throw new ContentServiceError(
          422,
          `Unknown field_id: ${key}`,
          { fieldId: key }
        );
      }
      submittedIds.add(id);
    }

    const rows = new Map<number, string>();
    const refs = new Map<number, number>();

    for (const field of schema.fields) {
      const id = String(field.id);
      const submitted = values[id];

      if (submitted !== undefined && submitted !== null) {
        this.validateSubmitted(field, submitted);
        if (field.type === "schema-ref") {
          refs.set(field.id, submitted as number);
        } else {
          rows.set(field.id, JSON.stringify(submitted));
        }
        continue;
      }

      if (submitted === null) {
        if (field.required) {
          throw new ContentServiceError(
            422,
            `Missing required field '${field.label}'`
          );
        }
        continue;
      }

      if (existing) {
        if (field.type === "schema-ref") {
          const storedRef = existing.refs.find((r) => r.field_id === field.id);
          if (storedRef) {
            if (!this.isValidValue(field, storedRef.target_content_id)) {
              throw new ContentServiceError(
                422,
                `Field '${field.label}' has a stored reference invalid for its current type; re-enter a valid value`
              );
            }
            refs.set(field.id, storedRef.target_content_id);
            continue;
          }
        } else {
          const stored = existing.rows.find((r) => r.field_id === field.id)?.value;
          if (stored !== null && stored !== undefined) {
            const parsed = JSON.parse(stored) as unknown;
            if (this.isValidValue(field, parsed)) {
              rows.set(field.id, stored);
              continue;
            }
            const coerced = this.coerce(field, parsed);
            if (coerced !== null) {
              rows.set(field.id, JSON.stringify(coerced));
              continue;
            }
            throw new ContentServiceError(
              422,
              `Field '${field.label}' has a stored value invalid for its current type; re-enter a valid value`
            );
          }
        }
      }

      if (field.required) {
        throw new ContentServiceError(
          422,
          `Missing required field '${field.label}'`
        );
      }
    }

    return { rows, refs };
  }

  private validateSubmitted(field: FieldWithId, value: unknown): void {
    if (this.isValidValue(field, value)) return;
    throw new ContentServiceError(
      422,
      `Invalid value for field '${field.label}'`,
      { fieldId: field.id }
    );
  }

  private isValidValue(field: FieldWithId, value: unknown): boolean {
    if (field.type === "schema-ref") {
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value > 0 &&
        this.repo.entryExistsInSchema(value, field.ref_schema)
      );
    }
    return isScalarValueValid(field.type, field.required, value);
  }

  private coerce(field: FieldWithId, value: unknown): unknown {
    if (field.type === "schema-ref") return null;
    return coerceScalarValue(field.type, value);
  }

  private toEntry(
    entry: ContentEntryRow,
    schema: SchemaEntry,
    includeConflict: true,
    shape?: EntryShape
  ): ContentListEntry;
  private toEntry(
    entry: ContentEntryRow,
    schema: SchemaEntry,
    includeConflict?: false,
    shape?: EntryShape
  ): ContentEntry;
  private toEntry(
    entry: ContentEntryRow,
    schema: SchemaEntry,
    includeConflict = false,
    shape: EntryShape = "public"
  ): ContentEntry | ContentListEntry {
    const fieldsById = new Map(schema.fields.map((f) => [f.id, f]));
    const refsByField = new Map<number, number>(
      entry.refs.map((r) => [r.field_id, r.target_content_id])
    );
    const values: Record<string, ContentValue> = {};

    for (const row of entry.rows) {
      const field = fieldsById.get(row.field_id);
      if (!field || field.type === "schema-ref") continue;
      const parsed = JSON.parse(row.value ?? "null") as ContentValue;
      if (shape === "editor") {
        values[String(field.id)] = parsed;
      } else {
        values[field.label] = parsed;
      }
    }

    for (const [fieldId, targetContentId] of refsByField) {
      const field = fieldsById.get(fieldId);
      if (!field || field.type !== "schema-ref") continue;
      if (shape === "editor") {
        values[String(field.id)] = targetContentId;
      } else {
        values[field.label] = { id: targetContentId, schema: field.ref_schema };
      }
    }

    const base: ContentEntry = {
      id: entry.record.id,
      schema: entry.record.schema,
      schema_version: entry.record.schema_version,
      creation_date: entry.record.creation_date,
      created_by: entry.record.created_by,
      last_modified_date: entry.record.last_modified_date,
      last_modified_by: entry.record.last_modified_by,
      values,
    };

    if (includeConflict) {
      return {
        ...base,
        conflict: entry.record.schema_version < schema.compat_version,
        referencer_count: entry.record.referencer_count,
      };
    }
    return base;
  }
}
