import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDatabase } from "../src/db/database";
import { SchemaService } from "../src/services/schemaService";
import { ContentService } from "../src/services/contentService";
import { EventsEmitter, type RealtimeEvent } from "../src/services/events";
import { createSchemasRouter } from "../src/routes/schemas";
import express from "express";

function createTestApp() {
  const db = openDatabase();
  const schemaService = new SchemaService(db);
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    (_req as any).user = { login: "editor1", role: "editor" };
    next();
  });
  app.use("/api/schemas", createSchemasRouter(schemaService));
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

    it("rejects whitespace-only label (R8) → 422", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post("/api/schemas")
        .send({
          name: "blank",
          fields: [{ label: "   ", type: "text", required: true }],
        });

      expect(res.status).toBe(422);
    });

    it("rejects no required fields (R8) → 422", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post("/api/schemas")
        .send({
          name: "optional",
          fields: [{ label: "x", type: "text", required: false }],
        });

      expect(res.status).toBe(422);
    });

    it("rejects zero fields on update (R8) → 422", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");

      const res = await request(app)
        .patch("/api/schemas/car")
        .send({ fields: [] });

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
            { label: "make", type: "text", required: true },
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
        { label: "name", type: "text", required: true },
      ], "editor1");
      schemaService.create("car", [
        { label: "garage_ref", type: "schema-ref", required: false, ref_schema: "garage" },
        { label: "name", type: "text", required: true },
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
        { label: "make", type: "text", required: true },
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

    it("rejects duplicate field labels on PATCH (R8) → 422", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      const res = await request(app)
        .patch("/api/schemas/car")
        .send({
          fields: [
            { id: 1, label: "make", type: "text", required: true },
            { id: 2, label: "make", type: "text", required: false },
          ],
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("Duplicate field label");
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
        { label: "make", type: "text", required: true },
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
        { label: "make", type: "text", required: true },
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
              { label: "make", type: "text", required: true },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [
                  { id: 1, label: "color", type: "text", required: true },
                  { id: 2, label: "make", type: "text", required: true },
                ],
              });
            break;

          case "into boolean":
            schemaService.create("car", [
              { label: "active", type: "text", required: false },
              { label: "make", type: "text", required: true },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [
                  { id: 1, label: "active", type: "boolean", required: false },
                  { id: 2, label: "make", type: "text", required: true },
                ],
              });
            break;

          case "out of boolean":
            schemaService.create("car", [
              { label: "active", type: "boolean", required: false },
              { label: "make", type: "text", required: true },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [
                  { id: 1, label: "active", type: "text", required: false },
                  { id: 2, label: "make", type: "text", required: true },
                ],
              });
            break;

          case "into date":
            schemaService.create("car", [
              { label: "built", type: "text", required: false },
              { label: "make", type: "text", required: true },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [
                  { id: 1, label: "built", type: "date", required: false },
                  { id: 2, label: "make", type: "text", required: true },
                ],
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
              { label: "make", type: "text", required: true },
            ], "editor1");
            await request(app)
              .patch("/api/schemas/car")
              .send({
                fields: [
                  { id: 1, label: "owner", type: "schema-ref", required: false, ref_schema: "company" },
                  { id: 2, label: "make", type: "text", required: true },
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

      // Create content entry with no value for the optional color field
      const insertResult = db.prepare(
        `INSERT INTO content (schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by) VALUES (?, ?, ?, ?, ?, ?)`
      ).run("car", 1, new Date().toISOString(), "editor1", new Date().toISOString(), "editor1");
      const entryId = insertResult.lastInsertRowid;

      db.prepare(
        `INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`
      ).run(entryId, 1, '"Toyota"');

      // Delete the color field
      await request(app)
        .patch("/api/schemas/car")
        .send({
          fields: [{ id: 1, label: "make", type: "text", required: true }],
        });

      // Verify schema_version was bumped (entry had no value for deleted field)
      const entry = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryId) as { schema_version: number };
      expect(entry.schema_version).toBe(2);
    });

    it("selective bump: entries compatible with the remaining schema get bumped", async () => {
      const { app, schemaService, db } = createTestApp();
      const contentService = new ContentService(db);

      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      const schema = schemaService.get("car")!;
      const makeField = schema.fields.find((f) => f.label === "make")!;
      const colorField = schema.fields.find((f) => f.label === "color")!;

      // Entry with a value for the deleted field (will be removed)
      const entryA = contentService.create(
        "car",
        { [String(makeField.id)]: "Toyota", [String(colorField.id)]: "Red" },
        "editor1"
      );

      // Entry without a value for the deleted field
      const entryB = contentService.create(
        "car",
        { [String(makeField.id)]: "Honda" },
        "editor1"
      );

      await request(app)
        .patch("/api/schemas/car")
        .send({
          fields: [{ id: makeField.id, label: "make", type: "text", required: true }],
        });

      // Validation-based bump: both entries are compatible with the remaining
      // schema (make is required, both have it). Entry A lost its color value
      // but is still compatible → bumped.
      const entryAAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryA.id) as { schema_version: number };
      expect(entryAAfter.schema_version).toBe(2);

      const entryBAfter = db
        .prepare(`SELECT schema_version FROM content WHERE id = ?`)
        .get(entryB.id) as { schema_version: number };
      expect(entryBAfter.schema_version).toBe(2);
    });
  });

  describe("ref-target retarget purge (R35)", () => {
    it("PATCH 200, purges content_refs, leaves schema_version unchanged", async () => {
      const { app, schemaService, db } = createTestApp();
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

      const personNameField = person.fields[0];
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;

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

      // Retarget owner person → company via the API.
      const res = await request(app)
        .patch("/api/schemas/car")
        .send({
          fields: [
            { id: makeField.id, label: "make", type: "text", required: true },
            { id: ownerField.id, label: "owner", type: "schema-ref", required: false, ref_schema: "company" },
          ],
        });

      expect(res.status).toBe(200);

      // Direct DB assertions mirroring the R21 route test style.
      const refRows = db
        .prepare("SELECT 1 FROM content_refs WHERE content_id = ? AND field_id = ?")
        .get(carEntry.id, ownerField.id);
      expect(refRows).toBeUndefined();

      const entry = db
        .prepare("SELECT schema_version FROM content WHERE id = ?")
        .get(carEntry.id) as { schema_version: number };
      expect(entry.schema_version).toBe(carEntry.schema_version);
    });
  });

  describe("PATCH /api/schemas/:name preview (?preview=true)", () => {
    function snapshot(db: ReturnType<typeof openDatabase>) {
      return {
        schemas: db.prepare("SELECT * FROM schemas").all(),
        fields: db.prepare("SELECT * FROM schema_fields").all(),
        content: db.prepare("SELECT * FROM content").all(),
        rows: db.prepare("SELECT * FROM content_rows").all(),
        refs: db.prepare("SELECT * FROM content_refs").all(),
      };
    }

    it("returns 200 with the preview shape and leaves the DB untouched", async () => {
      const { app, schemaService, db } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "year", type: "text", required: false },
      ], "editor1");

      const schema = schemaService.get("car")!;
      const makeId = schema.fields.find((f) => f.label === "make")!.id;
      const yearId = schema.fields.find((f) => f.label === "year")!.id;

      const now = new Date().toISOString();
      const entryId = Number(
        db.prepare(
          `INSERT INTO content (schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by) VALUES (?, ?, ?, ?, ?, ?)`
        ).run("car", 1, now, "editor1", now, "editor1").lastInsertRowid
      );
      db.prepare(`INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`).run(entryId, makeId, '"Toyota"');
      db.prepare(`INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`).run(entryId, yearId, '"2020"');

      const before = snapshot(db);

      const res = await request(app)
        .patch("/api/schemas/car?preview=true")
        .send({
          fields: [
            { id: makeId, label: "make", type: "text", required: true },
            { id: yearId, label: "year", type: "number", required: false },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        breaking: true,
        version: 2,
        compatVersion: 2,
        affectedEntries: [
          { id: entryId, label: "Toyota", affectedFieldIds: [yearId] },
        ],
      });
      expect(snapshot(db)).toEqual(before);
    });

    it("the identical payload without the flag applies the change (regression)", async () => {
      const { app, schemaService, db } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "year", type: "text", required: false },
      ], "editor1");

      const schema = schemaService.get("car")!;
      const makeId = schema.fields.find((f) => f.label === "make")!.id;
      const yearId = schema.fields.find((f) => f.label === "year")!.id;

      const res = await request(app)
        .patch("/api/schemas/car")
        .send({
          fields: [
            { id: makeId, label: "make", type: "text", required: true },
            { id: yearId, label: "year", type: "number", required: false },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(2);
      expect(res.body.compat_version).toBe(2);
      const row = db
        .prepare("SELECT type FROM schema_fields WHERE id = ?")
        .get(yearId) as { type: string };
      expect(row.type).toBe("number");
    });

    it("does not emit an SSE event; a real PATCH does", async () => {
      const db = openDatabase();
      const schemaService = new SchemaService(db);
      const emitter = new EventsEmitter();
      const events: RealtimeEvent[] = [];
      emitter.subscribe(null, (event) => events.push(event));

      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => {
        (_req as any).user = { login: "editor1", role: "editor" };
        next();
      });
      app.use("/api/schemas", createSchemasRouter(schemaService, emitter));

      schemaService.create("car", [
        { label: "make", type: "text", required: true },
      ], "editor1");
      const schema = schemaService.get("car")!;
      const makeId = schema.fields[0].id;

      const previewRes = await request(app)
        .patch("/api/schemas/car?preview=true")
        .send({ fields: [{ id: makeId, label: "make", type: "text", required: true }] });
      expect(previewRes.status).toBe(200);
      expect(events).toHaveLength(0);

      await request(app)
        .patch("/api/schemas/car")
        .send({ fields: [{ id: makeId, label: "make", type: "text", required: true }] });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("schema.updated");
    });

    it("returns 404 for unknown schema", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .patch("/api/schemas/nonexistent?preview=true")
        .send({ fields: [{ label: "x", type: "text", required: true }] });
      expect(res.status).toBe(404);
    });

    it.each([
      ["zero fields", []],
      [
        "blank label",
        [{ id: 1, label: "   ", type: "text", required: true }],
      ],
      [
        "no required field",
        [{ id: 1, label: "make", type: "text", required: false }],
      ],
      [
        "duplicate label",
        [
          { id: 1, label: "x", type: "text", required: true },
          { id: 2, label: "x", type: "text", required: false },
        ],
      ],
    ])("rejects %s → 422 with the same status as a real PATCH", async (_desc, fields) => {
      const { app, schemaService } = createTestApp();
      schemaService.create("car", [
        { label: "make", type: "text", required: true },
        { label: "color", type: "text", required: false },
      ], "editor1");

      const previewRes = await request(app)
        .patch("/api/schemas/car?preview=true")
        .send({ fields });
      expect(previewRes.status).toBe(422);

      const patchRes = await request(app)
        .patch("/api/schemas/car")
        .send({ fields });
      expect(patchRes.status).toBe(422);
    });

    it("rejects circular reference → 422 with the same status as a real PATCH", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create("person", [
        { label: "name", type: "text", required: true },
      ], "editor1");
      schemaService.create("car", [
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
        { label: "make", type: "text", required: true },
      ], "editor1");

      // Update person to reference car → cycle: person → car → person.
      const fields = [
        { id: 1, label: "name", type: "text", required: true },
        { label: "my_car", type: "schema-ref", required: false, ref_schema: "car" },
      ];

      const previewRes = await request(app)
        .patch("/api/schemas/person?preview=true")
        .send({ fields });
      expect(previewRes.status).toBe(422);

      const patchRes = await request(app)
        .patch("/api/schemas/person")
        .send({ fields });
      expect(patchRes.status).toBe(422);
    });
  });
});
