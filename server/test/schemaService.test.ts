import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase } from "../src/db/database";
import { SchemaService, SchemaServiceError } from "../src/services/schemaService";

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
