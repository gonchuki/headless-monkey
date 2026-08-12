import type { Db } from "../db/database";
import type { FieldInput, FieldWithId, SchemaEntry, SchemaListEntry } from "../types";

export class SchemaRepository {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  insertSchema(name: string, fields: FieldInput[], createdBy: string): void {
    const now = new Date().toISOString();
    const insertSchema = this.db.prepare(
      "INSERT INTO schemas (name, creation_date, created_by, last_modified_date, last_modified_by, version, compat_version) VALUES (?, ?, ?, ?, ?, 1, 1)"
    );

    const insertField = this.db.prepare(
      "INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
    );

    const tx = this.db.transaction(() => {
      insertSchema.run(name, now, createdBy, now, createdBy);
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        insertField.run(
          name,
          f.label,
          f.type,
          f.required ? 1 : 0,
          f.ref_schema ?? null,
          i
        );
      }
    });

    tx();
  }

  getSchema(name: string): SchemaEntry | null {
    const row = this.db
      .prepare(
        "SELECT name, version, compat_version, creation_date, created_by, last_modified_date, last_modified_by FROM schemas WHERE name = ?"
      )
      .get(name) as
        | {
            name: string;
            version: number;
            compat_version: number;
            creation_date: string;
            created_by: string;
            last_modified_date: string;
            last_modified_by: string;
          }
        | undefined;

    if (!row) return null;

    const rawFields = this.db
      .prepare(
        "SELECT id, label, type, required, ref_schema, sort_order FROM schema_fields WHERE schema = ? ORDER BY sort_order"
      )
      .all(name) as Array<{
        id: number;
        label: string;
        type: string;
        required: number;
        ref_schema: string | null;
        sort_order: number;
      }>;

    const fields: FieldWithId[] = rawFields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type as FieldInput["type"],
      required: Boolean(f.required),
      ref_schema: f.ref_schema ?? undefined,
      sort_order: f.sort_order,
    }));

    return {
      name: row.name,
      version: row.version,
      compat_version: row.compat_version,
      creation_date: row.creation_date,
      created_by: row.created_by,
      last_modified_date: row.last_modified_date,
      last_modified_by: row.last_modified_by,
      fields,
    };
  }

  listSchemas(): SchemaListEntry[] {
    return this.db.prepare(
      "SELECT s.name, s.version, s.compat_version, (SELECT COUNT(*) FROM schema_fields sf WHERE sf.schema = s.name) as field_count, (SELECT COUNT(*) FROM content c WHERE c.schema = s.name) as entry_count FROM schemas s ORDER BY s.name"
    ).all() as SchemaListEntry[];
  }

  schemaExists(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM schemas WHERE name = ?").get(name) !== undefined;
  }

  getFields(schemaName: string): FieldWithId[] {
    const rawFields = this.db
      .prepare(
        "SELECT id, label, type, required, ref_schema, sort_order FROM schema_fields WHERE schema = ? ORDER BY sort_order"
      )
      .all(schemaName) as Array<{
        id: number;
        label: string;
        type: string;
        required: number;
        ref_schema: string | null;
        sort_order: number;
      }>;

    return rawFields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type as FieldInput["type"],
      required: Boolean(f.required),
      ref_schema: f.ref_schema ?? undefined,
      sort_order: f.sort_order,
    }));
  }

  updateSchemaFields(
    schemaName: string,
    newFields: (FieldWithId | Omit<FieldInput, "id">)[],
    version: number,
    compatVersion: number,
    modifiedBy: string,
    _deletedFieldIds: number[],
    retargetedFieldIds: number[],
    unaffectedEntryIds: number[]
  ): void {
    const now = new Date().toISOString();

    // R35: purge content_refs for schema-ref fields whose ref_schema changed.
    // Scoped to this schema's entries, and runs BEFORE the deleted-fields block
    // so a mid-edit state never exposes stale targets. No schema_version bump
    // here: the retarget is already breaking (compat_version above), so the
    // entries must stay conflicted until an editor re-selects a target.
    if (retargetedFieldIds.length > 0) {
      const placeholders = retargetedFieldIds.map(() => "?").join(", ");
      this.db
        .prepare(
          `DELETE FROM content_refs WHERE field_id IN (${placeholders}) AND content_id IN (SELECT id FROM content WHERE schema = ?)`
        )
        .run(...retargetedFieldIds, schemaName);
    }

    // Selective schema_version bump: only bump entries that are compatible with
    // the new schema shape. Entries not in this set fall behind compat_version
    // and become conflicted naturally. This replaces the blanket R21 bump.
    // Gated on no retargets (R35): a mixed PATCH must not un-conflict entries
    // that still miss a valid target for the retargeted field.
    if (
      unaffectedEntryIds.length > 0 &&
      retargetedFieldIds.length === 0
    ) {
      const placeholders = unaffectedEntryIds.map(() => "?").join(", ");
      this.db
        .prepare(
          `UPDATE content SET schema_version = ? WHERE id IN (${placeholders})`
        )
        .run(version, ...unaffectedEntryIds);
    }

    const deleteField = this.db.prepare(
      "DELETE FROM schema_fields WHERE id = ? AND schema = ?"
    );
    const updateField = this.db.prepare(
      "UPDATE schema_fields SET label = ?, type = ?, required = ?, ref_schema = ?, sort_order = ? WHERE id = ?"
    );
    const insertField = this.db.prepare(
      "INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
    );

    const existingIdsResult = this.db
      .prepare("SELECT id FROM schema_fields WHERE schema = ?")
      .all(schemaName) as Array<{ id: number }>;
    const existingIds = new Set(existingIdsResult.map((r) => r.id));

    const incomingIds = new Set<number>();
    for (const f of newFields) {
      if ("id" in f && typeof f.id === "number") {
        incomingIds.add(f.id);
      }
    }

    for (const id of existingIds) {
      if (!incomingIds.has(id)) {
        deleteField.run(id, schemaName);
      }
    }

    for (let i = 0; i < newFields.length; i++) {
      const f = newFields[i];
      const required = f.required ? 1 : 0;
      if ("id" in f && typeof f.id === "number") {
        updateField.run(f.label, f.type, required, f.ref_schema ?? null, i, f.id);
      } else {
        insertField.run(
          schemaName,
          f.label,
          f.type,
          required,
          f.ref_schema ?? null,
          i
        );
      }
    }

    this.db
      .prepare(
        "UPDATE schemas SET version = ?, compat_version = ?, last_modified_date = ?, last_modified_by = ? WHERE name = ?"
      )
      .run(version, compatVersion, now, modifiedBy, schemaName);
  }

  deleteSchema(schemaName: string): void {
    // Single DELETE: the DDL cascade chain removes the schema's fields,
    // content, and their content_rows/content_refs.
    this.db.prepare("DELETE FROM schemas WHERE name = ?").run(schemaName);
  }

  getSchemasReferencing(schemaName: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT sf.schema FROM schema_fields sf WHERE sf.type = 'schema-ref' AND sf.ref_schema = ?"
      )
      .all(schemaName) as Array<{ schema: string }>;

    return rows.map((r) => r.schema);
  }

  getRefGraph(): Map<string, string[]> {
    const refs = this.db
      .prepare(
        "SELECT schema, ref_schema FROM schema_fields WHERE type = 'schema-ref' AND ref_schema IS NOT NULL"
      )
      .all() as Array<{ schema: string; ref_schema: string }>;

    const graph = new Map<string, string[]>();
    for (const r of refs) {
      if (!graph.has(r.schema)) graph.set(r.schema, []);
      graph.get(r.schema)!.push(r.ref_schema);
    }
    return graph;
  }
}
