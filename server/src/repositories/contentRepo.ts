import type { Db } from "../db/database";
import type { DecodedCursor, PaginationParams, PaginationResponse, ResolvedSortParams } from "../types";
import { clampLimit, encodeCursor, parseCursor } from "../types";

export interface ContentRecord {
  id: number;
  schema: string;
  schema_version: number;
  creation_date: string;
  created_by: string;
  last_modified_date: string;
  last_modified_by: string;
  /** Distinct referencing-entry count (# of entries whose schema-ref points here). */
  referencer_count: number;
}

export interface ContentRow {
  field_id: number;
  value: string | null;
}

export interface ContentRef {
  field_id: number;
  target_content_id: number;
}

export interface ContentEntryRow {
  record: ContentRecord;
  /** Scalar rows only (text|number|boolean|date) — schema-ref values never live here. */
  rows: ContentRow[];
  /** Normalized schema-ref edges, one per (content_id, field_id), ordered by field_id. */
  refs: ContentRef[];
}

export class ContentRepository {
  constructor(private db: Db) {}

  insert(
    schema: string,
    schemaVersion: number,
    createdBy: string,
    values: Map<number, string>,
    refs: Map<number, number> = new Map()
  ): number {
    const now = new Date().toISOString();
    const insertContent = this.db.prepare(
      "INSERT INTO content (schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertRow = this.db.prepare(
      "INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)"
    );
    const insertRef = this.db.prepare(
      "INSERT INTO content_refs (content_id, field_id, target_content_id) VALUES (?, ?, ?)"
    );

    const tx = this.db.transaction(() => {
      const result = insertContent.run(
        schema,
        schemaVersion,
        now,
        createdBy,
        now,
        createdBy
      );
      const id = Number(result.lastInsertRowid);
      for (const [fieldId, value] of values) {
        insertRow.run(id, fieldId, value);
      }
      for (const [fieldId, targetContentId] of refs) {
        insertRef.run(id, fieldId, targetContentId);
      }
      return id;
    });

    return tx();
  }

