import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app";
import { openDatabase, type Db } from "../src/db/database";
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

const AUTH = (token: string) => ({ Authorization: `Bearer ${token}` });

function setModified(db: Db, id: number, date: string): void {
  db.prepare("UPDATE content SET last_modified_date = ? WHERE id = ?").run(date, id);
}

/** Create an entry; `values` is keyed by String(field_id) (the editor write shape). */
async function createEntry(
  app: ReturnType<typeof createApp>,
  token: string,
  schema: string,
  values: Record<string, unknown>
): Promise<number> {
  const res = await request(app)
    .post(`/api/schemas/${schema}/entries`)
    .set(AUTH(token))
    .send({ values });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

/** Field id of the single text field with the given label. */
function fieldId(schema: { fields: { label: string; id: number }[] }, label: string): number {
  return schema.fields.find((f) => f.label === label)!.id;
}

describe("GET /api/content (global index listing, PLAN-77)", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = "test-admin-pass";
    process.env.JWT_SECRET = "test-secret";
  });

  describe("auth", () => {
    it("401 without a token", async () => {
      const { app } = createTestApp();
      const res = await request(app).get("/api/content");
      expect(res.status).toBe(401);
    });

    it("403 with an admin token", async () => {
      const { app } = createTestApp();
      const res = await request(app).get("/api/content").set(AUTH(adminToken()));
      expect(res.status).toBe(403);
    });

    it("200 with an editor token", async () => {
      const { app } = createTestApp();
      const res = await request(app).get("/api/content?limit=10").set(AUTH(editorToken()));
      expect(res.status).toBe(200);
    });
  });

  it("public GET /api/content/<schema> without auth still 200 (mount regression)", async () => {
    const { app, schemaService } = createTestApp();
    schemaService.create("car", [{ label: "make", type: "text", required: true }], "editor1");
    const res = await request(app).get("/api/content/car");
    expect(res.status).toBe(200);
    expect(res.body.schema.name).toBe("car");
  });

  it("global order + cross-schema merge + forward walk visits every entry exactly once", async () => {
    const { app, db, schemaService } = createTestApp();
    const token = editorToken();
    const car = schemaService.create("car", [{ label: "make", type: "text", required: true }], "editor1");
    const pet = schemaService.create("pet", [{ label: "name", type: "text", required: true }], "editor1");
    const city = schemaService.create("city", [{ label: "name", type: "text", required: true }], "editor1");
    const carId = fieldId(car, "make");
    const petId = fieldId(pet, "name");
    const cityId = fieldId(city, "name");

    // 2 / 3 / 4 entries — unequal sizes.
    const car1 = await createEntry(app, token, "car", { [String(carId)]: "Civic" });
    const car2 = await createEntry(app, token, "car", { [String(carId)]: "Accord" });
    const pet1 = await createEntry(app, token, "pet", { [String(petId)]: "Rex" });
    const pet2 = await createEntry(app, token, "pet", { [String(petId)]: "Milo" });
    const pet3 = await createEntry(app, token, "pet", { [String(petId)]: "Duke" });
    const city1 = await createEntry(app, token, "city", { [String(cityId)]: "Oslo" });
    const city2 = await createEntry(app, token, "city", { [String(cityId)]: "Rome" });
    const city3 = await createEntry(app, token, "city", { [String(cityId)]: "Lima" });
    const city4 = await createEntry(app, token, "city", { [String(cityId)]: "Kath" });

    // Interleave modified timestamps ACROSS schemas so the global order is not
    // the per-schema creation order. Newest first:
    // city4, car1, pet1, city3, pet2, car2, city2, pet3, city1
    setModified(db, city4, "2026-01-09T00:00:00.000Z");
    setModified(db, car1, "2026-01-08T00:00:00.000Z");
    setModified(db, pet1, "2026-01-07T00:00:00.000Z");
    setModified(db, city3, "2026-01-06T00:00:00.000Z");
    setModified(db, pet2, "2026-01-05T00:00:00.000Z");
    setModified(db, car2, "2026-01-04T00:00:00.000Z");
    setModified(db, city2, "2026-01-03T00:00:00.000Z");
    setModified(db, pet3, "2026-01-02T00:00:00.000Z");
    setModified(db, city1, "2026-01-01T00:00:00.000Z");

    const expected = [city4, car1, pet1, city3, pet2, car2, city2, pet3, city1];

    // Walk forward with limit=2 until nextCursor is null.
    const pages: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const qs = new URLSearchParams({ limit: "2" });
      if (cursor != null) qs.set("cursor", cursor);
      const res = await request(app).get(`/api/content?${qs.toString()}`).set(AUTH(token));
      expect(res.status).toBe(200);
      pages.push(res.body);
      cursor = res.body.pagination.nextCursor ?? undefined;
      if (cursor == null) break;
    }

    const allIds = pages.flatMap((p) => p.entries.map((e: any) => e.id));
    expect(allIds).toEqual(expected); // global order, every entry exactly once
    // Each page is a slice of <= limit rows; the last page ends the walk.
    pages.forEach((p, i) => {
      const isLast = i === pages.length - 1;
      expect(p.entries.length).toBeLessThanOrEqual(2);
      if (isLast) expect(p.pagination.nextCursor).toBeNull();
      else expect(typeof p.pagination.nextCursor).toBe("string");
    });
    // Page 1 has no prev; later pages do.
    expect(pages[0].pagination.prevCursor).toBeNull();
    pages.slice(1).forEach((p) => expect(typeof p.pagination.prevCursor).toBe("string"));
  });

  it("prevCursor + direction=backward from page 2 returns exactly page 1", async () => {
    const { app, db, schemaService } = createTestApp();
    const token = editorToken();
    const car = schemaService.create("car", [{ label: "make", type: "text", required: true }], "editor1");
    const pet = schemaService.create("pet", [{ label: "name", type: "text", required: true }], "editor1");
    const carId = fieldId(car, "make");
    const petId = fieldId(pet, "name");

    const a = await createEntry(app, token, "car", { [String(carId)]: "A" });
    const b = await createEntry(app, token, "pet", { [String(petId)]: "B" });
    const c = await createEntry(app, token, "car", { [String(carId)]: "C" });
    const d = await createEntry(app, token, "pet", { [String(petId)]: "D" });
    setModified(db, a, "2026-01-04T00:00:00.000Z");
    setModified(db, b, "2026-01-03T00:00:00.000Z");
    setModified(db, c, "2026-01-02T00:00:00.000Z");
    setModified(db, d, "2026-01-01T00:00:00.000Z");

    // Page 1 (limit=2): [a, b]; follow next to page 2: [c, d].
    const p1 = await request(app).get("/api/content?limit=2").set(AUTH(token));
    expect(p1.body.entries.map((e: any) => e.id)).toEqual([a, b]);
    const next = p1.body.pagination.nextCursor as string;

    const p2 = await request(app)
      .get(`/api/content?limit=2&cursor=${encodeURIComponent(next)}`)
      .set(AUTH(token));
    expect(p2.body.entries.map((e: any) => e.id)).toEqual([c, d]);

    // Retreat from page 2 with its prevCursor + direction=backward → exactly page 1.
    const prev = p2.body.pagination.prevCursor as string;
    const back = await request(app)
      .get(`/api/content?limit=2&cursor=${encodeURIComponent(prev)}&direction=backward`)
      .set(AUTH(token));
    expect(back.status).toBe(200);
    expect(back.body.entries.map((e: any) => e.id)).toEqual([a, b]);
    expect(back.body.pagination.prevCursor).toBeNull();
  });

  it("undecodable cursor → 200 first page", async () => {
    const { app, db, schemaService } = createTestApp();
    const token = editorToken();
    const car = schemaService.create("car", [{ label: "make", type: "text", required: true }], "editor1");
    const carId = fieldId(car, "make");
    const a = await createEntry(app, token, "car", { [String(carId)]: "A" });
    const b = await createEntry(app, token, "car", { [String(carId)]: "B" });
    setModified(db, b, "2026-01-02T00:00:00.000Z");
    setModified(db, a, "2026-01-01T00:00:00.000Z");

    const res = await request(app)
      .get("/api/content?limit=1&cursor=not-a-real-cursor")
      .set(AUTH(token));
    expect(res.status).toBe(200);
    // First page of the global modified-desc list.
    expect(res.body.entries.map((e: any) => e.id)).toEqual([b]);
  });

  it("clamps limit (0 → 1, huge → 200, 250 → 200)", async () => {
    const { app, schemaService } = createTestApp();
    const token = editorToken();
    const car = schemaService.create("car", [{ label: "make", type: "text", required: true }], "editor1");
    const carId = fieldId(car, "make");
    for (let i = 0; i < 9; i++) {
      await createEntry(app, token, "car", { [String(carId)]: `M${i}` });
    }

    const zero = await request(app).get("/api/content?limit=0").set(AUTH(token));
    expect(zero.status).toBe(200);
    expect(zero.body.entries).toHaveLength(1);

    const huge = await request(app).get("/api/content?limit=1000000").set(AUTH(token));
    expect(huge.status).toBe(200);
    expect(huge.body.entries).toHaveLength(9);
    expect(huge.body.pagination.nextCursor).toBeNull();

    const over = await request(app).get("/api/content?limit=250").set(AUTH(token));
    expect(over.body.entries).toHaveLength(9);
  });

  it("conflicted=1 returns only conflicting entries across schemas; per-entry conflict is correct", async () => {
    const { app, schemaService } = createTestApp();
    const token = editorToken();
    const car = schemaService.create(
      "car",
      [
        { label: "make", type: "text", required: true },
        { label: "vin", type: "text", required: false },
      ],
      "editor1"
    );
    const pet = schemaService.create("pet", [{ label: "name", type: "text", required: true }], "editor1");

    const carId = fieldId(car, "make");
    const petId = fieldId(pet, "name");
    const car1 = await createEntry(app, token, "car", { [String(carId)]: "Civic" });
    const car2 = await createEntry(app, token, "car", { [String(carId)]: "Accord" });
    const pet1 = await createEntry(app, token, "pet", { [String(petId)]: "Rex" });

    // Breaking change on car only (add a required field) → car entries conflict.
    await request(app)
      .patch("/api/schemas/car")
      .set(AUTH(token))
      .send({
        fields: [
          ...car.fields.map((f) => ({
            id: f.id,
            label: f.label,
            type: f.type,
            required: f.required,
            ...(f.type === "schema-ref" ? { ref_schema: f.ref_schema } : {}),
          })),
          { label: "plate", type: "text", required: true },
        ],
      });

    // conflicted=1: only the two car entries (from the car schema), pet excluded.
    const conflicted = await request(app).get("/api/content?limit=100&conflicted=1").set(AUTH(token));
    expect(conflicted.status).toBe(200);
    expect(conflicted.body.entries.map((e: any) => e.id).sort((x: number, y: number) => x - y)).toEqual(
      [car1, car2].sort((x: number, y: number) => x - y)
    );
    conflicted.body.entries.forEach((e: any) => {
      expect(e.schema).toBe("car");
      expect(e.conflict).toBe(true);
    });

    // Full listing: car entries conflict=true, pet entry conflict=false.
    const full = await request(app).get("/api/content?limit=100").set(AUTH(token));
    expect(full.body.entries).toHaveLength(3);
    const carEntries = full.body.entries.filter((e: any) => e.id === car1 || e.id === car2);
    carEntries.forEach((e: any) => expect(e.conflict).toBe(true));
    const petEntry = full.body.entries.find((e: any) => e.id === pet1);
    expect(petEntry.conflict).toBe(false);
    // Per-entry conflict uses the entry's OWN schema: pet is valid even though car has conflicts.
    expect(petEntry.schema).toBe("pet");
  });

  it("editor shape: values keyed by String(field_id), schema-ref as raw target id, conflict/referencer_count/schema present", async () => {
    const { app, schemaService } = createTestApp();
    const token = editorToken();
    const owner = schemaService.create(
      "owner",
      [{ label: "name", type: "text", required: true }],
      "editor1"
    );
    const pet = schemaService.create(
      "pet",
      [
        { label: "name", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "owner" },
      ],
      "editor1"
    );
    const ownerField = fieldId(owner, "name");
    const petNameField = fieldId(pet, "name");
    const petOwnerField = fieldId(pet, "owner");

    const o1 = await createEntry(app, token, "owner", { [String(ownerField)]: "Ada" });
    await createEntry(app, token, "pet", {
      [String(petNameField)]: "Rex",
      [String(petOwnerField)]: o1,
    });

    const res = await request(app).get("/api/content?limit=10").set(AUTH(token));
    expect(res.status).toBe(200);

    const petEntry = res.body.entries.find((e: any) => e.schema === "pet");
    expect(petEntry).toBeDefined();
    expect(petEntry.values[String(petNameField)]).toBe("Rex");
    // schema-ref value is the RAW target content id (editor shape), not {id, schema}.
    expect(petEntry.values[String(petOwnerField)]).toBe(o1);
    expect(petEntry.conflict).toBe(false);
    expect(typeof petEntry.referencer_count).toBe("number");
    expect(petEntry.schema).toBe("pet");

    const ownerEntry = res.body.entries.find((e: any) => e.id === o1);
    expect(ownerEntry.schema).toBe("owner");
    expect(ownerEntry.values[String(ownerField)]).toBe("Ada");
    // The pet entry references owner → referencer_count 1.
    expect(ownerEntry.referencer_count).toBe(1);
  });

  it("empty state: no schemas → { entries: [], pagination: { nextCursor: null, prevCursor: null } }", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/api/content?limit=10").set(AUTH(editorToken()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [], pagination: { nextCursor: null, prevCursor: null } });
  });

  it("flat branch: no pagination params → flat array (sibling parity)", async () => {
    const { app, schemaService } = createTestApp();
    const token = editorToken();
    const car = schemaService.create("car", [{ label: "make", type: "text", required: true }], "editor1");
    const carId = fieldId(car, "make");
    await createEntry(app, token, "car", { [String(carId)]: "Civic" });

    const res = await request(app).get("/api/content").set(AUTH(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveProperty("conflict");
    expect(res.body[0]).toHaveProperty("referencer_count");
  });
});
