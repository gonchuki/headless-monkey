import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDatabase } from "../src/db/database";
import { SchemaService } from "../src/services/schemaService";
import { createSchemasRouter } from "../src/routes/schemas";
import express from "express";

function createTestApp() {
  const db = openDatabase();
  const schemaService = new SchemaService(db);
  const app = express();
  app.use(express.json());
  app.use("/api/schemas", createSchemasRouter(schemaService, "editor1"));
  return { app, db, schemaService };
}

describe("Schema Routes", () => {
  describe("GET /api/schemas", () => {
    it("returns empty list initially", async () => {
      const { app } = createTestApp();
      const res = await request(app).get("/api/schemas");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns schemas after creation", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      const res = await request(app).get("/api/schemas");
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].name).toBe("car");
    });
  });

  describe("GET /api/schemas/:name", () => {
    it("returns schema with fields", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "year", type: "number", required: false },
      ], "editor1");

      const res = await request(app).get("/api/schemas/car");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("car");
      expect(res.body.fields.length).toBe(2);
    });

    it("returns 404 for non-existent schema", async () => {
      const { app } = createTestApp();
      const res = await request(app).get("/api/schemas/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/schemas", () => {
    it("creates a schema (R11)", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post("/api/schemas")
        .send({
          name: "car",
          fields: [
            { label: "make", type: "text", required: true },
            { label: "year", type: "number", required: false },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("car");
      expect(res.body.version).toBe(1);
      expect(res.body.compat_version).toBe(1);
    });

    it("rejects zero fields (R8) → 422", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post("/api/schemas")
        .send({ name: "empty", fields: [] });

      expect(res.status).toBe(422);
    });

    it("rejects duplicate labels (R8) → 422", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post("/api/schemas")
        .send({
          name: "dup",
          fields: [
            { label: "x", type: "text", required: true },
            { label: "x", type: "number", required: false },
          ],
        });

      expect(res.status).toBe(422);
    });

    it("rejects duplicate name (R8) → 409", async () => {
      const { app } = createTestApp();
      await request(app)
        .post("/api/schemas")
        .send({
          name: "car",
          fields: [{ label: "make", type: "text", required: true }],
        });

      const res = await request(app)
        .post("/api/schemas")
        .send({
          name: "car",
          fields: [{ label: "model", type: "text", required: true }],
        });

      expect(res.status).toBe(409);
    });

    it("rejects invalid type (R9) → 422", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post("/api/schemas")
        .send({
          name: "bad",
          fields: [{ label: "x", type: "invalid", required: true }],
        });

      expect(res.status).toBe(422);
    });

    it("rejects self-referential cycle (R10) → 422", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");

      // Create car with ref to itself (self-reference)
      const res = await request(app)
        .post("/api/schemas")
        .send({
          name: "car",
          fields: [
            { label: "twin", type: "schema-ref", required: false, ref_schema: "car" },
          ],
        });

      expect(res.status).toBe(422);
    });

    it("rejects transitive cycle (R10) → 422", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      schemaService.create("garage", [
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ], "editor1");
      schemaService.create("car", [
        { label: "garage_ref", type: "schema-ref", required: false, ref_schema: "garage" },
      ], "editor1");

      // Try to update person to reference car → cycle: person→car→garage→person
      const res = await request(app)
        .patch("/api/schemas/person")
        .send({
          fields: [
            { id: 1, label: "name", type: "text", required: true },
            { label: "my_car", type: "schema-ref", required: false, ref_schema: "car" },
          ],
        });

      expect(res.status).toBe(422);
    });

    it("rejects mutual two-schema cycle (R10) → 422", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      schemaService.create("car", [
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ], "editor1");

      // Try to update person to reference car → cycle
      const res = await request(app)
        .patch("/api/schemas/person")
        .send({
          fields: [
            { id: 1, label: "name", type: "text", required: true },
            { label: "my_car", type: "schema-ref", required: false, ref_schema: "car" },
          ],
        });

      expect(res.status).toBe(422);
    });
  });

  describe("PATCH /api/schemas/:name", () => {
    it("updates schema fields (R12)", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      const res = await request(app)
        .patch("/api/schemas/car")
        .send({
          fields: [
            { id: 1, label: "make", type: "text", required: true },
            { label: "color", type: "text", required: false },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(2);
      expect(res.body.fields.length).toBe(2);
    });

    it("field rename preserves field_id (R15)", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      const res = await request(app)
        .patch("/api/schemas/car")
        .send({
          fields: [{ id: 1, label: "manufacturer", type: "text", required: true }],
        });

      expect(res.status).toBe(200);
      expect(res.body.fields[0].id).toBe(1);
      expect(res.body.fields[0].label).toBe("manufacturer");
    });

    it("deleting a field bumps compat_version (§7)", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      const res = await request(app)
        .patch("/api/schemas/car")
        .send({
          fields: [{ id: 1, label: "make", type: "text", required: true }],
        });

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(2);
      expect(res.body.compat_version).toBe(2); // breaking
    });
  });

  describe("DELETE /api/schemas/:name", () => {
    it("deletes a schema (R22)", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      const res = await request(app).delete("/api/schemas/car");
      expect(res.status).toBe(204);

      const getRes = await request(app).get("/api/schemas/car");
      expect(getRes.status).toBe(404);
    });

    it("blocks deleting referenced schema (R22) → 409", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      schemaService.create("car", [
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ], "editor1");

      const res = await request(app).delete("/api/schemas/person");
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("car");
    });

    it("deleting referencing schema allows deleting referenced", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      schemaService.create("car", [
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ], "editor1");

      // Delete car first
      const delCar = await request(app).delete("/api/schemas/car");
      expect(delCar.status).toBe(204);

      // Now person can be deleted
      const delPerson = await request(app).delete("/api/schemas/person");
      expect(delPerson.status).toBe(204);
    });
  });

  describe("compat_version transitions (§7 table)", () => {
    it.each([
      { desc: "add optional field", breaking: false },
      { desc: "number→text", breaking: false },
      { desc: "required→optional", breaking: false },
      { desc: "rename label", breaking: false },
      { desc: "reorder", breaking: false },
      { desc: "add required field", breaking: true },
      { desc: "delete field", breaking: true },
      { desc: "text→number", breaking: true },
      { desc: "optional→required", breaking: true },
      { desc: "into boolean", breaking: true },
      { desc: "out of boolean", breaking: true },
      { desc: "into date", breaking: true },
      { desc: "ref target change", breaking: true },
    ])(
      "compat_version %s → breaking=%p",
      async ({ desc, breaking }) => {
        const { app, schemaService } = createTestApp();
        let schema;

        switch (desc) {
          case "add optional field":
            schemaService.create("car", [
              { label: "make", type: "text", required: true },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [
                  { id: 1, label: "make", type: "text", required: true },
                  { label: "color", type: "text", required: false },
                ],
              });
            break;

          case "number→text":
            schemaService.create("car", [
              { label: "year", type: "number", required: true },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [{ id: 1, label: "year", type: "text", required: true }],
              });
            break;

          case "required→optional":
            schemaService.create("car", [
              { label: "make", type: "text", required: true },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [{ id: 1, label: "make", type: "text", required: false }],
              });
            break;

          case "rename label":
            schemaService.create("car", [
              { label: "make", type: "text", required: true },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [{ id: 1, label: "manufacturer", type: "text", required: true }],
              });
            break;

          case "reorder":
            schemaService.create("car", [
              { label: "make", type: "text", required: true },
              { label: "year", type: "number", required: false },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [
                  { id: 2, label: "year", type: "number", required: false },
                  { id: 1, label: "make", type: "text", required: true },
                ],
              });
            break;

          case "add required field":
            schemaService.create("car", [
              { label: "make", type: "text", required: true },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [
                  { id: 1, label: "make", type: "text", required: true },
                  { label: "vin", type: "text", required: true },
                ],
              });
            break;

          case "delete field":
            schemaService.create("car", [
              { label: "make", type: "text", required: true },
              { label: "color", type: "text", required: false },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [{ id: 1, label: "make", type: "text", required: true }],
              });
            break;

          case "text→number":
            schemaService.create("car", [
              { label: "year", type: "text", required: true },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [{ id: 1, label: "year", type: "number", required: true }],
              });
            break;

          case "optional→required":
            schemaService.create("car", [
              { label: "color", type: "text", required: false },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [{ id: 1, label: "color", type: "text", required: true }],
              });
            break;

          case "into boolean":
            schemaService.create("car", [
              { label: "active", type: "text", required: false },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [{ id: 1, label: "active", type: "boolean", required: false }],
              });
            break;

          case "out of boolean":
            schemaService.create("car", [
              { label: "active", type: "boolean", required: false },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [{ id: 1, label: "active", type: "text", required: false }],
              });
            break;

          case "into date":
            schemaService.create("car", [
              { label: "built", type: "text", required: false },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [{ id: 1, label: "built", type: "date", required: false }],
              });
            break;

          case "ref target change":
            schemaService.create("person", [
              { label: "name", type: "text", required: true },
            ], "editor1");
            schemaService.create("company", [
              { label: "name", type: "text", required: true },
            ], "editor1");
            schemaService.create("car", [
              { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [
                  { id: 1, label: "owner", type: "schema-ref", required: false, ref_schema: "company" },
                ],
              });
            break;
        }

        const result = schemaService.get("car");
        expect(result).not.toBeNull();
        if (breaking) {
          expect(result!.compat_version).toBe(result!.version);
        } else {
          expect(result!.compat_version).toBe(1);
        }
      }
    );
  });

  describe("field-delete propagation (R21)", () => {
    it("removes content_rows and bumps schema_version", async () => {
      const { app, schemaService, db } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      // Create content entry
      const insertResult = db.prepare(
        `INSERT INTO content (schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by) VALUES (?, ?, ?, ?, ?, ?)`
      ).run("car", 2, new Date().toISOString(), "editor1", new Date().toISOString(), "editor1");
      const entryId = insertResult.lastInsertRowid;

      db.prepare(
        `INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`
      ).run(entryId, 1, '"Toyota"');
      db.prepare(
        `INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`
      ).run(entryId, 2, '"Red"');

      // Delete the color field
      await request(app)
        .patch("/api/schemas/car")
        .send({
          fields: [{ id: 1, label: "make", type: "text", required: true }],
        });

      // Verify content_rows for field_id=2 are gone
      const remainingRows = db
        .prepare(`SELECT * FROM content_rows WHERE content_id = ?`)
        .all(entryId);
      expect(remainingRows.length).toBe(1);
      expect((remainingRows[0] as any).field_id).toBe(1);

      // Verify schema_version was bumped
      const entry = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryId) as { schema_version: number };
      expect(entry.schema_version).toBe(2);
    });
  });
});
