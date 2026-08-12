import type { Db } from "../db/database";
import { ContentRepository, ContentEntryRow } from "../repositories/contentRepo";
import { SchemaRepository } from "../repositories/schemaRepo";
import type {
  FieldInput,
  FieldWithId,
  FieldType,
  SchemaEntry,
  SchemaUpdatePreview,
  SchemaUpdatePreviewEntry,
} from "../types";

const VALID_TYPES: Set<FieldType> = new Set([
  "text",
  "number",
  "boolean",
  "date",
  "schema-ref",
]);

export class SchemaServiceError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export class SchemaService {
  private repo: SchemaRepository;
  private contentRepo: ContentRepository;
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.repo = new SchemaRepository(db);
    this.contentRepo = new ContentRepository(db);
  }

  create(
    name: string,
    fields: FieldInput[],
    createdBy: string
  ): SchemaEntry {
    // R8: zero fields → 422
    if (fields.length === 0) {
      throw new SchemaServiceError(422, "Schema must have at least one field");
    }

    // R8: empty/whitespace-only field label → 422
    for (const f of fields) {
      if (f.label.trim() === "") {
        throw new SchemaServiceError(
          422,
          "Field label must be non-empty"
        );
      }
    }

    // R8: at least one required field → 422
    if (!fields.some((f) => f.required)) {
      throw new SchemaServiceError(
        422,
        "Schema must have at least one required field"
      );
    }

    // R8: duplicate labels → 422
    const labels = new Set<string>();
    for (const f of fields) {
      if (labels.has(f.label)) {
        throw new SchemaServiceError(
          422,
          `Duplicate field label: ${f.label}`
        );
      }
      labels.add(f.label);
    }

    // R9: invalid type → 422
    for (const f of fields) {
      if (!VALID_TYPES.has(f.type as FieldType)) {
        throw new SchemaServiceError(
          422,
          `Invalid field type: ${f.type}`
        );
      }

      // R9: schema-ref requires valid ref_schema
      if (f.type === "schema-ref") {
        if (!f.ref_schema) {
          throw new SchemaServiceError(
            422,
            `schema-ref field '${f.label}' requires ref_schema`
          );
        }
        if (!this.repo.schemaExists(f.ref_schema)) {
          throw new SchemaServiceError(
            422,
            `ref_schema '${f.ref_schema}' does not exist`
          );
        }
      }
    }

    // R10: circular reference check (including self-reference)
    this.checkCycle(name, fields);

    // R8: duplicate name → 409; R11: version=1, compat_version=1.
    // Check and write run inside one transaction so a concurrent creator cannot
    // interleave between them (both the row insert and any rolled-back write
    // are atomic).
    this.db.transaction(() => {
      if (this.repo.schemaExists(name)) {
        throw new SchemaServiceError(409, `Schema '${name}' already exists`);
      }

      this.repo.insertSchema(name, fields, createdBy);
    })();

    return this.repo.getSchema(name)!;
  }

  update(
    name: string,
    fields: (FieldInput & { id?: number })[],
    modifiedBy: string
  ): SchemaEntry {
    const {
      newVersion,
      compatVersion,
      deletedFieldIds,
      retargetedFieldIds,
      unaffectedEntryIds,
    } = this.validateAndComputeUpdate(name, fields);

    this.repo.updateSchemaFields(
      name,
      fields,
      newVersion,
      compatVersion,
      modifiedBy,
      deletedFieldIds,
      retargetedFieldIds,
      unaffectedEntryIds
    );

    return this.repo.getSchema(name)!;
  }

  /**
   * Read-only dry-run of `update()`. Runs the exact same validation,
   * breaking-detection, and deleted/retargeted id computation as a real PATCH,
   * then reports which existing entries would have their stored data disturbed
   * — without writing anything.
   */
  previewUpdate(
    name: string,
    fields: (FieldInput & { id?: number })[]
  ): SchemaUpdatePreview {
    const {
      existing,
      newVersion,
      isBreaking,
      compatVersion,
      deletedFieldIds,
      retargetedFieldIds,
      affectedEntryIds,
    } = this.validateAndComputeUpdate(name, fields);

    const entries = this.contentRepo.listEntries(name);
    const affectedEntries = this.buildPreviewEntries(
      existing,
      fields,
      entries,
      deletedFieldIds,
      retargetedFieldIds,
      affectedEntryIds
    );

    return {
      breaking: isBreaking,
      version: newVersion,
      compatVersion,
      affectedEntries,
    };
  }

  private validateAndComputeUpdate(
    name: string,
    fields: (FieldInput & { id?: number })[]
  ): {
    existing: SchemaEntry;
    newVersion: number;
    isBreaking: boolean;
    compatVersion: number;
    deletedFieldIds: number[];
    retargetedFieldIds: number[];
    unaffectedEntryIds: number[];
    affectedEntryIds: Set<number>;
  } {
    const existing = this.repo.getSchema(name);
    if (!existing) {
      throw new SchemaServiceError(404, `Schema '${name}' not found`);
    }

    // R8: zero fields → 422
    if (fields.length === 0) {
      throw new SchemaServiceError(422, "Schema must have at least one field");
    }

    // R8: empty/whitespace-only field label → 422
    for (const f of fields) {
      if (f.label.trim() === "") {
        throw new SchemaServiceError(
          422,
          "Field label must be non-empty"
        );
      }
    }

    // R8: at least one required field → 422
    if (!fields.some((f) => f.required)) {
      throw new SchemaServiceError(
        422,
        "Schema must have at least one required field"
      );
    }

    // R8: duplicate labels → 422
    const labels = new Set<string>();
    for (const f of fields) {
      if (labels.has(f.label)) {
        throw new SchemaServiceError(
          422,
          `Duplicate field label: ${f.label}`
        );
      }
      labels.add(f.label);
    }

    // Validate field types and ref_schema
    for (const f of fields) {
      if (!VALID_TYPES.has(f.type as FieldType)) {
        throw new SchemaServiceError(
          422,
          `Invalid field type: ${f.type}`
        );
      }

      if (f.type === "schema-ref") {
        if (!f.ref_schema) {
          throw new SchemaServiceError(
            422,
            `schema-ref field '${f.label}' requires ref_schema`
          );
        }
        if (!this.repo.schemaExists(f.ref_schema)) {
          throw new SchemaServiceError(
            422,
            `ref_schema '${f.ref_schema}' does not exist`
          );
        }
      }
    }

    // R10: cycle check for schema-ref fields (including self-reference)
    this.checkCycle(name, fields);

    // Compute compat_version based on changes (§7 table)
    const newVersion = existing.version + 1;
    const isBreaking = this.computeBreakingChange(existing.fields, fields);
    const compatVersion = isBreaking ? newVersion : existing.compat_version;

    // Determine deleted field IDs for propagation (R21)
    const existingIds = new Set(existing.fields.map((f) => f.id));
    const incomingIds = new Set<number>();
    for (const f of fields) {
      if ("id" in f && typeof f.id === "number") {
        incomingIds.add(f.id);
      }
    }
    const deletedFieldIds: number[] = [];
    for (const id of existingIds) {
      if (!incomingIds.has(id)) {
        deletedFieldIds.push(id);
      }
    }

    // Determine retargeted field IDs (R35): an incoming field that carries an
    // existing id, is a schema-ref on both sides, and changed its ref_schema.
    // Propagating a retarget purges the field's content_refs (no version bump);
    // the entries stay conflicted because the retarget already made
    // compat_version = newVersion above.
    const existingById = new Map(existing.fields.map((f) => [f.id, f]));
    const retargetedFieldIds: number[] = [];
    for (const f of fields) {
      if ("id" in f && typeof f.id === "number") {
        const old = existingById.get(f.id);
        if (
          old &&
          old.type === "schema-ref" &&
          f.type === "schema-ref" &&
          old.ref_schema !== f.ref_schema
        ) {
          retargetedFieldIds.push(f.id);
        }
      }
    }

    const entries = this.contentRepo.listEntries(name);
    const { affectedEntryIds, unaffectedEntryIds } =
      this.computeAffectedAndUnaffected(
        existing,
        fields,
        entries,
        deletedFieldIds,
        retargetedFieldIds,
        existing.compat_version
      );

    return {
      existing,
      newVersion,
      isBreaking,
      compatVersion,
      deletedFieldIds,
      retargetedFieldIds,
      unaffectedEntryIds,
      affectedEntryIds,
    };
  }

  private computeAffectedAndUnaffected(
    existing: SchemaEntry,
    fields: (FieldInput & { id?: number })[],
    entries: ContentEntryRow[],
    deletedFieldIds: number[],
    retargetedFieldIds: number[],
    currentCompatVersion: number
  ): {
    affectedEntryIds: Set<number>;
    unaffectedEntryIds: number[];
  } {
    const affectedEntryIds = new Set<number>();
    const unaffectedEntryIds: number[] = [];

    const deletedIds = new Set(deletedFieldIds);
    const retargetedIds = new Set(retargetedFieldIds);
    const incomingById = new Map<number, FieldInput & { id?: number }>();
    let hasNewRequiredField = false;
    for (const f of fields) {
      if (typeof f.id === "number") {
        incomingById.set(f.id, f);
      } else if (f.required) {
        hasNewRequiredField = true;
      }
    }

    for (const entry of entries) {
      const rowsById = new Map<number, unknown>();
      for (const row of entry.rows) {
        rowsById.set(row.field_id, JSON.parse(row.value ?? "null") as unknown);
      }
      const refsById = new Map<number, number>();
      for (const ref of entry.refs) {
        refsById.set(ref.field_id, ref.target_content_id);
      }
      const hasStoredValue = (id: number): boolean =>
        rowsById.has(id) || refsById.has(id);

      let isAffected = false;

      for (const oldField of existing.fields) {
        const id = oldField.id;

        if (deletedIds.has(id)) {
          // Field deleted: affected iff the entry stored anything for it.
          if (hasStoredValue(id)) {
            isAffected = true;
          }
          continue;
        }

        const incoming = incomingById.get(id);
        if (!incoming) continue;

        // Kept field: number→text is lossless (R13/R17) → never affected.
        if (oldField.type === "number" && incoming.type === "text") continue;

        // Kept field, any other type change: affected iff a value is stored.
        if (oldField.type !== incoming.type) {
          if (hasStoredValue(id)) {
            isAffected = true;
          }
          continue;
        }

        // Kept schema-ref field whose ref_schema changed (retarget): affected
        // iff the entry holds a ref for the field.
        if (retargetedIds.has(id)) {
          if (refsById.has(id)) {
            isAffected = true;
          }
          continue;
        }

        // Kept field, type + ref_schema unchanged, optional→required: affected
        // iff the entry has no stored value, or the stored value is invalid
        // under required semantics (the only such case: text `""`).
        if (!oldField.required && incoming.required) {
          if (!hasStoredValue(id) || rowsById.get(id) === "") {
            isAffected = true;
          }
          continue;
        }

        // Everything else (required→optional, label rename, reorder): never
        // affected.
      }

      if (hasNewRequiredField) isAffected = true;

      if (isAffected) {
        affectedEntryIds.add(entry.record.id);
      } else {
        // Entry is unaffected by the current changes. But if it was previously
        // conflicted (schema_version < compat_version), preserve its conflict
        // state — do not bump its schema_version.
        if (entry.record.schema_version < currentCompatVersion) {
          // Previously conflicted — keep it conflicted.
          affectedEntryIds.add(entry.record.id);
        } else {
          unaffectedEntryIds.push(entry.record.id);
        }
      }
    }

    return { affectedEntryIds, unaffectedEntryIds };
  }

  delete(name: string): void {
    // R22 succeeds + delete run inside one database transaction so a concurrent
    // referencer cannot interleave between the check and the delete.
    this.db.transaction(() => {
      // R22: check if another schema references this one
      const referencingSchemas = this.repo.getSchemasReferencing(name);
      if (referencingSchemas.length > 0) {
        throw new SchemaServiceError(
          409,
          `Cannot delete schema '${name}': referenced by schema(s): ${referencingSchemas.join(", ")}`,
          { referencingSchemas }
        );
      }

      const existing = this.repo.getSchema(name);
      if (!existing) {
        throw new SchemaServiceError(404, `Schema '${name}' not found`);
      }

      this.repo.deleteSchema(name);
    })();
  }

  get(name: string): SchemaEntry | null {
    return this.repo.getSchema(name);
  }

  list(): SchemaEntry[] {
    const entries = this.repo.listSchemas();
    const result: SchemaEntry[] = [];
    for (const entry of entries) {
      const schema = this.repo.getSchema(entry.name);
      if (schema) result.push(schema);
    }
    return result;
  }

  private checkCycle(
    targetSchema: string,
    fields: FieldInput[]
  ): void {
    // Build the graph including the pending changes
    const graph = this.repo.getRefGraph();

    // Add the pending schema's refs to the graph
    const pendingRefs: string[] = [];
    for (const f of fields) {
      if (f.type === "schema-ref" && f.ref_schema) {
        pendingRefs.push(f.ref_schema);
      }
    }

    // Check if following refs from targetSchema leads back to targetSchema
    const visited = new Set<string>();
    const stack = [...pendingRefs];

    while (stack.length > 0) {
      const current = stack.pop()!;

      // Self-reference check: the schema references itself
      if (current === targetSchema) {
        throw new SchemaServiceError(
          422,
          `Circular schema reference detected involving '${targetSchema}'`
        );
      }

      if (visited.has(current)) continue;
      visited.add(current);

      const nextRefs = graph.get(current) || [];
      for (const ref of nextRefs) {
        if (ref === targetSchema) {
          throw new SchemaServiceError(
            422,
            `Circular schema reference detected involving '${targetSchema}'`
          );
        }
        stack.push(ref);
      }
    }
  }

  private computeBreakingChange(
    oldFields: FieldWithId[],
    newFields: (FieldInput & { id?: number })[]
  ): boolean {
    const oldMap = new Map<number, FieldWithId>();
    for (const f of oldFields) {
      oldMap.set(f.id, f);
    }

    const newIds = new Set<number>();
    for (const f of newFields) {
      if ("id" in f && typeof f.id === "number") {
        newIds.add(f.id);
      }
    }

    // Check for deleted fields → breaking (R14)
    for (const id of oldMap.keys()) {
      if (!newIds.has(id)) {
        return true; // delete field = breaking
      }
    }

    // Check each field change
    for (const f of newFields) {
      if ("id" in f && typeof f.id === "number") {
        const old = oldMap.get(f.id);
        if (old) {
          // Existing field changed
          const breaking = this.isFieldChangeBreaking(old, f as FieldWithId);
          if (breaking) return true;
        }
      } else {
        // New field: adding required is breaking (R14)
        if (f.required) {
          return true;
        }
      }
    }

    return false;
  }

  private isFieldChangeBreaking(
    old: FieldWithId,
    newField: FieldWithId
  ): boolean {
    // R13: non-breaking changes:
    // - number→text (type change)
    // - required→optional
    // - rename label / reorder

    // R14: breaking changes:
    // - text→number, optional→required
    // - into/out of boolean, date, schema-ref
    // - ref target change

    const typeChanged = old.type !== newField.type;
    const requiredChanged = old.required !== newField.required;

    if (typeChanged) {
      // number→text is non-breaking (R13)
      if (old.type === "number" && newField.type === "text") {
        return false;
      }
      // Any other type change is breaking (R14)
      return true;
    }

    if (requiredChanged) {
      // required→optional is non-breaking (R13)
      if (old.required && !newField.required) {
        return false;
      }
      // optional→required is breaking (R14)
      return true;
    }

    // ref_schema change for schema-ref fields is breaking (R14)
    if (
      old.type === "schema-ref" &&
      newField.type === "schema-ref" &&
      old.ref_schema !== newField.ref_schema
    ) {
      return true;
    }

    // label rename / reorder are non-breaking (R13)
    return false;
  }

  /**
   * Build preview entries from the classification result. Re-iterates entries
   * to compute per-entry affectedFieldIds and labels for the preview response.
   */
  private buildPreviewEntries(
    existing: SchemaEntry,
    fields: (FieldInput & { id?: number })[],
    entries: ContentEntryRow[],
    deletedFieldIds: number[],
    retargetedFieldIds: number[],
    affectedEntryIds: Set<number>
  ): SchemaUpdatePreviewEntry[] {
    const deletedIds = new Set(deletedFieldIds);
    const retargetedIds = new Set(retargetedFieldIds);
    const incomingById = new Map<number, FieldInput & { id?: number }>();
    let hasNewRequiredField = false;
    for (const f of fields) {
      if (typeof f.id === "number") {
        incomingById.set(f.id, f);
      } else if (f.required) {
        hasNewRequiredField = true;
      }
    }

    // Label convention (client `schemaLabelField`): first required field by
    // sort_order; fall back to the first field. R8 guarantees a required
    // field exists, so the fallback is defensive only.
    const labelFieldId =
      existing.fields.find((f) => f.required)?.id ??
      existing.fields[0]?.id ??
      null;

    const affectedEntries: SchemaUpdatePreviewEntry[] = [];
    for (const entry of entries) {
      if (!affectedEntryIds.has(entry.record.id)) continue;

      const rowsById = new Map<number, unknown>();
      for (const row of entry.rows) {
        rowsById.set(row.field_id, JSON.parse(row.value ?? "null") as unknown);
      }
      const refsById = new Map<number, number>();
      for (const ref of entry.refs) {
        refsById.set(ref.field_id, ref.target_content_id);
      }
      const hasStoredValue = (id: number): boolean =>
        rowsById.has(id) || refsById.has(id);

      const affectedFieldIds = new Set<number>();

      for (const oldField of existing.fields) {
        const id = oldField.id;

        if (deletedIds.has(id)) {
          if (hasStoredValue(id)) affectedFieldIds.add(id);
          continue;
        }

        const incoming = incomingById.get(id);
        if (!incoming) continue;

        if (oldField.type === "number" && incoming.type === "text") continue;

        if (oldField.type !== incoming.type) {
          if (hasStoredValue(id)) affectedFieldIds.add(id);
          continue;
        }

        if (retargetedIds.has(id)) {
          if (refsById.has(id)) affectedFieldIds.add(id);
          continue;
        }

        if (!oldField.required && incoming.required) {
          if (!hasStoredValue(id) || rowsById.get(id) === "") {
            affectedFieldIds.add(id);
          }
          continue;
        }
      }

      // hasNewRequiredField entries have no specific field to report
      if (!hasNewRequiredField && affectedFieldIds.size === 0) continue;

      affectedEntries.push({
        id: entry.record.id,
        label: this.computeEntryLabel(entry, labelFieldId, rowsById, refsById),
        affectedFieldIds: [...affectedFieldIds],
      });
    }

    return affectedEntries;
  }

  private computeEntryLabel(
    entry: ContentEntryRow,
    labelFieldId: number | null,
    rowsById: Map<number, unknown>,
    refsById: Map<number, number>
  ): string {
    if (labelFieldId != null) {
      const row = rowsById.get(labelFieldId);
      if (row !== undefined) {
        const text = String(row);
        if (text !== "") return text;
      }
      const ref = refsById.get(labelFieldId);
      if (ref !== undefined) {
        const text = String(ref);
        if (text !== "") return text;
      }
    }
    return `Entry #${entry.record.id}`;
  }
}
