import type { Db } from "../db/database";
import { SchemaRepository } from "../repositories/schemaRepo";
import type { FieldInput, FieldWithId, FieldType, SchemaEntry } from "../types";

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
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.repo = new SchemaRepository(db);
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

    this.repo.updateSchemaFields(
      name,
      fields,
      newVersion,
      compatVersion,
      modifiedBy,
      deletedFieldIds
    );

    return this.repo.getSchema(name)!;
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
}
