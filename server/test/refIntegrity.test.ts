import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import express from "express";
import { createApp } from "../src/app";
import { openDatabase, type Db } from "../src/db/database";
import { SchemaService } from "../src/services/schemaService";
import type { SchemaEntry } from "../src/types";

/**
 * PLAN-29 — Read-path referential-integrity proofs.
 *
 * Proves the public read path cannot emit a dangling schema-ref — a public
 * `{id, schema}` value whose target entry does not exist in `content` (or
 * belongs to a different schema than the field's `ref_schema`). The guarantee
 * is enforced by construction (R34 blocked delete, R35 retarget purge, and the
 * `content_refs.target_content_id` ON DELETE RESTRICT FK); this file pins that
 * guarantee from the public route surface.
 *
 * Self-reference note (plan edge case): entry-level self-reference is NOT
 * tested here. `checkCycle` (R10) rejects a schema-ref field pointing at its
 * own schema, so an entry can never reference an entry in its own schema at
 * write time. Do not "fix" the editor shape to hand self-refs in this file.
 */

function createTestApp() {
  const db = openDatabase();
  const app = createApp(db);
  const schemaService = new SchemaService(db);
  return { app, db, schemaService };
}

function editorToken(): string {
  return jwt.sign({ sub: "editor1", role: "editor" }, "test-secret", { expiresIn: "8h" });
}

interface PublicEntryBody {
  id: number;
  schema: string;
  schema_version: number;
  values: Record<string, unknown>;
}

function isSchemaRef(value: unknown): value is { id: number; schema: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "schema" in value &&
    typeof (value as { id: unknown }).id === "number" &&
    typeof (value as { schema: unknown }).schema === "string"
  );
}

/**
 * Core invariant (AC 2). For one served public entry:
 * 1. Every schema-ref value `{id, schema}` in `values` must resolve to a
 *    `content` row whose `schema` column equals the emitted `schema` name.
 * 2. Every *required* schema-ref field on the schema version being served must
 *    actually have a key in `values` — the green-while-broken guard. Without
 *    this second pass, a test that only iterates the schema-ref values present
 *    in the response stays green if a regression un-conflicts an entry whose
 *    required ref key was purged away.
 *
 * v0.7 shape: entry `values` are keyed by `String(field_id)`; the walker must
 * resolve those keys to fields (the guard must fail on a missing required key).
 */
function assertNoDanglingRefs(db: Db, schema: SchemaEntry, entry: PublicEntryBody): void {
  const where = `entry ${entry.id} (schema ${schema.name})`;

  const fieldsById = new Map(schema.fields.map((f) => [String(f.id), f]));
  for (const [fieldIdKey, value] of Object.entries(entry.values)) {
    if (!isSchemaRef(value)) continue;
    const label = fieldsById.get(fieldIdKey)?.label ?? fieldIdKey;
    const target = db
      .prepare("SELECT schema FROM content WHERE id = ?")
      .get(value.id) as { schema: string } | undefined;
    expect(
      target,
      `${where}: schema-ref '${label}' points at missing content id ${value.id}`
    ).toBeDefined();
    expect(
      target!.schema,
      `${where}: schema-ref '${label}' (field ${fieldIdKey}) emits schema '${value.schema}' but content id ${value.id} belongs to schema '${target!.schema}'`
    ).toBe(value.schema);
  }

  for (const field of schema.fields) {
    if (field.type !== "schema-ref" || !field.required) continue;
    expect(
      entry.values,
      `${where}: required schema-ref '${field.label}' (field_id ${field.id}) key absent on a served entry`
    ).toHaveProperty(String(field.id));
  }
}

/**
 * Runs the invariant against both public reads: the (R18) list endpoint and
 * every (R19) `:id` single-entry lookup, on the v0.7 {meta, entries} wrapper.
 * Returns the entries array for the caller.
 */
