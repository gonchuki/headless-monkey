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
      makeCarSchema(schemaService);

      const res = await request(app).get("/api/content/car");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
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
      expect(res.body.values.make).toBe("Civic");
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
      expect(list.body.length).toBe(1);
      expect(list.body[0].id).toBe(e1.body.id);
      expect(list.body[0].values.make).toBe("Civic");
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
      expect(res.body.id).toBe(created.body.id);
      expect(res.body.schema).toBe("car");
      expect(res.body.schema_version).toBe(1);
      expect(res.body.values).toEqual({ make: "Civic" });
      expect(res.body).not.toHaveProperty("conflict");
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
      expect(res.body.values).toEqual({
        make: "Civic",
        owner: { id: person.body.id, schema: "person" },
      });
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
      expect((await request(app).patch("/api/entries/1")).status).toBe(401);
      expect((await request(app).delete("/api/entries/1")).status).toBe(401);
    });

    it("returns 403 for an admin token", async () => {
      const { app } = createTestApp();
      const auth = { Authorization: `Bearer ${adminToken()}` };
      expect((await request(app).get("/api/schemas/car/entries").set(auth)).status).toBe(403);
      expect((await request(app).post("/api/schemas/car/entries").set(auth)).status).toBe(403);
      expect((await request(app).patch("/api/entries/1").set(auth)).status).toBe(403);
      expect((await request(app).delete("/api/entries/1").set(auth)).status).toBe(403);
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

  describe("editor delete blocks referenced entries (R34)", () => {
    it("returns 409 naming the referencer count for a referenced entry; 204 for an unreferenced one", async () => {
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

      const blocked = await request(app)
        .delete(`/api/entries/${personRes.body.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toContain("1");

      const ok = await request(app)
        .delete(`/api/entries/${carRes.body.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(ok.status).toBe(204);
    });
  });
});
