import type { Db } from "../db/database";

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

  listEntries(schema: string): ContentEntryRow[] {
    const records = this.db
      .prepare(
        "SELECT id, schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by, (SELECT COUNT(DISTINCT content_id) FROM content_refs WHERE target_content_id = content.id) AS referencer_count FROM content WHERE schema = ? ORDER BY id"
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

  entryExistsInSchema(id: number, schema: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM content WHERE id = ? AND schema = ?")
        .get(id, schema) !== undefined
    );
  }
}
