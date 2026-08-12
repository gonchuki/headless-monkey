import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDatabase } from "../src/db/database";
import { SchemaService, SchemaServiceError } from "../src/services/schemaService";
import { SchemaRepository } from "../src/repositories/schemaRepo";
import {
  ContentService,
  ContentServiceError,
} from "../src/services/contentService";

function createService() {
  const db = openDatabase();
  return new SchemaService(db);
}

describe("SchemaService", () => {
  describe("create", () => {
    it("creates a schema with fields (R11)", () => {
      const service = createService();
      const schema = service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "year", type: "number", required: false },
      ], "editor1");

      expect(schema.name).toBe("car");
      expect(schema.version).toBe(1);
      expect(schema.compat_version).toBe(1);
      expect(schema.fields.length).toBe(2);
      expect(schema.created_by).toBe("editor1");
    });

    it("rejects zero fields (R8)", () => {
      const service = createService();
      expect(() => service.create("empty", [], "editor1")).toThrow(
        SchemaServiceError
      );
    });

    it("rejects duplicate field labels (R8)", () => {
      const service = createService();
      expect(() =>
        service.create("dup", [
          { label: "x", type: "text", required: true },
          { label: "x", type: "number", required: false },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("rejects invalid field type (R9)", () => {
      const service = createService();
      expect(() =>
        service.create("bad", [
          { label: "x", type: "invalid" as any, required: true },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("rejects schema-ref without ref_schema (R9)", () => {
      const service = createService();
      expect(() =>
        service.create("bad", [
          { label: "owner", type: "schema-ref", required: true },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("rejects schema-ref with non-existent ref_schema (R9)", () => {
      const service = createService();
      expect(() =>
        service.create("bad", [
          { label: "owner", type: "schema-ref", required: true, ref_schema: "nonexistent" },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("rejects duplicate schema name (R8)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");
      expect(() =>
        service.create("car", [
          { label: "model", type: "text", required: true },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("rejects whitespace-only field label (R8)", () => {
      const service = createService();
      expect(() =>
        service.create("bad", [
          { label: "   ", type: "text", required: true },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("rejects schema with no required field (R8)", () => {
      const service = createService();
      expect(() =>
        service.create("bad", [
          { label: "make", type: "text", required: false },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("rejects self-referential schema-ref (R10)", () => {
      const service = createService();
      service.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");

      expect(() =>
        service.create("car", [
          { label: "owner", type: "schema-ref", required: true, ref_schema: "car" },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("rejects transitive cycle (R10)", () => {
      const service = createService();
      service.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      service.create("garage", [
        { label: "owner", type: "schema-ref", required: true, ref_schema: "person" },
      ], "editor1");

      // car → garage → person → car would be a cycle if we add person → car
      // But let's test: create car with ref to garage, then try to update person to ref car
      service.create("car", [
        { label: "garage_ref", type: "schema-ref", required: false, ref_schema: "garage" },
        { label: "name", type: "text", required: true },
      ], "editor1");

      // Now try updating person to reference car → cycle: person→car→garage→person
      expect(() =>
        service.update("person", [
          { id: 1, label: "name", type: "text", required: true },
          { label: "my_car", type: "schema-ref", required: false, ref_schema: "car" },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("rejects mutual two-schema cycle (R10)", () => {
      const service = createService();
      service.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");

      // car references person, then try to update person to reference car
      service.create("car", [
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
        { label: "name", type: "text", required: true },
      ], "editor1");

      expect(() =>
        service.update("person", [
          { id: 1, label: "name", type: "text", required: true },
          { label: "my_car", type: "schema-ref", required: false, ref_schema: "car" },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });
  });

  describe("update", () => {
    it("rejects zero fields on update (R8)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      expect(() => service.update("car", [], "editor1")).toThrow(
        SchemaServiceError
      );
    });

    it("rejects whitespace-only field label on update (R8)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      expect(() =>
        service.update("car", [
          { id: 1, label: "  ", type: "text", required: true },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("rejects update leaving no required field (R8)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: true },
      ], "editor1");

      expect(() =>
        service.update("car", [
          { id: 1, label: "make", type: "text", required: false },
          { id: 2, label: "color", type: "text", required: false },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("rejects duplicate field labels on update (R8)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      // Rename color → make: labels collide after the rename
      expect(() =>
        service.update("car", [
          { id: 1, label: "make", type: "text", required: true },
          { id: 2, label: "make", type: "text", required: false },
        ], "editor1")
      ).toThrow(SchemaServiceError);
    });

    it("increments version on every update (R12)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      let schema = service.update("car", [
        { id: 1, label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");
      expect(schema.version).toBe(2);

      schema = service.update("car", [
        { id: 1, label: "make", type: "text", required: true },
        { id: 2, label: "color", type: "text", required: false },
        { label: "year", type: "number", required: false },
      ], "editor1");
      expect(schema.version).toBe(3);
    });

    it("keeps compat_version unchanged for add optional field (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(1); // unchanged
    });

    it("keeps compat_version unchanged for number→text (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "year", type: "number", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "year", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(1); // unchanged
    });

    it("keeps compat_version unchanged for required→optional (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "make", type: "text", required: false },
        { id: 2, label: "color", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(1); // unchanged
    });

    it("keeps compat_version unchanged for rename label (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "manufacturer", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(1); // unchanged
    });

    it("keeps compat_version unchanged for reorder (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "year", type: "number", required: false },
      ], "editor1");

      const schema = service.update("car", [
        { id: 2, label: "year", type: "number", required: false },
        { id: 1, label: "make", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(1); // unchanged
    });

    it("sets compat_version = version for add required field (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "make", type: "text", required: true },
        { label: "vin", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(2); // = new version
    });

    it("sets compat_version = version for delete field (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "make", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(2); // = new version
    });

    it("sets compat_version = version for text→number (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "year", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "year", type: "number", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(2); // = new version
    });

    it("sets compat_version = version for optional→required (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "color", type: "text", required: false },
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "color", type: "text", required: true },
        { id: 2, label: "make", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(2); // = new version
    });

    it("sets compat_version = version for into boolean (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "active", type: "text", required: false },
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "active", type: "boolean", required: false },
        { id: 2, label: "make", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(2); // = new version
    });

    it("sets compat_version = version for into date (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "built", type: "text", required: false },
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "built", type: "date", required: false },
        { id: 2, label: "make", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(2); // = new version
    });

    it("sets compat_version = version for into schema-ref (§7)", () => {
      const service = createService();
      service.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      service.create("car", [
        { label: "owner_name", type: "text", required: false },
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "owner_name", type: "schema-ref", required: false, ref_schema: "person" },
        { id: 2, label: "make", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(2); // = new version
    });

    it("sets compat_version = version for out of boolean (§7)", () => {
      const service = createService();
      service.create("car", [
        { label: "active", type: "boolean", required: false },
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "active", type: "text", required: false },
        { id: 2, label: "make", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(2); // = new version
    });

    it("sets compat_version = version for ref_schema target change (§7)", () => {
      const service = createService();
      service.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      service.create("company", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      service.create("car", [
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "owner", type: "schema-ref", required: false, ref_schema: "company" },
        { id: 2, label: "make", type: "text", required: true },
      ], "editor1");
      expect(schema.version).toBe(2);
      expect(schema.compat_version).toBe(2); // = new version
    });

    it("selective bump: text→number on optional field bumps only entries without stored values", () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const contentService = new ContentService(db);

      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "year", type: "text", required: false },
      ], "editor1");

      const schema = schemaService.get("car")!;
      const makeField = schema.fields.find((f) => f.label === "make")!;
      const yearField = schema.fields.find((f) => f.label === "year")!;

      // Entry A: has a text value for the year field → affected by type change
      const entryA = contentService.create(
        "car",
        { [String(makeField.id)]: "Toyota", [String(yearField.id)]: "2020" },
        "editor1"
      );

      // Entry B: no value for the year field → unaffected
      const entryB = contentService.create(
        "car",
        { [String(makeField.id)]: "Honda" },
        "editor1"
      );

      // Change year from text to number (breaking)
      schemaService.update("car", [
        { id: makeField.id, label: "make", type: "text", required: true },
        { id: yearField.id, label: "year", type: "number", required: false },
      ], "editor1");

      // Entry A had a stored text value → conflicted (not bumped)
      const entryAAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryA.id) as { schema_version: number };
      expect(entryAAfter.schema_version).toBe(1);

      // Entry B had no stored value → compatible (bumped)
      const entryBAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryB.id) as { schema_version: number };
      expect(entryBAfter.schema_version).toBe(2);

      // Verify via listForSchema
      const listed = contentService.listForSchema("car");
      expect(listed.find((e) => e.id === entryA.id)?.conflict).toBe(true);
      expect(listed.find((e) => e.id === entryB.id)?.conflict).toBe(false);
    });

    it("selective bump: optional→required bumps only entries with valid values", () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const contentService = new ContentService(db);

      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      const schema = schemaService.get("car")!;
      const makeField = schema.fields.find((f) => f.label === "make")!;
      const colorField = schema.fields.find((f) => f.label === "color")!;

      // Entry A: has a value for the color field → unaffected (already complies)
      const entryA = contentService.create(
        "car",
        { [String(makeField.id)]: "Toyota", [String(colorField.id)]: "Red" },
        "editor1"
      );

      // Entry B: no value for the color field → affected
      const entryB = contentService.create(
        "car",
        { [String(makeField.id)]: "Honda" },
        "editor1"
      );

      // Make color required (breaking)
      schemaService.update("car", [
        { id: makeField.id, label: "make", type: "text", required: true },
        { id: colorField.id, label: "color", type: "text", required: true },
      ], "editor1");

      // Entry A had a valid value → compatible (bumped)
      const entryAAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryA.id) as { schema_version: number };
      expect(entryAAfter.schema_version).toBe(2);

      // Entry B had no value → conflicted (not bumped)
      const entryBAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryB.id) as { schema_version: number };
      expect(entryBAfter.schema_version).toBe(1);

      // Verify via listForSchema
      const listed = contentService.listForSchema("car");
      expect(listed.find((e) => e.id === entryA.id)?.conflict).toBe(false);
      expect(listed.find((e) => e.id === entryB.id)?.conflict).toBe(true);
    });

    it("combined changes: type change + deletion affects all entries with any stored value", () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const contentService = new ContentService(db);

      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
        { label: "year", type: "text", required: false },
      ], "editor1");

      const schema = schemaService.get("car")!;
      const makeField = schema.fields.find((f) => f.label === "make")!;
      const colorField = schema.fields.find((f) => f.label === "color")!;
      const yearField = schema.fields.find((f) => f.label === "year")!;

      // Entry A: has value for year only → affected by type change on year
      const entryA = contentService.create(
        "car",
        { [String(makeField.id)]: "Toyota", [String(yearField.id)]: "2020" },
        "editor1"
      );

      // Entry B: has value for color only → affected by deletion of color
      const entryB = contentService.create(
        "car",
        { [String(makeField.id)]: "Honda", [String(colorField.id)]: "Red" },
        "editor1"
      );

      // Entry C: has values for both → affected by both
      const entryC = contentService.create(
        "car",
        {
          [String(makeField.id)]: "Ford",
          [String(colorField.id)]: "Blue",
          [String(yearField.id)]: "2019",
        },
        "editor1"
      );

      // Change year to number (breaking) AND delete color field (breaking)
      schemaService.update("car", [
        { id: makeField.id, label: "make", type: "text", required: true },
        { id: yearField.id, label: "year", type: "number", required: false },
      ], "editor1");

      // All entries are affected → none should be bumped
      const entryAAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryA.id) as { schema_version: number };
      const entryBAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryB.id) as { schema_version: number };
      const entryCAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryC.id) as { schema_version: number };

      expect(entryAAfter.schema_version).toBe(1);
      expect(entryBAfter.schema_version).toBe(1);
      expect(entryCAfter.schema_version).toBe(1);

      // All should be conflicted
      const listed = contentService.listForSchema("car");
      expect(listed.find((e) => e.id === entryA.id)?.conflict).toBe(true);
      expect(listed.find((e) => e.id === entryB.id)?.conflict).toBe(true);
      expect(listed.find((e) => e.id === entryC.id)?.conflict).toBe(true);
    });

    it("field rename does not change field_id (R15)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.update("car", [
        { id: 1, label: "manufacturer", type: "text", required: true },
      ], "editor1");
      expect(schema.fields[0].id).toBe(1);
      expect(schema.fields[0].label).toBe("manufacturer");
    });

    it("deleting the last field of a schema is allowed", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      // Add another field first, then delete it to leave one
      const schema = service.update("car", [
        { id: 1, label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");
      expect(schema.fields.length).toBe(2);

      // Now delete the color field - this is allowed
      const schema2 = service.update("car", [
        { id: 1, label: "make", type: "text", required: true },
      ], "editor1");
      expect(schema2.fields.length).toBe(1);
    });
  });

  describe("delete", () => {
    it("deletes a schema (R22)", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      expect(() => service.delete("car")).not.toThrow();
      expect(service.get("car")).toBeNull();
    });

    it("blocks deleting referenced schema (R22)", () => {
      const service = createService();
      service.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      service.create("car", [
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
        { label: "name", type: "text", required: true },
      ], "editor1");

      try {
        service.delete("person");
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.statusCode).toBe(409);
        expect(err.message).toContain("car");
      }
    });

    it("deleting referencing schema allows deleting referenced", () => {
      const service = createService();
      service.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      service.create("car", [
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
        { label: "name", type: "text", required: true },
      ], "editor1");

      // Delete car first (the referencing schema)
      service.delete("car");
      // Now person can be deleted
      expect(() => service.delete("person")).not.toThrow();
    });
  });

  describe("interleaving atomicity (check-then-act races)", () => {
    it("create holds duplicate-check + insert in one transaction", () => {
      const db = openDatabase();
      const service = new SchemaService(db);

      // Competitor inserts a full, DDL-valid `car` row at the exact moment the
      // duplicate-name check runs, then lies that the name is free. The
      // duplicate check must pass (`false`) and the following insertSchema
      // must hit the UNIQUE constraint on schemas.name.
      const now = new Date().toISOString();
      const insertCompetitor = db.prepare(
        `INSERT INTO schemas (name, creation_date, created_by, last_modified_date, last_modified_by, version, compat_version)
         VALUES (?, ?, ?, ?, ?, 1, 1)`
      );

      const originalSchemaExists = SchemaRepository.prototype.schemaExists;
      const spy = vi
        .spyOn(SchemaRepository.prototype, "schemaExists")
        .mockImplementation(function (this: SchemaRepository, name: string) {
          if (name === "car") {
            insertCompetitor.run("car", now, "editor1", now, "editor1");
            return false;
          }
          return originalSchemaExists.call(this, name);
        });

      try {
        // Any error is fine — the constraint failure surfaces as a raw
        // SqliteError here, not necessarily a SchemaServiceError.
        expect(() =>
          service.create("car", [
            { label: "make", type: "text", required: true },
          ], "editor1")
        ).toThrow();

        // The transaction was rolled back: the competitor's row must not
        // survive, otherwise a non-wrapped implementation would pass (its
        // injected row autocommits and persists).
        const rows = db
          .prepare(`SELECT name FROM schemas WHERE name = ?`)
          .all("car");
        expect(rows).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it("delete holds R22 referencer check + delete in one transaction", () => {
      const db = openDatabase();
      const service = new SchemaService(db);

      service.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      // car really references person → the real query returns ["car"].
      service.create("car", [
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
        { label: "make", type: "text", required: true },
      ], "editor1");
      // truck must already exist: people the injected schema field references
      // `schemas(name)`, so the truck row has to be there first.
      service.create("truck", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      // The spy returns the real check result (["car"]) so the check still
      // sees car and throws R22 409; by then a competitor has inserted a new
      // `truck` reference. If the check and the delete do not share one
      // transaction, the injected row autocommits and survives.
      const originalGetSchemasReferencing =
        SchemaRepository.prototype.getSchemasReferencing;
      const spy = vi
        .spyOn(SchemaRepository.prototype, "getSchemasReferencing")
        .mockImplementation(function (this: SchemaRepository, schemaName: string) {
          const result = originalGetSchemasReferencing.call(this, schemaName);
          if (schemaName === "person") {
            db.prepare(
              `INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order)
               VALUES (?, ?, ?, ?, ?, ?)`
            ).run("truck", "injected_owner", "schema-ref", 1, "person", 1);
          }
          return result;
        });

      try {
        let thrown: unknown;
        try {
          service.delete("person");
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(SchemaServiceError);
        expect((thrown as SchemaServiceError).statusCode).toBe(409);

        // The injected truck reference was rolled back with the transaction.
        const truckRows = db
          .prepare(
            `SELECT schema FROM schema_fields WHERE schema = 'truck' AND ref_schema = 'person'`
          )
          .all();
        expect(truckRows).toHaveLength(0);

        // The referenced person still exists (nothing was committed).
        expect(service.get("person")).not.toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("field-delete propagation (R21)", () => {
    it("deleting a field removes content_rows and bumps schema_version", () => {
      const db = openDatabase();
      const service = new SchemaService(db);

      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      // Create content entries with both fields
      const dbInsert = db.prepare(
        `INSERT INTO content (schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by) VALUES (?, ?, ?, ?, ?, ?)`
      );
      const insertResult = dbInsert.run("car", 2, new Date().toISOString(), "editor1", new Date().toISOString(), "editor1");
      const entryId1 = insertResult.lastInsertRowid;

      const rowInsert = db.prepare(
        `INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`
      );
      rowInsert.run(entryId1, 1, '"Toyota"'); // make
      rowInsert.run(entryId1, 2, '"Red"'); // color

      // Delete the color field (id=2)
      service.update("car", [
        { id: 1, label: "make", type: "text", required: true },
      ], "editor1");

      // Verify content_rows for field_id=2 are gone
      const remainingRows = db
        .prepare(`SELECT * FROM content_rows WHERE content_id = ?`)
        .all(entryId1);
      expect(remainingRows.length).toBe(1);
      expect((remainingRows[0] as any).field_id).toBe(1);

      // Verify schema_version was bumped
      const entry = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryId1) as { schema_version: number };
      expect(entry.schema_version).toBe(2); // new version after delete
    });

    it("deleting a field bumps only previously-compatible entries (selective R21)", () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const contentService = new ContentService(db);

      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      const schema = schemaService.get("car")!;
      const makeField = schema.fields.find((f) => f.label === "make")!;
      const colorField = schema.fields.find((f) => f.label === "color")!;

      // Entry A: has a value for the color field → affected by deletion
      const entryA = contentService.create(
        "car",
        { [String(makeField.id)]: "Toyota", [String(colorField.id)]: "Red" },
        "editor1"
      );

      // Entry B: no value for the color field → unaffected by deletion
      const entryB = contentService.create(
        "car",
        { [String(makeField.id)]: "Honda" },
        "editor1"
      );

      // Delete the color field
      schemaService.update("car", [
        { id: makeField.id, label: "make", type: "text", required: true },
      ], "editor1");

      // Entry A had a stored value for the deleted field → should be conflicted
      const entryAAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryA.id) as { schema_version: number };
      expect(entryAAfter.schema_version).toBe(1); // not bumped, stays behind

      // Entry B had no stored value → should be compatible (bumped)
      const entryBAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryB.id) as { schema_version: number };
      expect(entryBAfter.schema_version).toBe(2); // bumped to new version

      // Verify via listForSchema
      const listed = contentService.listForSchema("car");
      const aConflict = listed.find((e) => e.id === entryA.id)?.conflict;
      const bConflict = listed.find((e) => e.id === entryB.id)?.conflict;
      expect(aConflict).toBe(true);
      expect(bConflict).toBe(false);
    });

    it("preserves previously-conflicted entries through a field deletion", () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const contentService = new ContentService(db);

      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
        { label: "year", type: "text", required: false },
      ], "editor1");

      const schema = schemaService.get("car")!;
      const makeField = schema.fields.find((f) => f.label === "make")!;
      const colorField = schema.fields.find((f) => f.label === "color")!;
      const yearField = schema.fields.find((f) => f.label === "year")!;

      // Entry A: has values for both optional fields
      const entryA = contentService.create(
        "car",
        {
          [String(makeField.id)]: "Toyota",
          [String(colorField.id)]: "Red",
          [String(yearField.id)]: "2020",
        },
        "editor1"
      );

      // Entry B: no optional values
      const entryB = contentService.create(
        "car",
        { [String(makeField.id)]: "Honda" },
        "editor1"
      );

      // First: make a breaking change that conflicts entry A (text→number on year)
      schemaService.update("car", [
        { id: makeField.id, label: "make", type: "text", required: true },
        { id: colorField.id, label: "color", type: "text", required: false },
        { id: yearField.id, label: "year", type: "number", required: false },
      ], "editor1");

      // Entry A is now conflicted (has text value for a number field)
      let listed = contentService.listForSchema("car");
      expect(listed.find((e) => e.id === entryA.id)?.conflict).toBe(true);
      expect(listed.find((e) => e.id === entryB.id)?.conflict).toBe(false);

      // Second: delete the color field
      schemaService.update("car", [
        { id: makeField.id, label: "make", type: "text", required: true },
        { id: yearField.id, label: "year", type: "number", required: false },
      ], "editor1");

      // Entry A was already conflicted → should stay conflicted (not bumped)
      const entryAAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryA.id) as { schema_version: number };
      expect(entryAAfter.schema_version).toBe(1); // still behind

      // Entry B was compatible → should be bumped to latest version
      const entryBAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryB.id) as { schema_version: number };
      expect(entryBAfter.schema_version).toBe(3); // bumped through both changes

      listed = contentService.listForSchema("car");
      expect(listed.find((e) => e.id === entryA.id)?.conflict).toBe(true);
      expect(listed.find((e) => e.id === entryB.id)?.conflict).toBe(false);
    });
  });

  describe("ref-target retarget purge (R35)", () => {
    it("retargeting a required schema-ref purges refs, does not bump schema_version, and keeps the entry conflicted", () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const contentService = new ContentService(db);

      const person = schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      schemaService.create("company", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      const car = schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ], "editor1");

      // Do not hardcode field ids: updateField is scoped only by field id, not
      // by schema, and the id assignment depends on insertion order.
      const ownerField = car.fields.find((f) => f.label === "owner")!;
      const makeField = car.fields.find((f) => f.label === "make")!;
      const personNameField = person.fields[0];

      const personEntry = contentService.create(
        "person",
        { [String(personNameField.id)]: "Alice" },
        "editor1"
      );
      const carEntry = contentService.create(
        "car",
        { [String(makeField.id)]: "Civic", [String(ownerField.id)]: personEntry.id },
        "editor1"
      );

      // Sanity: the ref row exists before the retarget.
      const refBefore = db
        .prepare("SELECT 1 FROM content_refs WHERE content_id = ? AND field_id = ?")
        .get(carEntry.id, ownerField.id);
      expect(refBefore).toBeDefined();

      // Retarget owner person → company.
      const updated = schemaService.update(
        "car",
        [
          { id: makeField.id, label: "make", type: "text", required: true },
          { id: ownerField.id, label: "owner", type: "schema-ref", required: false, ref_schema: "company" },
        ],
        "editor1"
      );

      // Purge: no content_refs for the owner field of the schema's entries.
      const refAfter = db
        .prepare("SELECT 1 FROM content_refs WHERE content_id = ? AND field_id = ?")
        .get(carEntry.id, ownerField.id);
      expect(refAfter).toBeUndefined();

      // No schema_version bump: the entry keeps its pre-update value.
      const entry = db
        .prepare("SELECT schema_version FROM content WHERE id = ?")
        .get(carEntry.id) as { schema_version: number };
      expect(entry.schema_version).toBe(carEntry.schema_version);

      // The retarget is breaking: compat_version equals the new version.
      expect(updated.version).toBe(2);
      expect(updated.compat_version).toBe(2);

      // Conflict persists → public API excludes the entry / 422s on read.
      expect(contentService.listPublic("car")).toHaveLength(0);
      let caught: unknown;
      try {
        contentService.getPublic("car", carEntry.id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ContentServiceError);
      expect((caught as ContentServiceError).statusCode).toBe(422);
    });

    it("required schema-ref retarget: same purge, no bump, still conflicted", () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const contentService = new ContentService(db);

      const person = schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      schemaService.create("company", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      const car = schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: true, ref_schema: "person" },
      ], "editor1");

      const ownerField = car.fields.find((f) => f.label === "owner")!;
      const makeField = car.fields.find((f) => f.label === "make")!;
      const personNameField = person.fields[0];

      const personEntry = contentService.create(
        "person",
        { [String(personNameField.id)]: "Alice" },
        "editor1"
      );
      const carEntry = contentService.create(
        "car",
        { [String(makeField.id)]: "Civic", [String(ownerField.id)]: personEntry.id },
        "editor1"
      );

      schemaService.update(
        "car",
        [
          { id: makeField.id, label: "make", type: "text", required: true },
          { id: ownerField.id, label: "owner", type: "schema-ref", required: true, ref_schema: "company" },
        ],
        "editor1"
      );

      const refAfter = db
        .prepare("SELECT 1 FROM content_refs WHERE content_id = ? AND field_id = ?")
        .get(carEntry.id, ownerField.id);
      expect(refAfter).toBeUndefined();

      const entry = db
        .prepare("SELECT schema_version FROM content WHERE id = ?")
        .get(carEntry.id) as { schema_version: number };
      expect(entry.schema_version).toBe(carEntry.schema_version);

      expect(contentService.listPublic("car")).toHaveLength(0);
      let caught: unknown;
      try {
        contentService.getPublic("car", carEntry.id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ContentServiceError);
      expect((caught as ContentServiceError).statusCode).toBe(422);
    });

    it("mixed PATCH (delete field + retarget) purges without a schema-wide schema_version bump", () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const contentService = new ContentService(db);

      const person = schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      schemaService.create("company", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      const car = schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ], "editor1");

      const ownerField = car.fields.find((f) => f.label === "owner")!;
      const makeField = car.fields.find((f) => f.label === "make")!;
      const colorField = car.fields.find((f) => f.label === "color")!;
      const personNameField = person.fields[0];

      const personEntry = contentService.create(
        "person",
        { [String(personNameField.id)]: "Alice" },
        "editor1"
      );
      const carEntry = contentService.create(
        "car",
        {
          [String(makeField.id)]: "Civic",
          [String(colorField.id)]: "Red",
          [String(ownerField.id)]: personEntry.id,
        },
        "editor1"
      );

      // One PATCH: delete the color field AND retarget owner person → company.
      const updated = schemaService.update(
        "car",
        [
          { id: makeField.id, label: "make", type: "text", required: true },
          { id: ownerField.id, label: "owner", type: "schema-ref", required: false, ref_schema: "company" },
        ],
        "editor1"
      );

      // The color field is gone and somehow the composite is breaking.
      expect(updated.fields.map((f) => f.label)).not.toContain("color");
      expect(updated.compat_version).toBe(updated.version);

      // The purge still ran for the retargeted field…
      const refAfter = db
        .prepare("SELECT 1 FROM content_refs WHERE content_id = ? AND field_id = ?")
        .get(carEntry.id, ownerField.id);
      expect(refAfter).toBeUndefined();

      // …but the schema-wide R21 bump was gated off: schema_version unchanged.
      const entry = db
        .prepare("SELECT schema_version FROM content WHERE id = ?")
        .get(carEntry.id) as { schema_version: number };
      expect(entry.schema_version).toBe(carEntry.schema_version);

      // The entry stays conflicted (missing a valid owner target) → excluded.
      expect(contentService.listPublic("car")).toHaveLength(0);
    });

    it("retargeting an already-conflicted entry purges it and leaves it conflicted", () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const contentService = new ContentService(db);

      const person = schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      schemaService.create("company", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      const car = schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ], "editor1");

      const ownerField = car.fields.find((f) => f.label === "owner")!;
      const makeField = car.fields.find((f) => f.label === "make")!;
      const personNameField = person.fields[0];

      const personEntry = contentService.create(
        "person",
        { [String(personNameField.id)]: "Alice" },
        "editor1"
      );
      const carEntry = contentService.create(
        "car",
        { [String(makeField.id)]: "Civic", [String(ownerField.id)]: personEntry.id },
        "editor1"
      );

      // Change that does not bump schema_version but makes the schema breaking:
      // add a required field → compat_version = 2, entry stays at 1 → conflicted.
      const withVin = schemaService.update(
        "car",
        [
          { id: makeField.id, label: "make", type: "text", required: true },
          { id: ownerField.id, label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
          { label: "vin", type: "text", required: true },
        ],
        "editor1"
      );
      const vinField = withVin.fields.find((f) => f.label === "vin")!;
      expect(contentService.listForSchema("car")[0].conflict).toBe(true);

      // The ref row still exists after that first update (no retarget yet).
      const refBefore = db
        .prepare("SELECT 1 FROM content_refs WHERE content_id = ? AND field_id = ?")
        .get(carEntry.id, ownerField.id);
      expect(refBefore).toBeDefined();

      // Retarget owner person → company.
      schemaService.update(
        "car",
        [
          { id: makeField.id, label: "make", type: "text", required: true },
          { id: ownerField.id, label: "owner", type: "schema-ref", required: false, ref_schema: "company" },
          { id: vinField.id, label: "vin", type: "text", required: true },
        ],
        "editor1"
      );

      // Purged, never bumped, still conflicted.
      const refAfter = db
        .prepare("SELECT 1 FROM content_refs WHERE content_id = ? AND field_id = ?")
        .get(carEntry.id, ownerField.id);
      expect(refAfter).toBeUndefined();

      const entry = db
        .prepare("SELECT schema_version FROM content WHERE id = ?")
        .get(carEntry.id) as { schema_version: number };
      expect(entry.schema_version).toBe(carEntry.schema_version);

      expect(contentService.listPublic("car")).toHaveLength(0);
      let caught: unknown;
      try {
        contentService.getPublic("car", carEntry.id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ContentServiceError);
      expect((caught as ContentServiceError).statusCode).toBe(422);
    });
  });

  describe("previewUpdate", () => {
    function insertEntry(
      db: ReturnType<typeof openDatabase>,
      schemaName: string,
      schemaVersion = 1
    ): number {
      return Number(
        db
          .prepare(
            `INSERT INTO content (schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            schemaName,
            schemaVersion,
            new Date().toISOString(),
            "editor1",
            new Date().toISOString(),
            "editor1"
          ).lastInsertRowid
      );
    }

    function insertRow(
      db: ReturnType<typeof openDatabase>,
      contentId: number,
      fieldId: number,
      value: string
    ): void {
      db.prepare(
        `INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`
      ).run(contentId, fieldId, value);
    }

    function snapshot(db: ReturnType<typeof openDatabase>) {
      return {
        schemas: db.prepare("SELECT * FROM schemas").all(),
        fields: db.prepare("SELECT * FROM schema_fields").all(),
        content: db.prepare("SELECT * FROM content").all(),
        rows: db.prepare("SELECT * FROM content_rows").all(),
        refs: db.prepare("SELECT * FROM content_refs").all(),
      };
    }

    it("text→number flags only entries with a stored value and reports the would-be version", () => {
      const db = openDatabase();
      const service = new SchemaService(db);
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "year", type: "text", required: false },
      ], "editor1");

      const schema = service.get("car")!;
      const makeId = schema.fields.find((f) => f.label === "make")!.id;
      const yearId = schema.fields.find((f) => f.label === "year")!.id;

      const e1 = insertEntry(db, "car");
      const e2 = insertEntry(db, "car");
      insertRow(db, e1, makeId, '"Toyota"');
      insertRow(db, e1, yearId, '"2020"');
      insertRow(db, e2, makeId, '"Honda"');

      const preview = service.previewUpdate("car", [
        { id: makeId, label: "make", type: "text", required: true },
        { id: yearId, label: "year", type: "number", required: false },
      ]);

      expect(preview).toEqual({
        breaking: true,
        version: 2,
        compatVersion: 2,
        affectedEntries: [
          { id: e1, label: "Toyota", affectedFieldIds: [yearId] },
        ],
      });
    });

    it("number→text flags no entries and is non-breaking", () => {
      const db = openDatabase();
      const service = new SchemaService(db);
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "year", type: "number", required: false },
      ], "editor1");

      const schema = service.get("car")!;
      const makeId = schema.fields.find((f) => f.label === "make")!.id;
      const yearId = schema.fields.find((f) => f.label === "year")!.id;

      const e1 = insertEntry(db, "car");
      insertRow(db, e1, makeId, '"Toyota"');
      insertRow(db, e1, yearId, "2020");

      const preview = service.previewUpdate("car", [
        { id: makeId, label: "make", type: "text", required: true },
        { id: yearId, label: "year", type: "text", required: false },
      ]);

      expect(preview.breaking).toBe(false);
      expect(preview.version).toBe(2);
      expect(preview.compatVersion).toBe(1);
      expect(preview.affectedEntries).toHaveLength(0);
    });

    it("optional→required flags only entries that cannot satisfy the field anymore", () => {
      const db = openDatabase();
      const service = new SchemaService(db);
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      const schema = service.get("car")!;
      const makeId = schema.fields.find((f) => f.label === "make")!.id;
      const colorId = schema.fields.find((f) => f.label === "color")!.id;

      const e1 = insertEntry(db, "car");
      const e2 = insertEntry(db, "car");
      insertRow(db, e1, makeId, '"Toyota"');
      insertRow(db, e1, colorId, '"Red"');
      insertRow(db, e2, makeId, '"Honda"');

      const preview = service.previewUpdate("car", [
        { id: makeId, label: "make", type: "text", required: true },
        { id: colorId, label: "color", type: "text", required: true },
      ]);

      expect(preview.breaking).toBe(true);
      expect(preview.affectedEntries).toEqual([
        { id: e2, label: "Honda", affectedFieldIds: [colorId] },
      ]);
    });

    it("optional→required flags an entry storing an empty string for the field", () => {
      const db = openDatabase();
      const service = new SchemaService(db);
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      const schema = service.get("car")!;
      const makeId = schema.fields.find((f) => f.label === "make")!.id;
      const colorId = schema.fields.find((f) => f.label === "color")!.id;

      const e1 = insertEntry(db, "car");
      insertRow(db, e1, makeId, '"Toyota"');
      insertRow(db, e1, colorId, '""');

      const preview = service.previewUpdate("car", [
        { id: makeId, label: "make", type: "text", required: true },
        { id: colorId, label: "color", type: "text", required: true },
      ]);

      expect(preview.affectedEntries).toEqual([
        { id: e1, label: "Toyota", affectedFieldIds: [colorId] },
      ]);
    });

    it("new required field flags every entry (no field id to report yet)", () => {
      const db = openDatabase();
      const service = new SchemaService(db);
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.get("car")!;
      const makeId = schema.fields.find((f) => f.label === "make")!.id;

      const e1 = insertEntry(db, "car");
      const e2 = insertEntry(db, "car");
      insertRow(db, e1, makeId, '"Toyota"');
      insertRow(db, e2, makeId, '"Honda"');

      const preview = service.previewUpdate("car", [
        { id: makeId, label: "make", type: "text", required: true },
        { label: "vin", type: "text", required: true },
      ]);

      expect(preview.breaking).toBe(true);
      expect(preview.affectedEntries).toEqual([
        { id: e1, label: "Toyota", affectedFieldIds: [] },
        { id: e2, label: "Honda", affectedFieldIds: [] },
      ]);
    });

    it("new optional field flags nothing", () => {
      const db = openDatabase();
      const service = new SchemaService(db);
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      const schema = service.get("car")!;
      const makeId = schema.fields.find((f) => f.label === "make")!.id;

      const e1 = insertEntry(db, "car");
      insertRow(db, e1, makeId, '"Toyota"');

      const preview = service.previewUpdate("car", [
        { id: makeId, label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ]);

      expect(preview.breaking).toBe(false);
      expect(preview.affectedEntries).toHaveLength(0);
    });

    it("ref retarget flags only entries holding a ref for the field", () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const contentService = new ContentService(db);

      const person = schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      schemaService.create("company", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      const car = schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ], "editor1");

      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;
      const personNameField = person.fields[0];

      const personEntry = contentService.create(
        "person",
        { [String(personNameField.id)]: "Alice" },
        "editor1"
      );
      const withOwner = contentService.create(
        "car",
        { [String(makeField.id)]: "Civic", [String(ownerField.id)]: personEntry.id },
        "editor1"
      );
      const withoutOwner = contentService.create(
        "car",
        { [String(makeField.id)]: "Accord" },
        "editor1"
      );

      const preview = schemaService.previewUpdate("car", [
        { id: makeField.id, label: "make", type: "text", required: true },
        { id: ownerField.id, label: "owner", type: "schema-ref", required: false, ref_schema: "company" },
      ]);

      expect(preview.breaking).toBe(true);
      expect(preview.affectedEntries).toEqual([
        { id: withOwner.id, label: "Civic", affectedFieldIds: [ownerField.id] },
      ]);
      expect(preview.affectedEntries.find((e) => e.id === withoutOwner.id)).toBeUndefined();
    });

    it("deleted field flags only entries that stored the value", () => {
      const db = openDatabase();
      const service = new SchemaService(db);
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      const schema = service.get("car")!;
      const makeId = schema.fields.find((f) => f.label === "make")!.id;
      const colorId = schema.fields.find((f) => f.label === "color")!.id;

      const e1 = insertEntry(db, "car");
      const e2 = insertEntry(db, "car");
      insertRow(db, e1, makeId, '"Toyota"');
      insertRow(db, e1, colorId, '"Red"');
      insertRow(db, e2, makeId, '"Honda"');

      const preview = service.previewUpdate("car", [
        { id: makeId, label: "make", type: "text", required: true },
      ]);

      expect(preview.breaking).toBe(true);
      expect(preview.affectedEntries).toEqual([
        { id: e1, label: "Toyota", affectedFieldIds: [colorId] },
      ]);
    });

    it("flags entries whose only stored value is stale (row or ref) for the field", () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const contentService = new ContentService(db);

      const person = schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      const car = schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ], "editor1");

      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;
      const personNameField = person.fields[0];
      const personEntry = contentService.create(
        "person",
        { [String(personNameField.id)]: "Alice" },
        "editor1"
      );

      // Entry A: holds a ref. Flip schema-ref → text: the ref row survives.
      const entryWithRef = contentService.create(
        "car",
        { [String(makeField.id)]: "Civic", [String(ownerField.id)]: personEntry.id },
        "editor1"
      );
      schemaService.update("car", [
        { id: makeField.id, label: "make", type: "text", required: true },
        { id: ownerField.id, label: "owner", type: "text", required: false },
      ], "editor1");

      // Entry B: holds a text row. Flip text → schema-ref: the row survives.
      const entryWithRow = contentService.create(
        "car",
        { [String(makeField.id)]: "Accord", [String(ownerField.id)]: "Bob" },
        "editor1"
      );
      schemaService.update("car", [
        { id: makeField.id, label: "make", type: "text", required: true },
        { id: ownerField.id, label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ], "editor1");

      // Preview a schema-ref → text flip: both entries are disturbed — A via
      // its stale ref, B via its stale row. Reading only one table would miss
      // one of them.
      const preview = schemaService.previewUpdate("car", [
        { id: makeField.id, label: "make", type: "text", required: true },
        { id: ownerField.id, label: "owner", type: "text", required: false },
      ]);

      expect(preview.breaking).toBe(true);
      expect(preview.affectedEntries).toHaveLength(2);
      const byId = new Map(preview.affectedEntries.map((e) => [e.id, e]));
      expect(byId.get(entryWithRef.id)!.affectedFieldIds).toEqual([ownerField.id]);
      expect(byId.get(entryWithRow.id)!.affectedFieldIds).toEqual([ownerField.id]);
    });

    it("labels use the first required field value, falling back to Entry #id", () => {
      const db = openDatabase();
      const service = new SchemaService(db);
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      const schema = service.get("car")!;
      const makeId = schema.fields.find((f) => f.label === "make")!.id;
      const colorId = schema.fields.find((f) => f.label === "color")!.id;

      // e2 has no stored value for the required label field (raw SQL only).
      const e1 = insertEntry(db, "car");
      const e2 = insertEntry(db, "car");
      insertRow(db, e1, makeId, '"Toyota"');
      insertRow(db, e1, colorId, '"Red"');
      insertRow(db, e2, colorId, '"Blue"');

      // A new required field flags both entries, forcing the label computation.
      const preview = service.previewUpdate("car", [
        { id: makeId, label: "make", type: "text", required: true },
        { id: colorId, label: "color", type: "text", required: false },
        { label: "vin", type: "text", required: true },
      ]);

      const byId = new Map(preview.affectedEntries.map((e) => [e.id, e]));
      expect(byId.get(e1)!.label).toBe("Toyota");
      expect(byId.get(e2)!.label).toBe(`Entry #${e2}`);
    });

    it("writes nothing and a follow-up real update still applies the change", () => {
      const db = openDatabase();
      const service = new SchemaService(db);
      service.create("car", [
        { label: "make", type: "text", required: true },
        { label: "year", type: "text", required: false },
      ], "editor1");

      const schema = service.get("car")!;
      const makeId = schema.fields.find((f) => f.label === "make")!.id;
      const yearId = schema.fields.find((f) => f.label === "year")!.id;

      const e1 = insertEntry(db, "car");
      insertRow(db, e1, makeId, '"Toyota"');
      insertRow(db, e1, yearId, '"2020"');

      const before = snapshot(db);
      const preview = service.previewUpdate("car", [
        { id: makeId, label: "make", type: "text", required: true },
        { id: yearId, label: "year", type: "number", required: false },
      ]);
      expect(preview.affectedEntries).toHaveLength(1);
      expect(snapshot(db)).toEqual(before);

      // A follow-up real update applies cleanly on top of the untouched DB.
      const updated = service.update("car", [
        { id: makeId, label: "make", type: "text", required: true },
        { id: yearId, label: "year", type: "number", required: false },
      ], "editor1");
      expect(updated.version).toBe(2);
      expect(updated.compat_version).toBe(2);
      expect(
        db.prepare("SELECT type FROM schema_fields WHERE id = ?").get(yearId)
      ).toEqual({ type: "number" });
    });
  });

  describe("get and list", () => {
    it("returns null for non-existent schema", () => {
      const service = createService();
      expect(service.get("nonexistent")).toBeNull();
    });

    it("lists schemas with fields", () => {
      const service = createService();
      service.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");
      service.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");

      const schemas = service.list();
      expect(schemas.length).toBe(2);
    });
  });
});