  replaceRows(
    id: number,
    schemaVersion: number,
    modifiedBy: string,
    values: Map<number, string>,
    refs: Map<number, number> = new Map()
  ): void {
    const now = new Date().toISOString();
    const insertRow = this.db.prepare(
      "INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)"
    );
    const insertRef = this.db.prepare(
      "INSERT INTO content_refs (content_id, field_id, target_content_id) VALUES (?, ?, ?)"
    );

    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM content_rows WHERE content_id = ?").run(id);
      this.db.prepare("DELETE FROM content_refs WHERE content_id = ?").run(id);
      for (const [fieldId, value] of values) {
        insertRow.run(id, fieldId, value);
      }
      for (const [fieldId, targetContentId] of refs) {
        insertRef.run(id, fieldId, targetContentId);
      }
      this.db
        .prepare(
          "UPDATE content SET schema_version = ?, last_modified_date = ?, last_modified_by = ? WHERE id = ?"
        )
        .run(schemaVersion, now, modifiedBy, id);
    });

    tx();
  }

  clearReferencesTo(targetContentId: number): void {
    this.db
      .prepare("DELETE FROM content_refs WHERE target_content_id = ?")
      .run(targetContentId);
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM content WHERE id = ?").run(id);
  }

  /**
   * Distinct referencing-entry count for a target entry: how many *entries*
   * (not reference rows) currently point at it via a schema-ref value. If one
   * entry has two schema-ref fields aimed at the same target, it counts once.
   */
  countReferencesTo(targetContentId: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(DISTINCT content_id) AS count FROM content_refs WHERE target_content_id = ?"
      )
      .get(targetContentId) as { count: number };
    return row.count;
  }

  getEntry(id: number): ContentEntryRow | null {
    const record = this.db
      .prepare(
        "SELECT id, schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by, (SELECT COUNT(DISTINCT content_id) FROM content_refs WHERE target_content_id = content.id) AS referencer_count FROM content WHERE id = ?"
      )
      .get(id) as ContentRecord | undefined;

    if (!record) return null;

    const rows = this.db
      .prepare(
        "SELECT field_id, value FROM content_rows WHERE content_id = ? ORDER BY field_id"
      )
      .all(id) as ContentRow[];

    const refs = this.db
      .prepare(
        "SELECT field_id, target_content_id FROM content_refs WHERE content_id = ? ORDER BY field_id"
      )
      .all(id) as ContentRef[];

    return { record, rows, refs };
  }

  listEntries(schema: string, sort?: ResolvedSortParams): ContentEntryRow[] {
    const resolvedSort = sort ?? { sortField: "id", sortOrder: "desc" };
    const orderClause = this.buildOrderClause(resolvedSort);
    const joinClause = this.buildJoinClause(resolvedSort);

    const records = this.db
      .prepare(
        `SELECT content.id, content.schema, content.schema_version, content.creation_date, content.created_by, content.last_modified_date, content.last_modified_by, (SELECT COUNT(DISTINCT content_id) FROM content_refs WHERE target_content_id = content.id) AS referencer_count FROM content${joinClause} WHERE content.schema = ? ${orderClause}`
      )
      .all(schema) as ContentRecord[];

    if (records.length === 0) return [];

    const ids = records.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");

    const allRows = this.db
      .prepare(
        `SELECT content_id, field_id, value FROM content_rows WHERE content_id IN (${placeholders}) ORDER BY content_id, field_id`
      )
      .all(...ids) as (ContentRow & { content_id: number })[];

    const allRefs = this.db
      .prepare(
        `SELECT content_id, field_id, target_content_id FROM content_refs WHERE content_id IN (${placeholders}) ORDER BY content_id, field_id`
      )
      .all(...ids) as (ContentRef & { content_id: number })[];

    const rowsByContentId = new Map<number, ContentRow[]>();
    for (const row of allRows) {
      const { content_id, ...rest } = row;
      if (!rowsByContentId.has(content_id)) {
        rowsByContentId.set(content_id, []);
      }
      rowsByContentId.get(content_id)!.push(rest);
    }

    const refsByContentId = new Map<number, ContentRef[]>();
    for (const ref of allRefs) {
      const { content_id, ...rest } = ref;
      if (!refsByContentId.has(content_id)) {
        refsByContentId.set(content_id, []);
      }
      refsByContentId.get(content_id)!.push(rest);
    }

    return records.map((record) => ({
      record,
      rows: rowsByContentId.get(record.id) ?? [],
      refs: refsByContentId.get(record.id) ?? [],
    }));
  }

  /**
   * Cursor-based paginated variant of {@link listEntries}.
   * Keyset pagination on the sort column with `content.id` as tiebreak: the
   * cursor is an opaque string encoding the anchor row's (sort value, id).
   * Fetches `limit + 1` rows to detect whether more data exists; the extra
   * probe row is removed before returning.
   */
  listEntriesPaginated(
    schema: string,
    pagination: PaginationParams,
    sort?: ResolvedSortParams
  ): { entries: ContentEntryRow[]; pagination: PaginationResponse } {
    const limit = clampLimit(pagination.limit);
    const direction = pagination.direction === "backward" ? "backward" : "forward";

    const resolvedSort = sort ?? { sortField: "id", sortOrder: "desc" };
    const joinClause = this.buildJoinClause(resolvedSort);
    const col = this.buildSortColumn(resolvedSort);
    const orderClause = this.buildOrderClause(resolvedSort);

    // Decode the cursor. An undecodable cursor, or one that does not match
    // this sort (e.g. a legacy bare-id cursor on a field sort), is treated as
    // "no cursor" / first page — lenient, as before.
    let anchor: DecodedCursor | null = null;
    if (pagination.cursor !== undefined && pagination.cursor !== null) {
      const decoded = parseCursor(pagination.cursor);
      if (decoded !== null && this.cursorMatchesSort(decoded, resolvedSort)) {
        anchor = decoded;
      }
    }

    // The paginated SELECT also returns the sort column's value per row so
    // cursors can be generated from the first/last rows of the page.
    const SELECT =
      "SELECT content.id, content.schema, content.schema_version, content.creation_date, content.created_by, content.last_modified_date, content.last_modified_by, " +
      (typeof resolvedSort.sortField === "number" ? "sort_field.value AS sort_value, " : "") +
      "(SELECT COUNT(DISTINCT content_id) FROM content_refs WHERE target_content_id = content.id) AS referencer_count " +
      "FROM content" +
      joinClause;

    type PageRecord = ContentRecord & { sort_value?: string | null };
    let records: PageRecord[];
    let hasMore = false;

    if (anchor !== null && direction === "backward") {
      // Backward: fetch entries "before" the anchor in display order, using
      // the exact reverse of the display ORDER BY, then reverse to restore
      // display order. The probe row (if any) is last in reverse display
      // order, so it is removed BEFORE reversing.
      const cond = this.buildKeysetCondition(col, resolvedSort, "backward", anchor);
      const reverseOrder = this.buildOrderClause(resolvedSort, true);
      records = this.db
        .prepare(`${SELECT} WHERE content.schema = ? AND ${cond.sql} ${reverseOrder} LIMIT ?`)
        .all(schema, ...cond.params, limit + 1) as PageRecord[];
      hasMore = records.length > limit;
      if (hasMore) records.pop(); // remove the extra probe row
      records.reverse(); // restore display order
    } else if (anchor !== null && direction === "forward") {
      // Forward: fetch entries "after" the anchor in display order.
      const cond = this.buildKeysetCondition(col, resolvedSort, "forward", anchor);
      records = this.db
        .prepare(`${SELECT} WHERE content.schema = ? AND ${cond.sql} ${orderClause} LIMIT ?`)
        .all(schema, ...cond.params, limit + 1) as PageRecord[];
      hasMore = records.length > limit;
      if (hasMore) records.pop(); // remove the extra probe row
    } else {
      records = this.db
        .prepare(`${SELECT} WHERE content.schema = ? ${orderClause} LIMIT ?`)
        .all(schema, limit + 1) as PageRecord[];
      hasMore = records.length > limit;
      if (hasMore) records.pop(); // remove the extra probe row
    }

    if (records.length === 0) {
      return { entries: [], pagination: { nextCursor: null, prevCursor: null } };
    }

    // Batch-fetch rows and refs for the paginated record set.
    const ids = records.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");

    const allRows = this.db
      .prepare(
        `SELECT content_id, field_id, value FROM content_rows WHERE content_id IN (${placeholders}) ORDER BY content_id, field_id`
      )
      .all(...ids) as (ContentRow & { content_id: number })[];

    const allRefs = this.db
      .prepare(
        `SELECT content_id, field_id, target_content_id FROM content_refs WHERE content_id IN (${placeholders}) ORDER BY content_id, field_id`
      )
      .all(...ids) as (ContentRef & { content_id: number })[];

    const rowsByContentId = new Map<number, ContentRow[]>();
    for (const row of allRows) {
      const { content_id, ...rest } = row;
      if (!rowsByContentId.has(content_id)) rowsByContentId.set(content_id, []);
      rowsByContentId.get(content_id)!.push(rest);
    }

    const refsByContentId = new Map<number, ContentRef[]>();
    for (const ref of allRefs) {
      const { content_id, ...rest } = ref;
      if (!refsByContentId.has(content_id)) refsByContentId.set(content_id, []);
      refsByContentId.get(content_id)!.push(rest);
    }

    const entries = records.map((record) => ({
      record,
      rows: rowsByContentId.get(record.id) ?? [],
      refs: refsByContentId.get(record.id) ?? [],
    }));

    // Cursor existence probes agree with the keyset semantics: null exactly
    // when no rows remain in that direction.
    const firstAnchor = this.anchorOf(records[0], resolvedSort);
    const lastAnchor = this.anchorOf(records[records.length - 1], resolvedSort);
    const nextExists =
      direction === "backward"
        ? this.keysetExists(col, resolvedSort, "forward", lastAnchor, schema)
        : hasMore;
    const prevExists =
      anchor !== null && this.keysetExists(col, resolvedSort, "backward", firstAnchor, schema);

    const paginationResult: PaginationResponse = {
      nextCursor: nextExists ? encodeCursor(lastAnchor.value, lastAnchor.id) : null,
      prevCursor: prevExists ? encodeCursor(firstAnchor.value, firstAnchor.id) : null,
    };

    return { entries, pagination: paginationResult };
  }

  entryExistsInSchema(id: number, schema: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM content WHERE id = ? AND schema = ?")
        .get(id, schema) !== undefined
    );
  }

  /**
   * The SQL expression for the sort column, derived once and shared by the
   * ORDER BY clause, the keyset WHERE clause, and cursor value extraction.
   * `nullable` is true only for custom-field sorts (content.id and
   * creation_date are NOT NULL).
   */
  private buildSortColumn(sort: ResolvedSortParams): { expr: string; nullable: boolean } {
    switch (sort.sortField) {
      case "id":
        return { expr: "content.id", nullable: false };
      case "date":
        return { expr: "content.creation_date", nullable: false };
      default: {
        // Field id — value column is TEXT; numbers need CAST
        const valueExpr =
          sort.sortFieldType === "number"
            ? "CAST(sort_field.value AS REAL)"
            : "sort_field.value";
        return { expr: valueExpr, nullable: true };
      }
    }
  }

  /**
   * Tiebreak direction T for `content.id` in display order. Every current sort
   * keeps the universal `id ASC` tiebreak; the "modified" sort (added by
   * PLAN-60) will match the tiebreak to the sort direction — add its case here.
   */
  private tiebreakDirection(sort: ResolvedSortParams): "asc" | "desc" {
    if ((sort.sortField as string) === "modified") return sort.sortOrder;
    return "asc";
  }

  /**
   * Build the ORDER BY clause for display order `(C dir, content.id T)`, or
   * its exact reverse when `reversed` (used by backward fetches before the
   * result is re-reversed). Display order places NULLs last in both
   * directions; the reverse places them first.
   */
  private buildOrderClause(sort: ResolvedSortParams, reversed = false): string {
    const col = this.buildSortColumn(sort);
    const dir = sort.sortOrder.toUpperCase();
    const revDir = dir === "ASC" ? "DESC" : "ASC";
    const T = this.tiebreakDirection(sort);
    const idDir = (reversed ? (T === "asc" ? "desc" : "asc") : T).toUpperCase();

    if (sort.sortField === "id") {
      return `ORDER BY content.id ${reversed ? revDir : dir}`;
    }
    const nulls = reversed ? "NULLS FIRST" : "NULLS LAST";
    return `ORDER BY ${col.expr} ${reversed ? revDir : dir} ${nulls}, content.id ${idDir}`;
  }

  /**
   * Keyset condition selecting the rows strictly after (forward) or before
   * (backward) the anchor `(value, id)` in display order
   * `(C dir, content.id T)`. NULL sort values always sort last in display
   * order, so:
   * - forward from a non-NULL anchor also includes every NULL row;
   * - backward from a non-NULL anchor never includes NULL rows;
   * - a NULL anchor compares only against other NULL rows via the id tiebreak.
   */
  private buildKeysetCondition(
    col: { expr: string; nullable: boolean },
    sort: ResolvedSortParams,
    direction: "forward" | "backward",
    anchor: DecodedCursor
  ): { sql: string; params: unknown[] } {
    const C = col.expr;
    const T = this.tiebreakDirection(sort);
    const tie = T === "asc" ? "content.id > ?" : "content.id < ?";
    const tieRev = T === "asc" ? "content.id < ?" : "content.id > ?";

    if (anchor.value === null) {
      // The anchor row itself has a NULL sort value.
      const sql =
        direction === "forward"
          ? `(${C} IS NULL AND ${tie})`
          : `((${C} IS NOT NULL) OR (${C} IS NULL AND ${tieRev}))`;
      return { sql, params: [anchor.id] };
    }

    const cmp = sort.sortOrder === "asc" ? ">" : "<";
    const cmpRev = sort.sortOrder === "asc" ? "<" : ">";
    if (direction === "forward") {
      // Every NULL row comes after any non-NULL row in display order.
      const nullTerm = col.nullable ? ` OR ${C} IS NULL` : "";
      return {
        sql: `((${C} ${cmp} ?) OR (${C} = ? AND ${tie})${nullTerm})`,
        params: [anchor.value, anchor.value, anchor.id],
      };
    }
    // Backward from a non-NULL anchor: NULL rows sort after it, so they are
    // never "before" it (SQL's NULL comparisons would exclude them anyway).
    return {
      sql: `((${C} ${cmpRev} ?) OR (${C} = ? AND ${tieRev}))`,
      params: [anchor.value, anchor.value, anchor.id],
    };
  }

  /**
   * Whether a decoded cursor is usable as an anchor for this sort. Legacy
   * bare-id cursors are valid only for id sorts; any other mismatch (e.g. a
   * string value on a number-field sort) falls back to the first page.
   */
  private cursorMatchesSort(cursor: DecodedCursor, sort: ResolvedSortParams): boolean {
    if (cursor.legacy) return sort.sortField === "id";
    switch (sort.sortField) {
      case "id":
        return typeof cursor.value === "number";
      case "date":
        return typeof cursor.value === "string";
      default:
        return sort.sortFieldType === "number"
          ? cursor.value === null || typeof cursor.value === "number"
          : cursor.value === null || typeof cursor.value === "string";
    }
  }

  /** Extract the cursor anchor (sort value, id) from a page row. */
  private anchorOf(
    record: ContentRecord & { sort_value?: string | null },
    sort: ResolvedSortParams
  ): DecodedCursor {
    const id = record.id;
    switch (sort.sortField) {
      case "id":
        return { value: id, id, legacy: false };
      case "date":
        return { value: record.creation_date, id, legacy: false };
      default: {
        const raw = record.sort_value ?? null;
        const value =
          sort.sortFieldType === "number" && raw !== null ? Number(raw) : raw;
        return { value, id, legacy: false };
      }
    }
  }

  /** Keyset-semantics existence probe: is there any row in that direction? */
  private keysetExists(
    col: { expr: string; nullable: boolean },
    sort: ResolvedSortParams,
    direction: "forward" | "backward",
    anchor: DecodedCursor,
    schema: string
  ): boolean {
    const cond = this.buildKeysetCondition(col, sort, direction, anchor);
    const row = this.db
      .prepare(
        `SELECT 1 FROM content${this.buildJoinClause(sort)} WHERE content.schema = ? AND ${cond.sql} LIMIT 1`
      )
      .get(schema, ...cond.params);
    return row !== undefined;
  }

  /** Build a LEFT JOIN clause for field-based sorting; empty for id/date sorts. */
  private buildJoinClause(sort: ResolvedSortParams): string {
    if (typeof sort.sortField !== "number") return "";
    return ` LEFT JOIN content_rows AS sort_field ON sort_field.content_id = content.id AND sort_field.field_id = ${Number(sort.sortField)}`;
  }
}