async function expectPublicReadClean(
  app: express.Express,
  db: Db,
  schemaService: SchemaService,
  schemaName: string
): Promise<PublicEntryBody[]> {
  const schema = schemaService.get(schemaName);
  expect(schema).not.toBeNull();

  const res = await request(app).get(`/api/content/${schemaName}`);
  expect(res.status).toBe(200);
  const body = res.body as { meta: { name: string }; entries: PublicEntryBody[] };
  expect(body.meta).toBeDefined();
  expect(body.meta.name).toBe(schemaName);
  expect(Array.isArray(body.entries)).toBe(true);
  for (const entry of body.entries) {
    assertNoDanglingRefs(db, schema!, entry);

    const single = await request(app).get(`/api/content/${schemaName}/${entry.id}`);
    expect(single.status).toBe(200);
    const singleBody = single.body as { meta: { name: string }; entries: PublicEntryBody[] };
    expect(singleBody.meta.name).toBe(schemaName);
    expect(singleBody.entries).toHaveLength(1);
    assertNoDanglingRefs(db, schema!, singleBody.entries[0]);
  }
  return body.entries;
}

/** person + car (owner → person, optional) fixture used by the R34/R35 scenarios. */
function makePersonCar(schemaService: SchemaService) {
  const person = schemaService.create(
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
  return {
    person,
    car,
    nameField: person.fields.find((f) => f.label === "name")!,
    makeField: car.fields.find((f) => f.label === "make")!,
    ownerField: car.fields.find((f) => f.label === "owner")!,
  };
}

describe("Read-path referential integrity proofs (PLAN-29)", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = "test-admin-pass";
    process.env.JWT_SECRET = "test-secret";
  });

  describe("core invariant: public reads cannot emit a dangling schema-ref (AC 2)", () => {
    it("every schema-ref value on listPublic and each getPublic resolves under its schema", async () => {
      const { app, db, schemaService } = createTestApp();
      const token = editorToken();

      const person = schemaService.create(
        "person",
        [{ label: "name", type: "text", required: true }],
        "editor1"
      );
      const company = schemaService.create(
        "company",
        [{ label: "name", type: "text", required: true }],
        "editor1"
      );
      const car = schemaService.create(
        "car",
        [
          { label: "make", type: "text", required: true },
          // required schema-ref — exercises the green-while-broken guard
          { label: "owner", type: "schema-ref", required: true, ref_schema: "person" },
          // optional schema-ref — absence must stay legal
          { label: "garage", type: "schema-ref", required: false, ref_schema: "company" },
        ],
        "editor1"
      );
      const nameField = person.fields.find((f) => f.label === "name")!;
      const companyNameField = company.fields.find((f) => f.label === "name")!;
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;
      const garageField = car.fields.find((f) => f.label === "garage")!;

      const alice = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(nameField.id)]: "Alice" } });
      const bob = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(nameField.id)]: "Bob" } });
      const acme = await request(app)
        .post("/api/schemas/company/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(companyNameField.id)]: "Acme" } });
      expect(alice.status).toBe(201);
      expect(bob.status).toBe(201);
      expect(acme.status).toBe(201);

      const civic = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: alice.body.id,
            [String(garageField.id)]: acme.body.id,
          },
        });
      const accord = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Accord",
            [String(ownerField.id)]: bob.body.id,
            // garage omitted: optional, absence must be legal
          },
        });
      expect(civic.status).toBe(201);
      expect(accord.status).toBe(201);

      const served = await expectPublicReadClean(app, db, schemaService, "car");
      expect(served.map((e) => e.id)).toEqual([civic.body.id, accord.body.id]);

      for (const entry of served) {
        expect(entry.values[String(ownerField.id)]).toEqual(
          entry.id === civic.body.id
            ? { id: alice.body.id, schema: "person" }
            : { id: bob.body.id, schema: "person" }
        );
      }
      const civicPublic = served.find((e) => e.id === civic.body.id)!;
      expect(civicPublic.values[String(garageField.id)]).toEqual({ id: acme.body.id, schema: "company" });
    });
  });

  describe("required schema-ref key guard is pinned (AC 4)", () => {
    it("the walker fails an entry whose required schema-ref key is absent (negative case)", async () => {
      const { db, schemaService } = createTestApp();
      schemaService.create(
        "person",
        [{ label: "name", type: "text", required: true }],
        "editor1"
      );
      const car = schemaService.create(
        "car",
        [
          { label: "make", type: "text", required: true },
          { label: "owner", type: "schema-ref", required: true, ref_schema: "person" },
        ],
        "editor1"
      );
      const makeField = car.fields.find((f) => f.label === "make")!;

      // Public body that resolves every value present (a scalar is harmless)
      // but is missing the required schema-ref key entirely. The walker's
      // green-while-broken guard must reject it — `expect(...).toHaveProperty`
      // fails, which surfaces as the throw this test asserts. Removing or
      // weakening the guard makes this test's toThrow fail.
      const broken: PublicEntryBody = {
        id: 1,
        schema: "car",
        schema_version: 1,
        values: { [String(makeField.id)]: "Civic" },
      };
      expect(() => assertNoDanglingRefs(db, car, broken)).toThrow(
        /required schema-ref 'owner'/
      );
    });
  });

  describe("R34 read-path proof (AC 3)", () => {
    it("a blocked delete keeps refs resolving; after unblocking there are no dangles", async () => {
      const { app, db, schemaService } = createTestApp();
      const { nameField, makeField, ownerField } = makePersonCar(schemaService);
      const token = editorToken();

      const alice = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(nameField.id)]: "Alice" } });
      expect(alice.status).toBe(201);

      const civic = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: alice.body.id,
          },
        });
      const accord = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Accord",
            [String(ownerField.id)]: alice.body.id,
          },
        });
      expect(civic.status).toBe(201);
      expect(accord.status).toBe(201);

      // R34: deleting the referenced target is blocked with 409 naming the count.
      const blocked = await request(app)
        .delete(`/api/entries/${alice.body.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toContain("2");

      // The blocked attempt leaves the reference present and still resolving.
      const afterBlock = await expectPublicReadClean(app, db, schemaService, "car");
      expect(afterBlock.map((e) => e.id)).toEqual([civic.body.id, accord.body.id]);
      for (const entry of afterBlock) {
        expect(entry.values[String(ownerField.id)]).toEqual({ id: alice.body.id, schema: "person" });
      }
      const personAfterBlock = await request(app).get("/api/content/person");
      expect(personAfterBlock.status).toBe(200);
      expect(personAfterBlock.body.entries.map((e: { id: number }) => e.id)).toEqual([alice.body.id]);

      // Delete the referencing car entries; Alice's delete then succeeds.
      for (const entry of [civic, accord]) {
        const del = await request(app)
          .delete(`/api/entries/${entry.body.id}`)
          .set("Authorization", `Bearer ${token}`);
        expect(del.status).toBe(204);
      }
      const delAlice = await request(app)
        .delete(`/api/entries/${alice.body.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(delAlice.status).toBe(204);

      // Public read: both car entries are gone, and no refs dangle anywhere.
      const afterDelete = await expectPublicReadClean(app, db, schemaService, "car");
      expect(afterDelete).toEqual([]);
      const persons = await request(app).get("/api/content/person");
      expect(persons.status).toBe(200);
      expect(persons.body.entries).toEqual([]);
    });
  });

  describe("R35 read-path proof (AC 4)", () => {
    it("retargeting excludes the entry, purges content_refs, and re-saving restores a resolving ref", async () => {
      const { app, db, schemaService } = createTestApp();
      const token = editorToken();

      schemaService.create(
        "company",
        [{ label: "name", type: "text", required: true }],
        "editor1"
      );
      const { person, car, nameField, makeField, ownerField } = makePersonCar(schemaService);
      const companyNameField = schemaService
        .get("company")!
        .fields.find((f) => f.label === "name")!;

      const alice = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(nameField.id)]: "Alice" } });
      const acme = await request(app)
        .post("/api/schemas/company/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(companyNameField.id)]: "Acme" } });
      expect(alice.status).toBe(201);
      expect(acme.status).toBe(201);

      const civic = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: alice.body.id,
          },
        });
      expect(civic.status).toBe(201);
      expect(civic.body.schema_version).toBe(1);

      // Before the retarget the ref resolves.
      const served = await expectPublicReadClean(app, db, schemaService, "car");
      expect(served[0].values[String(ownerField.id)]).toEqual({ id: alice.body.id, schema: "person" });

      // Retarget car.owner from person to company via the public schemas route.
      const retarget = await request(app)
        .patch("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fields: [
            { id: makeField.id, label: "make", type: "text", required: true },
            { id: ownerField.id, label: "owner", type: "schema-ref", required: false, ref_schema: "company" },
          ],
        });
      expect(retarget.status).toBe(200);
      expect(retarget.body.version).toBe(2);
      expect(retarget.body.compat_version).toBe(2);

      // (a) The affected entry is excluded (conflicted) and 422s by id.
      const list = await request(app).get("/api/content/car");
      expect(list.status).toBe(200);
      expect(list.body.entries).toEqual([]);
      const single = await request(app).get(`/api/content/car/${civic.body.id}`);
      expect(single.status).toBe(422);

      // (b) The purge surface is observable directly — not just hidden behind
      // the conflict gate. This fails if PLAN-28's purge were removed.
      const purged = db
        .prepare(
          "SELECT COUNT(*) AS n FROM content_refs WHERE field_id = ? AND content_id = ?"
        )
        .get(ownerField.id, civic.body.id) as { n: number };
      expect(purged.n).toBe(0);

      // No-bump property: schema_version stays below compat_version (1 < 2).
      const stored = db
        .prepare("SELECT schema_version FROM content WHERE id = ?")
        .get(civic.body.id) as { schema_version: number };
      expect(stored.schema_version).toBe(1);

      // (d) The public read never emits {id: <person entry>, schema: "company"}:
      // nothing is served at all while the entry is unresolved.
      expect(list.body.entries).toEqual([]);

      // (c) Re-save with a valid company target un-conflicts the entry.
      const fix = await request(app)
        .patch(`/api/entries/${civic.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: acme.body.id,
          },
        });
      expect(fix.status).toBe(200);

      const after = await expectPublicReadClean(app, db, schemaService, "car");
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(civic.body.id);
      expect(after[0].values[String(ownerField.id)]).toEqual({ id: acme.body.id, schema: "company" });

      const resolvedRef = db
        .prepare(
          "SELECT COUNT(*) AS n FROM content_refs WHERE field_id = ? AND content_id = ? AND target_content_id = ?"
        )
        .get(ownerField.id, civic.body.id, acme.body.id) as { n: number };
      expect(resolvedRef.n).toBe(1);
    });
  });

  describe("DB backstop: raw DELETE on a referenced target (AC 5)", () => {
    it("throws the RESTRICT error and leaves the public read path untouched", async () => {
      const { app, db, schemaService } = createTestApp();
      const { nameField, makeField, ownerField } = makePersonCar(schemaService);
      const token = editorToken();

      const alice = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(nameField.id)]: "Alice" } });
      const civic = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: alice.body.id,
          },
        });
      expect(alice.status).toBe(201);
      expect(civic.status).toBe(201);

      // Raw DELETE bypasses the service 409 — the DB RESTRICT is the last line
      // of defense (PLAN-24's DDL fact, reused, not re-derived here).
      expect(() =>
        db.prepare("DELETE FROM content WHERE id = ?").run(alice.body.id)
      ).toThrow(/FOREIGN KEY constraint failed/);

      // Read-path aftermath: no partial/dangling state is observable.
      const car = await expectPublicReadClean(app, db, schemaService, "car");
      expect(car).toHaveLength(1);
      expect(car[0].values[String(ownerField.id)]).toEqual({ id: alice.body.id, schema: "person" });

      const person = await request(app).get(`/api/content/person/${alice.body.id}`);
      expect(person.status).toBe(200);

      const carSingle = await request(app).get(`/api/content/car/${civic.body.id}`);
      expect(carSingle.status).toBe(200);
    });
  });

  describe("negative would-be dangles (AC 6)", () => {
    it("a deleted target (R34 409) and a retargeted ref (R35 422) never reach the public read", async () => {
      const { app, db, schemaService } = createTestApp();
      const token = editorToken();

      schemaService.create(
        "company",
        [{ label: "name", type: "text", required: true }],
        "editor1"
      );
      const { nameField, makeField, ownerField } = makePersonCar(schemaService);

      const alice = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(nameField.id)]: "Alice" } });
      const civic = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: alice.body.id,
          },
        });
      expect(alice.status).toBe(201);
      expect(civic.status).toBe(201);

      // Case A: would-be dangle #1 — the target was "deleted".
      const blocked = await request(app)
        .delete(`/api/entries/${alice.body.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(blocked.status).toBe(409);

      // Case B: would-be dangle #2 — the ref's schema changed (R35 purge + 422).
      const retarget = await request(app)
        .patch("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fields: [
            { id: makeField.id, label: "make", type: "text", required: true },
            { id: ownerField.id, label: "owner", type: "schema-ref", required: false, ref_schema: "company" },
          ],
        });
      expect(retarget.status).toBe(200);

      // Neither case yields a reference that fails to resolve on the public read:
      const list = await request(app).get("/api/content/car");
      expect(list.status).toBe(200);
      expect(list.body.entries).toEqual([]); // the only car entry is held conflicted
      const single = await request(app).get(`/api/content/car/${civic.body.id}`);
      expect(single.status).toBe(422);

      // And re-saving the stale person target is rejected at the service level.
      const stale = await request(app)
        .patch(`/api/entries/${civic.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: alice.body.id,
          },
        });
      expect(stale.status).toBe(422);
    });
  });

  describe("edge cases (AC 7-8)", () => {
    it("deleting the referencing schema cascades its refs without touching the referenced read", async () => {
      const { app, db, schemaService } = createTestApp();
      const { nameField, makeField, ownerField } = makePersonCar(schemaService);
      const token = editorToken();

      const alice = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(nameField.id)]: "Alice" } });
      const civic = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: alice.body.id,
          },
        });
      expect(alice.status).toBe(201);
      expect(civic.status).toBe(201);

      // Deleting the schema that references person is allowed (nothing references car).
      const del = await request(app)
        .delete("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`);
      expect(del.status).toBe(204);

      // Person's public read is unaffected.
      const person = await request(app).get("/api/content/person");
      expect(person.status).toBe(200);
      expect(person.body.entries.map((e: { id: number }) => e.id)).toEqual([alice.body.id]);

      // No content_refs dangle against the cascade-removed car entries.
      const refCount = db.prepare("SELECT COUNT(*) AS n FROM content_refs").get() as {
        n: number;
      };
      expect(refCount.n).toBe(0);
    });

    it("type-flip retarget (schema-ref → text → schema-ref) never leaks on the public read", async () => {
      const { app, db, schemaService } = createTestApp();
      const token = editorToken();

      schemaService.create(
        "company",
        [{ label: "name", type: "text", required: true }],
        "editor1"
      );
      const { nameField, makeField, ownerField } = makePersonCar(schemaService);
      const companyNameField = schemaService
        .get("company")!
        .fields.find((f) => f.label === "name")!;

      const alice = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(nameField.id)]: "Alice" } });
      const acme = await request(app)
        .post("/api/schemas/company/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { [String(companyNameField.id)]: "Acme" } });
      const civic = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: alice.body.id,
          },
        });
      expect(alice.status).toBe(201);
      expect(acme.status).toBe(201);
      expect(civic.status).toBe(201);

      // Flip 1: schema-ref → text (same field id). No R35 retarget purge: the old
      // type on the *next* step is text, not schema-ref.
      const flip1 = await request(app)
        .patch("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fields: [
            { id: makeField.id, label: "make", type: "text", required: true },
            { id: ownerField.id, label: "owner", type: "text", required: false },
          ],
        });
      expect(flip1.status).toBe(200);

      // Flip 2: text → schema-ref to company.
      const flip2 = await request(app)
        .patch("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fields: [
            { id: makeField.id, label: "make", type: "text", required: true },
            { id: ownerField.id, label: "owner", type: "schema-ref", required: false, ref_schema: "company" },
          ],
        });
      expect(flip2.status).toBe(200);

      // The stale person ref can survive in content_refs (the known PLAN-28
      // scope boundary — the fix is not this plan's feature logic). What must
      // hold is that the public read never emits it: the entry is conflicted.
      const list = await request(app).get("/api/content/car");
      expect(list.status).toBe(200);
      expect(list.body.entries).toEqual([]);
      const single = await request(app).get(`/api/content/car/${civic.body.id}`);
      expect(single.status).toBe(422);

      // Re-saving with the *new* target replaces the stored ref entirely and the
      // entry re-appears with a resolving {id, schema: "company"} value.
      const fix = await request(app)
        .patch(`/api/entries/${civic.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          values: {
            [String(makeField.id)]: "Civic",
            [String(ownerField.id)]: acme.body.id,
          },
        });
      expect(fix.status).toBe(200);

      const after = await expectPublicReadClean(app, db, schemaService, "car");
      expect(after).toHaveLength(1);
      expect(after[0].values[String(ownerField.id)]).toEqual({ id: acme.body.id, schema: "company" });

      const refs = db
        .prepare("SELECT target_content_id FROM content_refs WHERE content_id = ? AND field_id = ?")
        .all(civic.body.id, ownerField.id) as Array<{ target_content_id: number }>;
      expect(refs.map((r) => r.target_content_id)).toEqual([acme.body.id]);
    });
  });
});