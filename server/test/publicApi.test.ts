import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app";
import { openDatabase } from "../src/db/database";
import { SchemaService } from "../src/services/schemaService";

function createTestApp() {
  const db = openDatabase();
  const app = createApp(db);
  const schemaService = new SchemaService(db);
  return { app, db, schemaService };
}

function editorToken(): string {
  return jwt.sign({ sub: "editor1", role: "editor" }, "test-secret", { expiresIn: "8h" });
}

function adminToken(): string {
  return jwt.sign({ sub: "admin", role: "admin" }, "test-secret", { expiresIn: "8h" });
}

function makeCarSchema(schemaService: SchemaService) {
  return schemaService.create(
    "car",
    [
      { label: "make", type: "text", required: true },
      { label: "year", type: "number", required: false },
    ],
    "editor1"
  );
}

describe("Public content API (R18-R20)", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = "test-admin-pass";
    process.env.JWT_SECRET = "test-secret";
  });

  describe("R20 — public routes need no Authorization header", () => {
    it("GET /api/content/:schema works without auth", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);

      const res = await request(app).get("/api/content/car");
      expect(res.status).toBe(200);
      // v0.7 wrapper: {schema, entries}, never a bare array; the old `meta` key is gone
      expect(res.body.schema).toEqual({
        name: "car",
        version: 1,
        fields: Object.fromEntries(car.fields.map((f) => [String(f.id), f.label])),
      });
      expect(res.body).not.toHaveProperty("meta");
      expect(res.body.entries).toEqual([]);
    });

    it("GET /api/content/:schema/:id works without auth", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const yearField = car.fields.find((f) => f.label === "year")!;

      const created = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${editorToken()}`)
        .send({ values: { [String(makeField.id)]: "Civic", [String(yearField.id)]: 2019 } });
      expect(created.status).toBe(201);

      const res = await request(app).get(`/api/content/car/${created.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.schema.name).toBe("car");
      expect(res.body).not.toHaveProperty("meta");
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0]).not.toHaveProperty("schema");
      expect(res.body.entries[0].values[String(makeField.id)]).toBe("Civic");
    });
  });

  describe("GET /api/content/:schema (R18)", () => {
    it("returns only valid entries when others are conflicted", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const token = editorToken();

      const e1 = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(makeField.id)]: "Civic" } });
      const e2 = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(makeField.id)]: "Accord" } });
      expect(e1.status).toBe(201);
      expect(e2.status).toBe(201);

      // Breaking change: add a required field (vin)
      const vinLabel = { label: "vin", type: "text", required: true };
      await request(app)
        .patch("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fields: [
            ...car.fields.map((f) => ({
              id: f.id,
              label: f.label,
              type: f.type,
              required: f.required,
              ...(f.ref_schema ? { ref_schema: f.ref_schema } : {}),
            })),
            vinLabel,
          ],
        });

      // Resolve e1 only
      const car2 = await request(app)
        .get("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`);
      const vinField = car2.body.fields.find((f: { label: string }) => f.label === "vin");
      const patch = await request(app)
        .patch(`/api/entries/${e1.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(vinField.id)]: "VIN123" } });
      expect(patch.status).toBe(200);

      const list = await request(app).get("/api/content/car");
      expect(list.status).toBe(200);
      // schema reflects the schema post-renovation: version bumped to 2, vin present
      expect(list.body.schema.name).toBe("car");
      expect(list.body.schema.version).toBe(2);
      expect(list.body.schema.fields[String(makeField.id)]).toBe("make");
      expect(list.body.schema.fields[String(vinField.id)]).toBe("vin");
      expect(list.body).not.toHaveProperty("meta");
      expect(list.body.entries).toHaveLength(1);
      expect(list.body.entries[0]).not.toHaveProperty("schema");
      expect(list.body.entries[0].id).toBe(e1.body.id);
      // values are keyed by String(field_id), not field labels
      expect(list.body.entries[0].values[String(makeField.id)]).toBe("Civic");
    });

    it("returns 404 for an unknown schema", async () => {
      const { app } = createTestApp();
      const res = await request(app).get("/api/content/nope");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/content/:schema/:id (R19)", () => {
    it("returns 200 for a valid entry", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;

      const created = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${editorToken()}`)
        .send({ values: { [String(makeField.id)]: "Civic" } });

      const res = await request(app).get(`/api/content/car/${created.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.schema).toEqual({
        name: "car",
        version: 1,
        fields: Object.fromEntries(car.fields.map((f) => [String(f.id), f.label])),
      });
      expect(res.body).not.toHaveProperty("meta");
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].id).toBe(created.body.id);
      // The envelope's schema.name names the schema; the entry itself must not repeat it.
      expect(res.body.entries[0]).not.toHaveProperty("schema");
      expect(res.body.entries[0].schema_version).toBe(1);
      expect(res.body.entries[0].values).toEqual({ [String(makeField.id)]: "Civic" });
      expect(res.body.entries[0]).not.toHaveProperty("conflict");
    });

    it("enriches schema-ref values as {id, schema} keyed by field label on the public route", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create(
        "person",
        [{ label: "name", type: "text", required: true }],
        "editor1"
      );
      const car = schemaService.create(
        "car",
        [
          { label: "make", type: "text", required: true },
          { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
        ],
        "editor1"
      );
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;
      const token = editorToken();

      const person = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { "1": "Alice" } });
      expect(person.status).toBe(201);

      const created = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: person.body.id,
          },
        });
      expect(created.status).toBe(201);
      // Editor POST responses keep field_id keys with the raw target id number
      expect(created.body.values[String(ownerField.id)]).toBe(person.body.id);
      expect(created.body.values[String(makeField.id)]).toBe("Civic");

      const res = await request(app).get(`/api/content/car/${created.body.id}`);
      expect(res.status).toBe(200);
      // schema-ref values keep the {id, schema} enrichment, keyed by String(field_id)
      expect(res.body.entries[0].values).toEqual({
        [String(makeField.id)]: "Civic",
        [String(ownerField.id)]: { id: person.body.id, schema: "person" },
      });
      expect(res.body.schema.fields[String(ownerField.id)]).toBe("owner");
    });

    it("returns 404 for an unknown id", async () => {
      const { app, schemaService } = createTestApp();
      makeCarSchema(schemaService);

      const res = await request(app).get("/api/content/car/99999");
      expect(res.status).toBe(404);
    });

    it("returns 422 for a conflicted entry (mutually exclusive with 200/404)", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const yearField = car.fields.find((f) => f.label === "year")!;
      const token = editorToken();

      const created = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(makeField.id)]: "Civic" } });

      await request(app)
        .patch("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fields: [
            { id: makeField.id, label: "make", type: "text", required: true },
            { id: yearField.id, label: "year", type: "number", required: false },
            { label: "vin", type: "text", required: true },
          ],
        });

      const conflicted = await request(app).get(`/api/content/car/${created.body.id}`);
      expect(conflicted.status).toBe(422);

      // Resolve through the editor route, then the same id returns 200
      const car2 = await request(app).get("/api/schemas/car").set("Authorization", `Bearer ${token}`);
      const vinField = car2.body.fields.find((f: { label: string }) => f.label === "vin");
      await request(app)
        .patch(`/api/entries/${created.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(vinField.id)]: "VIN123" } });

      const resolved = await request(app).get(`/api/content/car/${created.body.id}`);
      expect(resolved.status).toBe(200);
    });
  });

  describe("editor content routes are guarded (R4/R5)", () => {
    it("returns 401 without a token", async () => {
      const { app } = createTestApp();
      expect((await request(app).get("/api/schemas/car/entries")).status).toBe(401);
      expect((await request(app).post("/api/schemas/car/entries")).status).toBe(401);
      expect((await request(app).get("/api/entries/1")).status).toBe(401);
      expect((await request(app).patch("/api/entries/1")).status).toBe(401);
      expect((await request(app).delete("/api/entries/1")).status).toBe(401);
    });

    it("returns 403 for an admin token", async () => {
      const { app } = createTestApp();
      const auth = { Authorization: `Bearer ${adminToken()}` };
      expect((await request(app).get("/api/schemas/car/entries").set(auth)).status).toBe(403);
      expect((await request(app).post("/api/schemas/car/entries").set(auth)).status).toBe(403);
      expect((await request(app).get("/api/entries/1").set(auth)).status).toBe(403);
      expect((await request(app).patch("/api/entries/1").set(auth)).status).toBe(403);
      expect((await request(app).delete("/api/entries/1").set(auth)).status).toBe(403);
    });
  });

  describe("GET /api/entries/:id (single-entry editor route)", () => {
    it("returns 200 with editor shape for an existing entry", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const yearField = car.fields.find((f) => f.label === "year")!;
      const token = editorToken();

      const created = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(makeField.id)]: "Civic", [String(yearField.id)]: 2019 } });
      expect(created.status).toBe(201);

      const res = await request(app)
        .get(`/api/entries/${created.body.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.body.id);
      expect(res.body.schema).toBe("car");
      // values keyed by String(field_id)
      expect(res.body.values[String(makeField.id)]).toBe("Civic");
      expect(res.body.values[String(yearField.id)]).toBe(2019);
      // conflict and referencer_count present
      expect(res.body.conflict).toBe(false);
      expect(typeof res.body.referencer_count).toBe("number");
    });

    it("returns 404 for an unknown id", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get("/api/entries/99999")
        .set("Authorization", `Bearer ${editorToken()}`);
      expect(res.status).toBe(404);
    });

    it("returns 200 with conflict: true for a conflicted entry (not 422)", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const token = editorToken();

      const created = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(makeField.id)]: "Civic" } });
      expect(created.status).toBe(201);

      // Breaking change: add a required field
      await request(app)
        .patch("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fields: [
            { id: makeField.id, label: "make", type: "text", required: true },
            { label: "vin", type: "text", required: true },
          ],
        });

      // Single-entry route returns 200 with conflict: true (editor is the repair surface)
      const res = await request(app)
        .get(`/api/entries/${created.body.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.conflict).toBe(true);
    });

    it("enriches schema-ref values as raw target ids in editor shape", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create(
        "person",
        [{ label: "name", type: "text", required: true }],
        "editor1"
      );
      const car = schemaService.create(
        "car",
        [
          { label: "make", type: "text", required: true },
          { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
        ],
        "editor1"
      );
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;
      const token = editorToken();

      const person = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { "1": "Alice" } });
      expect(person.status).toBe(201);

      const created = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: person.body.id,
          },
        });
      expect(created.status).toBe(201);

      const res = await request(app)
        .get(`/api/entries/${created.body.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      // schema-ref value is the raw target id (not enriched {id, schema})
      expect(res.body.values[String(ownerField.id)]).toBe(person.body.id);
    });

    it("auth guards: 401 without token, 403 for admin", async () => {
      const { app } = createTestApp();
      expect((await request(app).get("/api/entries/1")).status).toBe(401);
      expect((await request(app).get("/api/entries/1").set({ Authorization: `Bearer ${adminToken()}` })).status).toBe(403);
    });
  });

  describe("editor content CRUD", () => {
    it("creates, lists, edits and deletes entries", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const yearField = car.fields.find((f) => f.label === "year")!;
      const token = editorToken();

      const created = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(makeField.id)]: "Civic", [String(yearField.id)]: 2019 } });
      expect(created.status).toBe(201);
      expect(created.body.schema).toBe("car");
      // Editor routes serialize values keyed by String(field_id)
      expect(created.body.values).toEqual({
        [String(makeField.id)]: "Civic",
        [String(yearField.id)]: 2019,
      });

      const list = await request(app)
        .get("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`);
      expect(list.status).toBe(200);
      expect(list.body.length).toBe(1);
      expect(list.body[0].conflict).toBe(false);
      expect(list.body[0].values).toEqual({
        [String(makeField.id)]: "Civic",
        [String(yearField.id)]: 2019,
      });

      const patched = await request(app)
        .patch(`/api/entries/${created.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(makeField.id)]: "Accord", [String(yearField.id)]: 2020 } });
      expect(patched.status).toBe(200);
      expect(patched.body.values[String(makeField.id)]).toBe("Accord");
      expect(patched.body.values[String(yearField.id)]).toBe(2020);

      const del = await request(app)
        .delete(`/api/entries/${created.body.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(del.status).toBe(204);

      const afterDelete = await request(app).get(`/api/content/car/${created.body.id}`);
      expect(afterDelete.status).toBe(404);
    });

    it("rejects invalid values with 422 via the editor route (R16)", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const yearField = car.fields.find((f) => f.label === "year")!;

      const res = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${editorToken()}`)
        .send({ values: { [String(makeField.id)]: "", [String(yearField.id)]: "2019" } });

      expect(res.status).toBe(422);
    });
  });

  describe("editor delete clears refs on referenced entries (R34)", () => {
    it("deletes a referenced entry by clearing its refs (204); unreferenced deletes stay 204", async () => {
      const { app, schemaService } = createTestApp();
      const personSchema = schemaService.create(
        "person",
        [{ label: "name", type: "text", required: true }],
        "editor1"
      );
      const car = schemaService.create(
        "car",
        [
          { label: "make", type: "text", required: true },
          { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
        ],
        "editor1"
      );
      const nameField = personSchema.fields.find((f) => f.label === "name")!;
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;
      const token = editorToken();

      const personRes = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(nameField.id)]: "Alice" } });
      expect(personRes.status).toBe(201);

      const carRes = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: personRes.body.id,
          },
        });
      expect(carRes.status).toBe(201);

      const del = await request(app)
        .delete(`/api/entries/${personRes.body.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(del.status).toBe(204);

      const ok = await request(app)
        .delete(`/api/entries/${carRes.body.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(ok.status).toBe(204);
    });
  });

  describe("pagination", () => {
    it("editor: GET /api/schemas/car/entries?limit=2 returns paginated response", async () => {
      const { app, schemaService } = createTestApp();
      makeCarSchema(schemaService);
      const token = editorToken();
      const makeField = { id: 1, label: "make" }; // car schema field ids start at 1

      // Create 5 entries
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post("/api/schemas/car/entries")
          .set("Authorization", `Bearer ${token}`)
          .send({ values: { "1": `Car ${i}` } });
      }

      const page1 = await request(app)
        .get("/api/schemas/car/entries?limit=2")
        .set("Authorization", `Bearer ${token}`);
      expect(page1.status).toBe(200);
      expect(page1.body.entries).toHaveLength(2);
      expect(page1.body.pagination.nextCursor).toBeDefined();
      expect(page1.body.pagination.prevCursor).toBeNull();

      const page2 = await request(app)
        .get(`/api/schemas/car/entries?limit=2&cursor=${page1.body.pagination.nextCursor}`)
        .set("Authorization", `Bearer ${token}`);
      expect(page2.status).toBe(200);
      expect(page2.body.entries).toHaveLength(2);
      expect(page2.body.pagination.nextCursor).toBeDefined();
      expect(page2.body.pagination.prevCursor).toBeDefined();

      const page3 = await request(app)
        .get(`/api/schemas/car/entries?limit=2&cursor=${page2.body.pagination.nextCursor}`)
        .set("Authorization", `Bearer ${token}`);
      expect(page3.status).toBe(200);
      expect(page3.body.entries).toHaveLength(1);
      expect(page3.body.pagination.nextCursor).toBeNull();
    });

    it("public: GET /api/content/car?limit=2 returns paginated response with schema envelope", async () => {
      const { app, schemaService } = createTestApp();
      makeCarSchema(schemaService);
      const token = editorToken();

      for (let i = 0; i < 5; i++) {
        await request(app)
          .post("/api/schemas/car/entries")
          .set("Authorization", `Bearer ${token}`)
          .send({ values: { "1": `Car ${i}` } });
      }

      const page1 = await request(app).get("/api/content/car?limit=2");
      expect(page1.status).toBe(200);
      expect(page1.body.schema).toBeDefined();
      expect(page1.body.entries).toHaveLength(2);
      expect(page1.body.pagination.nextCursor).toBeDefined();
      expect(page1.body.pagination.prevCursor).toBeNull();

      const page2 = await request(app).get(
        `/api/content/car?limit=2&cursor=${page1.body.pagination.nextCursor}`
      );
      expect(page2.status).toBe(200);
      expect(page2.body.entries).toHaveLength(2);

      const page3 = await request(app).get(
        `/api/content/car?limit=2&cursor=${page2.body.pagination.nextCursor}`
      );
      expect(page3.status).toBe(200);
      expect(page3.body.entries).toHaveLength(1);
      expect(page3.body.pagination.nextCursor).toBeNull();
    });

    it("public: no pagination params returns all entries with null cursors", async () => {
      const { app, schemaService } = createTestApp();
      makeCarSchema(schemaService);
      const token = editorToken();

      for (let i = 0; i < 3; i++) {
        await request(app)
          .post("/api/schemas/car/entries")
          .set("Authorization", `Bearer ${token}`)
          .send({ values: { "1": `Car ${i}` } });
      }

      const res = await request(app).get("/api/content/car");
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(3);
      expect(res.body.pagination).toEqual({ nextCursor: null, prevCursor: null });
    });

    it("limit clamping: ?limit=0 returns 1 entry, ?limit=999 returns at most 200", async () => {
      const { app, schemaService } = createTestApp();
      makeCarSchema(schemaService);
      const token = editorToken();

      for (let i = 0; i < 5; i++) {
        await request(app)
          .post("/api/schemas/car/entries")
          .set("Authorization", `Bearer ${token}`)
          .send({ values: { "1": `Car ${i}` } });
      }

      const limit0 = await request(app)
        .get("/api/schemas/car/entries?limit=0")
        .set("Authorization", `Bearer ${token}`);
      expect(limit0.body.entries).toHaveLength(1);

      const limitBig = await request(app)
        .get("/api/schemas/car/entries?limit=999")
        .set("Authorization", `Bearer ${token}`);
      expect(limitBig.body.entries).toHaveLength(5); // only 5 entries exist
    });

    it("invalid cursor (non-numeric) returns first page", async () => {
      const { app, schemaService } = createTestApp();
      makeCarSchema(schemaService);
      const token = editorToken();

      for (let i = 0; i < 3; i++) {
        await request(app)
          .post("/api/schemas/car/entries")
          .set("Authorization", `Bearer ${token}`)
          .send({ values: { "1": `Car ${i}` } });
      }

      const res = await request(app)
        .get("/api/schemas/car/entries?cursor=abc")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(3);
      expect(res.body.pagination.prevCursor).toBeNull();
    });

    it("backward navigation via direction=backward", async () => {
      const { app, schemaService } = createTestApp();
      makeCarSchema(schemaService);
      const token = editorToken();

      for (let i = 0; i < 5; i++) {
        await request(app)
          .post("/api/schemas/car/entries")
          .set("Authorization", `Bearer ${token}`)
          .send({ values: { "1": `Car ${i}` } });
      }

      // Get first page
      const page1 = await request(app)
        .get("/api/schemas/car/entries?limit=2")
        .set("Authorization", `Bearer ${token}`);

      // Get second page
      const page2 = await request(app)
        .get(`/api/schemas/car/entries?limit=2&cursor=${page1.body.pagination.nextCursor}`)
        .set("Authorization", `Bearer ${token}`);

      // Navigate backward from page2's first entry
      const back = await request(app)
        .get(
          `/api/schemas/car/entries?limit=2&cursor=${page2.body.entries[0].id}&direction=backward`
        )
        .set("Authorization", `Bearer ${token}`);
      expect(back.status).toBe(200);
      expect(back.body.entries).toHaveLength(2);
      expect(back.body.pagination.prevCursor).toBeNull();
    });

    it("empty schema returns { entries: [], pagination: { nextCursor: null, prevCursor: null } }", async () => {
      const { app, schemaService } = createTestApp();
      makeCarSchema(schemaService);

      const res = await request(app).get("/api/content/car?limit=10");
      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual([]);
      expect(res.body.pagination).toEqual({ nextCursor: null, prevCursor: null });
    });

    it("field sort: opaque cursors round-trip through URLs across pages", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);
      const token = editorToken();
      const makeField = car.fields.find((f) => f.label === "make")!;

      // Seed so sort order disagrees with id order (Civic has the smallest id).
      for (const make of ["Civic", "Accord", "BMW"]) {
        await request(app)
          .post("/api/schemas/car/entries")
          .set("Authorization", `Bearer ${token}`)
          .send({ values: { [String(makeField.id)]: make } });
      }

      const page1 = await request(app)
        .get(`/api/schemas/car/entries?limit=2&sort_field=${makeField.id}&sort_order=asc`)
        .set("Authorization", `Bearer ${token}`);
      expect(page1.status).toBe(200);
      expect(page1.body.entries).toHaveLength(2);
      const next = page1.body.pagination.nextCursor;
      expect(next).not.toBeNull();

      // The keyset cursor carries the sort-column value, so page 2 contains
      // the remaining row (Civic) that a bare-id cursor would have dropped.
      const page2 = await request(app)
        .get(
          `/api/schemas/car/entries?limit=2&sort_field=${makeField.id}&sort_order=asc&cursor=${next}`
        )
        .set("Authorization", `Bearer ${token}`);
      expect(page2.status).toBe(200);
      expect(page2.body.entries).toHaveLength(1);
      expect(page2.body.entries[0].values[String(makeField.id)]).toBe("Civic");
      expect(page2.body.pagination.nextCursor).toBeNull();

      // Backward from page 2's prevCursor returns to page 1.
      const back = await request(app)
        .get(
          `/api/schemas/car/entries?limit=2&sort_field=${makeField.id}&sort_order=asc&cursor=${page2.body.pagination.prevCursor}&direction=backward`
        )
        .set("Authorization", `Bearer ${token}`);
      expect(back.status).toBe(200);
      expect(back.body.entries).toHaveLength(2);
      expect(back.body.pagination.prevCursor).toBeNull();
    });
  });

  describe("conflicted filter", () => {
    it("?conflicted=1 returns only conflicted entries; without param returns full set", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const token = editorToken();

      // Create 3 entries
      const e1 = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(makeField.id)]: "Civic" } });
      const e2 = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(makeField.id)]: "Accord" } });
      const e3 = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(makeField.id)]: "BMW" } });
      expect(e1.status).toBe(201);
      expect(e2.status).toBe(201);
      expect(e3.status).toBe(201);

      // Breaking change: add a required field (vin) — all entries become conflicted
      await request(app)
        .patch("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fields: [
            { id: makeField.id, label: "make", type: "text", required: true },
            { label: "vin", type: "text", required: true },
          ],
        });

      // Resolve e1 only — supply the new required field
      const carSchema = await request(app)
        .get("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`);
      const vinField = carSchema.body.fields.find((f: { label: string }) => f.label === "vin");
      const patched = await request(app)
        .patch(`/api/entries/${e1.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(vinField.id)]: "VIN123" } });
      expect(patched.status).toBe(200);

      // Full list (no filter): 3 entries, e1 is not conflicted, e2/e3 are
      const full = await request(app)
        .get("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`);
      expect(full.status).toBe(200);
      expect(full.body).toHaveLength(3);
      expect(full.body.some((e: any) => e.id === e1.body.id && !e.conflict)).toBe(true);
      expect(full.body.filter((e: any) => e.conflict).length).toBe(2);

      // Conflicted filter: only e2 and e3
      const conflicted = await request(app)
        .get("/api/schemas/car/entries?conflicted=1")
        .set("Authorization", `Bearer ${token}`);
      expect(conflicted.status).toBe(200);
      expect(conflicted.body).toHaveLength(2);
      expect(conflicted.body.every((e: any) => e.conflict)).toBe(true);
      const conflictedIds = new Set(conflicted.body.map((e: any) => e.id));
      expect(conflictedIds.has(e2.body.id)).toBe(true);
      expect(conflictedIds.has(e3.body.id)).toBe(true);
      expect(conflictedIds.has(e1.body.id)).toBe(false);
    });

    it("forward cursor walk under ?conflicted=1 visits each conflicted entry exactly once", async () => {
      const { app, schemaService } = createTestApp();
      const car = makeCarSchema(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const token = editorToken();

      // Create 5 entries
      const entries: number[] = [];
      for (let i = 0; i < 5; i++) {
        const created = await request(app)
          .post("/api/schemas/car/entries")
          .set("Authorization", `Bearer ${token}`)
          .send({ values: { [String(makeField.id)]: `Car ${i}` } });
        entries.push(created.body.id);
      }

      // Breaking change: add a required field — all 5 become conflicted
      await request(app)
        .patch("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fields: [
            { id: makeField.id, label: "make", type: "text", required: true },
            { label: "vin", type: "text", required: true },
          ],
        });

      // Resolve entries[0] and entries[3] — 3 remain conflicted
      const carSchema = await request(app)
        .get("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`);
      const vinField = carSchema.body.fields.find((f: { label: string }) => f.label === "vin");
      await request(app)
        .patch(`/api/entries/${entries[0]}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(vinField.id)]: "VIN0" } });
      await request(app)
        .patch(`/api/entries/${entries[3]}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(vinField.id)]: "VIN3" } });

      // Walk forward with limit=2 under ?conflicted=1
      const visited = new Set<number>();
      let cursor: string | null = null;
      let pageCount = 0;

      do {
        const qs = cursor ? `conflicted=1&limit=2&cursor=${cursor}` : "conflicted=1&limit=2";
        const page = await request(app)
          .get(`/api/schemas/car/entries?${qs}`)
          .set("Authorization", `Bearer ${token}`);
        expect(page.status).toBe(200);
        pageCount++;

        for (const entry of page.body.entries) {
          expect(visited.has(entry.id)).toBe(false); // no duplicates
          visited.add(entry.id);
          expect(entry.conflict).toBe(true);
        }
        cursor = page.body.pagination.nextCursor;
      } while (cursor !== null);

      // Should have visited exactly 3 conflicted entries across pages
      expect(visited.size).toBe(3);
      expect(pageCount).toBeGreaterThan(1); // forced multiple pages with limit=2
    });
  });
});
