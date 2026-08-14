import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/db/database";
import { SchemaService } from "../src/services/schemaService";
import {
  ContentService,
  ContentServiceError,
} from "../src/services/contentService";
import type { FieldInput } from "../src/types";
import { MAX_LIMIT } from "../src/types";

function setup() {
  const db = openDatabase();
  const schemaService = new SchemaService(db);
  const contentService = new ContentService(db);
  return { db, schemaService, contentService };
}

function makeSchema(ss: SchemaService, name: string, fields: FieldInput[]) {
  return ss.create(name, fields, "editor1");
}

function expectStatus(fn: () => unknown, status: number): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    throw new Error(`expected fn to throw with status ${status}, but it did not throw`);
  }
  expect((caught as ContentServiceError).statusCode).toBe(status);
}

describe("ContentService", () => {
  describe("serialization (§7 example)", () => {
    it("create()/listForSchema() expose the editor field_id-keyed shape; public API exposes the §7 label-keyed enriched shape (ids 12-16)", () => {
      const { schemaService, contentService } = setup();

      makeSchema(schemaService, "person", [
        { label: "name", type: "text", required: true },
      ]);
      makeSchema(
        schemaService,
        "filler",
        Array.from({ length: 10 }, (_, i) => ({
          label: `pad${i}`,
          type: "text" as const,
          required: i === 0,
        }))
      );
      const car = makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
        { label: "year", type: "number", required: false },
        { label: "active", type: "boolean", required: false },
        { label: "built", type: "date", required: false },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ]);
      expect(car.fields.map((f) => f.id)).toEqual([12, 13, 14, 15, 16]);

      const personEntry = contentService.create("person", { "1": "Alice" }, "editor1");

      const entry = contentService.create(
        "car",
        {
          "12": "Civic",
          "13": 2019,
          "14": true,
          "15": "2021-05-04",
          "16": personEntry.id,
        },
        "editor1"
      );

      // Editor routes serialize values keyed by String(field_id), with schema-ref
      // values as the raw target content-id number (no {id, schema} enrichment).
      expect(entry.values).toEqual({
        "12": "Civic",
        "13": 2019,
        "14": true,
        "15": "2021-05-04",
        "16": personEntry.id,
      });
      expect(Object.keys(entry).sort()).toEqual([
        "created_by",
        "creation_date",
        "id",
        "last_modified_by",
        "last_modified_date",
        "schema",
        "schema_version",
        "values",
      ]);
      expect(entry.schema).toBe("car");
      expect(entry.schema_version).toBe(1);

      // The editor list serializes the same field_id-keyed shape
      expect(contentService.listForSchema("car")[0].values).toEqual(entry.values);

      // The public API serializes the §7 label-keyed, enriched shape
      expect(contentService.listPublic("car")[0].values).toEqual({
        make: "Civic",
        year: 2019,
        active: true,
        built: "2021-05-04",
        owner: { id: personEntry.id, schema: "person" },
      });
      expect(contentService.getPublic("car", entry.id).values.owner).toEqual({
        id: personEntry.id,
        schema: "person",
      });
    });
  });

  describe("validation (R16)", () => {
    it("missing required field → 422", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
      ]);

      expectStatus(() => contentService.create("car", {}, "editor1"), 422);
    });

    it("required text set to empty string → 422", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
      ]);

      expectStatus(() => contentService.create("car", { "1": "" }, "editor1"), 422);
    });

    it("unknown field_id → 422", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
      ]);

      expectStatus(
        () => contentService.create("car", { "1": "Civic", "999": "x" }, "editor1"),
        422
      );
    });

    it("schema-ref pointing at a non-existent entry → 422", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "person", [
        { label: "name", type: "text", required: true },
      ]);
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ]);

      expectStatus(
        () => contentService.create("car", { "2": "Civic", "3": 99999 }, "editor1"),
        422
      );
    });

    it("schema-ref pointing at an entry of the wrong schema → 422", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "person", [
        { label: "name", type: "text", required: true },
      ]);
      makeSchema(schemaService, "company", [
        { label: "name", type: "text", required: true },
      ]);
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ]);

      const companyEntry = contentService.create("company", { "2": "Acme" }, "editor1");

      expectStatus(
        () => contentService.create("car", { "3": "Civic", "4": companyEntry.id }, "editor1"),
        422
      );
    });

    it("schema-ref FK constraint fires when target is raw-deleted between validation and insert → 422", () => {
      const { db, schemaService, contentService } = setup();
      makeSchema(schemaService, "person", [
        { label: "name", type: "text", required: true },
      ]);
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ]);

      const personEntry = contentService.create("person", { "1": "Alice" }, "editor1");

      // Simulate a concurrent delete: raw DELETE the target entry from the DB,
      // bypassing the service layer. The FK constraint should fire during insert
      // and be converted to a 422 instead of a raw 500 SqliteError.
      db.prepare("DELETE FROM content WHERE id = ?").run(personEntry.id);

      expectStatus(
        () => contentService.create("car", { "2": "Civic", "3": personEntry.id }, "editor1"),
        422
      );
    });

    it("invalid types are rejected → 422", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
        { label: "year", type: "number", required: false },
        { label: "built", type: "date", required: false },
        { label: "active", type: "boolean", required: false },
      ]);

      expectStatus(() => contentService.create("car", { "2": "not-a-number" }, "editor1"), 422);
      expectStatus(() => contentService.create("car", { "3": "not-a-date" }, "editor1"), 422);
      expectStatus(() => contentService.create("car", { "4": "yes" }, "editor1"), 422);
    });

    it("unknown schema → 404", () => {
      const { contentService } = setup();
      expectStatus(() => contentService.create("nope", {}, "editor1"), 404);
      expectStatus(() => contentService.listForSchema("nope"), 404);
      expectStatus(() => contentService.listPublic("nope"), 404);
      expectStatus(() => contentService.getPublic("nope", 1), 404);
    });
  });

  describe("coercion on save (R17)", () => {
    it("number→text carries the value over as a coerced string", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "car", [
        { label: "year", type: "number", required: true },
      ]);

      const entry = contentService.create("car", { "1": 2019 }, "editor1");

      schemaService.update(
        "car",
        [{ id: 1, label: "year", type: "text", required: true }],
        "editor1"
      );

      const updated = contentService.update(entry.id, {}, "editor1");
      expect(updated.values["1"]).toBe("2019");
      expect(updated.schema_version).toBe(2);
    });

    it("text→number rejects the save with 422 until a valid number is provided", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "car", [
        { label: "year", type: "text", required: true },
      ]);

      const entry = contentService.create("car", { "1": "2019" }, "editor1");

      schemaService.update(
        "car",
        [{ id: 1, label: "year", type: "number", required: true }],
        "editor1"
      );

      expectStatus(() => contentService.update(entry.id, {}, "editor1"), 422);

      const fixed = contentService.update(entry.id, { "1": 2019 }, "editor1");
      expect(fixed.values["1"]).toBe(2019);
      expect(fixed.schema_version).toBe(2);
    });
  });

  describe("conflict tracking (R17, R19)", () => {
    it("editing a conflicted entry resolves the conflict", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
      ]);

      const entry = contentService.create("car", { "1": "Civic" }, "editor1");

      schemaService.update(
        "car",
        [
          { id: 1, label: "make", type: "text", required: true },
          { label: "vin", type: "text", required: true },
        ],
        "editor1"
      );

      expect(contentService.listForSchema("car")[0].conflict).toBe(true);
      expectStatus(() => contentService.getPublic("car", entry.id), 422);

      contentService.update(entry.id, { "2": "VIN123" }, "editor1");

      expect(contentService.listForSchema("car")[0].conflict).toBe(false);
      expect(contentService.getPublic("car", entry.id).values.make).toBe("Civic");
      expect(contentService.getPublic("car", entry.id).values.vin).toBe("VIN123");
    });

    it("listForSchema returns all entries with a conflict flag; listPublic only valid ones", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
      ]);

      const e1 = contentService.create("car", { "1": "A" }, "editor1");
      const e2 = contentService.create("car", { "1": "B" }, "editor1");

      schemaService.update(
        "car",
        [
          { id: 1, label: "make", type: "text", required: true },
          { label: "vin", type: "text", required: true },
        ],
        "editor1"
      );

      contentService.update(e1.id, { "2": "X" }, "editor1");

      const all = contentService.listForSchema("car");
      expect(all.length).toBe(2);
      const byId = new Map(all.map((e) => [e.id, e.conflict]));
      expect(byId.get(e1.id)).toBe(false);
      expect(byId.get(e2.id)).toBe(true);

      const publicList = contentService.listPublic("car");
      expect(publicList.map((e) => e.id)).toEqual([e1.id]);
      expect(publicList[0]).not.toHaveProperty("conflict");
    });
  });

  describe("schema-ref storage in content_refs (PLAN-26)", () => {
    function makePersonCar(schemaService: SchemaService) {
      makeSchema(schemaService, "person", [
        { label: "name", type: "text", required: true },
      ]);
      return makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ]);
    }

    it("stores a schema-ref target as an integer row in content_refs and not as a JSON number in content_rows", () => {
      const { db, schemaService, contentService } = setup();
      const car = makePersonCar(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;

      const personEntry = contentService.create("person", { "1": "Alice" }, "editor1");
      const carEntry = contentService.create(
        "car",
        { [String(makeField.id)]: "Civic", [String(ownerField.id)]: personEntry.id },
        "editor1"
      );

      const refRows = db
        .prepare(
          "SELECT field_id, target_content_id FROM content_refs WHERE content_id = ?"
        )
        .all(carEntry.id) as { field_id: number; target_content_id: number }[];
      expect(refRows).toEqual([
        { field_id: ownerField.id, target_content_id: personEntry.id },
      ]);

      // No dual storage: the schema-ref field id must not appear in content_rows.
      const ownerScalarRow = db
        .prepare(
          "SELECT value FROM content_rows WHERE content_id = ? AND field_id = ?"
        )
        .get(carEntry.id, ownerField.id);
      expect(ownerScalarRow).toBeUndefined();

      // The scalar field is still stored as a JSON string in content_rows.
      const makeValue = (
        db
          .prepare(
            "SELECT value FROM content_rows WHERE content_id = ? AND field_id = ?"
          )
          .get(carEntry.id, makeField.id) as { value: string }
      ).value;
      expect(JSON.parse(makeValue)).toBe("Civic");
    });

    it("round-trips a schema-ref: editor reads the raw target id, public reads {id, schema}", () => {
      const { schemaService, contentService } = setup();
      const car = makePersonCar(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;

      const personEntry = contentService.create("person", { "1": "Alice" }, "editor1");
      const carEntry = contentService.create(
        "car",
        { [String(makeField.id)]: "Civic", [String(ownerField.id)]: personEntry.id },
        "editor1"
      );

      // Editor shape: values keyed by String(field_id) with the raw target number.
      expect(contentService.listForSchema("car")[0].values).toEqual({
        [String(makeField.id)]: "Civic",
        [String(ownerField.id)]: personEntry.id,
      });

      // Public shape: values keyed by label, schema-ref enriched to {id, schema}.
      const expectedPublic = {
        make: "Civic",
        owner: { id: personEntry.id, schema: "person" },
      };
      expect(contentService.listPublic("car")[0].values).toEqual(expectedPublic);
      expect(contentService.getPublic("car", carEntry.id).values).toEqual(expectedPublic);
    });

    it("retargets a schema-ref on update: exactly one ref row pointing at the new target, no scalar row", () => {
      const { db, schemaService, contentService } = setup();
      const car = makePersonCar(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;

      const personA = contentService.create("person", { "1": "Alice" }, "editor1");
      const personB = contentService.create("person", { "1": "Bob" }, "editor1");
      const carEntry = contentService.create(
        "car",
        { [String(makeField.id)]: "Civic", [String(ownerField.id)]: personA.id },
        "editor1"
      );

      contentService.update(
        carEntry.id,
        { [String(ownerField.id)]: personB.id },
        "editor1"
      );

      const refRows = db
        .prepare(
          "SELECT field_id, target_content_id FROM content_refs WHERE content_id = ?"
        )
        .all(carEntry.id) as { field_id: number; target_content_id: number }[];
      expect(refRows).toEqual([
        { field_id: ownerField.id, target_content_id: personB.id },
      ]);

      const ownerScalarRow = db
        .prepare(
          "SELECT value FROM content_rows WHERE content_id = ? AND field_id = ?"
        )
        .get(carEntry.id, ownerField.id);
      expect(ownerScalarRow).toBeUndefined();

      expect(contentService.listForSchema("car")[0].values).toEqual({
        [String(makeField.id)]: "Civic",
        [String(ownerField.id)]: personB.id,
      });
    });

    it("clearing an optional schema-ref to null leaves zero content_refs rows for that field", () => {
      const { db, schemaService, contentService } = setup();
      const car = makePersonCar(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;

      const personEntry = contentService.create("person", { "1": "Alice" }, "editor1");
      const carEntry = contentService.create(
        "car",
        { [String(makeField.id)]: "Civic", [String(ownerField.id)]: personEntry.id },
        "editor1"
      );

      contentService.update(carEntry.id, { [String(ownerField.id)]: null }, "editor1");

      const refRows = db
        .prepare(
          "SELECT field_id, target_content_id FROM content_refs WHERE content_id = ? AND field_id = ?"
        )
        .all(carEntry.id, ownerField.id);
      expect(refRows).toEqual([]);

      // Serialization mirrors the absent-value behavior: the key is omitted.
      expect(contentService.getPublic("car", carEntry.id).values).toEqual({
        make: "Civic",
      });
    });
  });

  describe("delete (R22 cascade)", () => {
    it("removes the entry and its content_rows", () => {
      const { db, schemaService, contentService } = setup();
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
      ]);

      const entry = contentService.create("car", { "1": "Civic" }, "editor1");

      contentService.delete(entry.id);

      const contentRow = db.prepare("SELECT 1 FROM content WHERE id = ?").get(entry.id);
      expect(contentRow).toBeUndefined();
      const rows = db.prepare("SELECT 1 FROM content_rows WHERE content_id = ?").get(entry.id);
      expect(rows).toBeUndefined();

      expectStatus(() => contentService.getPublic("car", entry.id), 404);
    });

    it("deleting an unknown entry → 404", () => {
      const { contentService } = setup();
      expectStatus(() => contentService.delete(9999), 404);
    });
  });

  describe("delete (R34 clear-then-delete)", () => {
    function makePersonCar(schemaService: SchemaService) {
      makeSchema(schemaService, "person", [
        { label: "name", type: "text", required: true },
      ]);
      return makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
      ]);
    }

    function deleteError(
      contentService: ContentService,
      entryId: number
    ): ContentServiceError | undefined {
      try {
        contentService.delete(entryId);
      } catch (err) {
        return err as ContentServiceError;
      }
      return undefined;
    }

    it("clears refs and deletes when two entries reference a target", () => {
      const { db, schemaService, contentService } = setup();
      const car = makePersonCar(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;

      const person = contentService.create("person", { "1": "Alice" }, "editor1");
      contentService.create(
        "car",
        { [String(makeField.id)]: "Civic", [String(ownerField.id)]: person.id },
        "editor1"
      );
      contentService.create(
        "car",
        { [String(makeField.id)]: "Accord", [String(ownerField.id)]: person.id },
        "editor1"
      );

      // No error — delete succeeds and clears the refs.
      expect(deleteError(contentService, person.id)).toBeUndefined();
      const contentRow = db.prepare("SELECT 1 FROM content WHERE id = ?").get(person.id);
      expect(contentRow).toBeUndefined();
    });

    it("clears cross-schema refs on delete", () => {
      const { db, schemaService, contentService } = setup();
      const car = makePersonCar(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;

      const person = contentService.create("person", { "1": "Alice" }, "editor1");
      contentService.create(
        "car",
        { [String(makeField.id)]: "Civic", [String(ownerField.id)]: person.id },
        "editor1"
      );

      // No error — delete succeeds and clears the ref.
      expect(deleteError(contentService, person.id)).toBeUndefined();
      const contentRow = db.prepare("SELECT 1 FROM content WHERE id = ?").get(person.id);
      expect(contentRow).toBeUndefined();
    });

    it("deleting an unreferenced entry succeeds", () => {
      const { schemaService, contentService } = setup();
      makePersonCar(schemaService);

      const person = contentService.create("person", { "1": "Alice" }, "editor1");
      expect(deleteError(contentService, person.id)).toBeUndefined();
      expect(contentService.getEntryMeta(person.id)).toBeNull();
    });

    it("clears refs when one entry with two schema-ref fields targets the same entry", () => {
      const { db, schemaService, contentService } = setup();
      makeSchema(schemaService, "person", [
        { label: "name", type: "text", required: true },
      ]);
      const car = makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
        { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
        { label: "co_owner", type: "schema-ref", required: false, ref_schema: "person" },
      ]);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;
      const coOwnerField = car.fields.find((f) => f.label === "co_owner")!;

      const person = contentService.create("person", { "1": "Alice" }, "editor1");
      contentService.create(
        "car",
        {
          [String(makeField.id)]: "Civic",
          [String(ownerField.id)]: person.id,
          [String(coOwnerField.id)]: person.id,
        },
        "editor1"
      );

      // No error — delete succeeds and clears both ref rows.
      expect(deleteError(contentService, person.id)).toBeUndefined();
      const contentRow = db.prepare("SELECT 1 FROM content WHERE id = ?").get(person.id);
      expect(contentRow).toBeUndefined();
    });

    it("exposes referencer_count on the editor list shape (distinct referencing entries)", () => {
      const { schemaService, contentService } = setup();
      const car = makePersonCar(schemaService);
      const makeField = car.fields.find((f) => f.label === "make")!;
      const ownerField = car.fields.find((f) => f.label === "owner")!;

      const car1 = contentService.create(
        "car",
        { [String(makeField.id)]: "Civic" },
        "editor1"
      );
      const person = contentService.create("person", { "1": "Alice" }, "editor1");
      const car2 = contentService.create(
        "car",
        { [String(makeField.id)]: "Accord", [String(ownerField.id)]: person.id },
        "editor1"
      );

      const byId = new Map(
        contentService.listForSchema("car").map((e) => [e.id, e.referencer_count])
      );
      expect(byId.get(car1.id)).toBe(0);
      expect(byId.get(car2.id)).toBe(0);
      expect(contentService.listForSchema("person")[0].referencer_count).toBe(1);
    });
  });

  describe("pagination", () => {
    function makeCarEntries(
      schemaService: SchemaService,
      contentService: ContentService,
      count: number
    ) {
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
      ]);
      const ids: number[] = [];
      for (let i = 0; i < count; i++) {
        const e = contentService.create(
          "car",
          { "1": `Car ${i}` },
          "editor1"
        );
        ids.push(e.id);
      }
      return ids;
    }

    it("returns entries in ascending id order by default", () => {
      const { schemaService, contentService } = setup();
      const ids = makeCarEntries(schemaService, contentService, 5);

      const result = contentService.listForSchema("car", {});
      expect(result.pagination.nextCursor).toBeNull();
      expect(result.pagination.prevCursor).toBeNull();
      expect(result.entries.map((e) => e.id)).toEqual(ids);
    });

    it("limit clamps: 0 → 1, 999 → MAX_LIMIT, negative → 1", () => {
      const { schemaService, contentService } = setup();
      makeCarEntries(schemaService, contentService, 10);

      expect(contentService.listForSchema("car", { limit: 0 }).entries).toHaveLength(1);
      expect(contentService.listForSchema("car", { limit: -5 }).entries).toHaveLength(1);
      // Only 10 entries exist; limit=999 clamps to MAX_LIMIT but only 10 are returned
      expect(
        contentService.listForSchema("car", { limit: 999 }).entries
      ).toHaveLength(10);
    });

    it("forward pagination: nextCursor set when more entries exist", () => {
      const { schemaService, contentService } = setup();
      const ids = makeCarEntries(schemaService, contentService, 5);

      const page1 = contentService.listForSchema("car", { limit: 2 });
      expect(page1.entries.map((e) => e.id)).toEqual(ids.slice(0, 2));
      expect(page1.pagination.nextCursor).toBe(ids[1]);
      expect(page1.pagination.prevCursor).toBeNull();
    });

    it("forward pagination: second page via cursor", () => {
      const { schemaService, contentService } = setup();
      const ids = makeCarEntries(schemaService, contentService, 5);

      const page1 = contentService.listForSchema("car", { limit: 2 });
      const page2 = contentService.listForSchema("car", {
        limit: 2,
        cursor: page1.pagination.nextCursor!,
      });
      expect(page2.entries.map((e) => e.id)).toEqual(ids.slice(2, 4));
      expect(page2.pagination.nextCursor).toBe(ids[3]);
      expect(page2.pagination.prevCursor).toBe(ids[2]);
    });

    it("forward pagination: last page has nextCursor null", () => {
      const { schemaService, contentService } = setup();
      const ids = makeCarEntries(schemaService, contentService, 5);

      const page1 = contentService.listForSchema("car", { limit: 2 });
      const page2 = contentService.listForSchema("car", {
        limit: 2,
        cursor: page1.pagination.nextCursor!,
      });
      const page3 = contentService.listForSchema("car", {
        limit: 2,
        cursor: page2.pagination.nextCursor!,
      });
      expect(page3.entries.map((e) => e.id)).toEqual(ids.slice(4));
      expect(page3.pagination.nextCursor).toBeNull();
      expect(page3.pagination.prevCursor).toBe(ids[4]);
    });

    it("backward pagination via direction=backward", () => {
      const { schemaService, contentService } = setup();
      const ids = makeCarEntries(schemaService, contentService, 5);

      // Start from a cursor beyond the first page
      const page1 = contentService.listForSchema("car", { limit: 2 });
      const page2 = contentService.listForSchema("car", {
        limit: 2,
        cursor: page1.pagination.nextCursor!,
      });

      // Go backward from page2's first entry
      const back = contentService.listForSchema("car", {
        limit: 2,
        cursor: page2.entries[0].id,
        direction: "backward",
      });
      expect(back.entries.map((e) => e.id)).toEqual(ids.slice(0, 2));
      expect(back.pagination.prevCursor).toBeNull();
      expect(back.pagination.nextCursor).toBe(ids[1]);
    });

    it("exact multiple of limit: last page has nextCursor null", () => {
      const { schemaService, contentService } = setup();
      const ids = makeCarEntries(schemaService, contentService, 4);

      const page1 = contentService.listForSchema("car", { limit: 2 });
      expect(page1.pagination.nextCursor).toBe(ids[1]);

      const page2 = contentService.listForSchema("car", {
        limit: 2,
        cursor: page1.pagination.nextCursor!,
      });
      expect(page2.entries.map((e) => e.id)).toEqual(ids.slice(2));
      expect(page2.pagination.nextCursor).toBeNull();
    });

    it("single entry: both cursors null", () => {
      const { schemaService, contentService } = setup();
      makeCarEntries(schemaService, contentService, 1);

      const result = contentService.listForSchema("car", { limit: 10 });
      expect(result.entries).toHaveLength(1);
      expect(result.pagination.nextCursor).toBeNull();
      expect(result.pagination.prevCursor).toBeNull();
    });

    it("empty schema returns empty entries with null cursors", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
      ]);

      const result = contentService.listForSchema("car", { limit: 10 });
      expect(result.entries).toEqual([]);
      expect(result.pagination).toEqual({ nextCursor: null, prevCursor: null });
    });

    it("invalid cursor (non-numeric) treated as no cursor", () => {
      const { schemaService, contentService } = setup();
      const ids = makeCarEntries(schemaService, contentService, 3);

      // parseCursor returns null for NaN → treated as first page
      const result = contentService.listForSchema("car", {
        limit: 2,
        cursor: NaN,
      });
      expect(result.entries.map((e) => e.id)).toEqual(ids.slice(0, 2));
      expect(result.pagination.prevCursor).toBeNull();
    });

    it("cursor beyond data returns empty entries with null cursors", () => {
      const { schemaService, contentService } = setup();
      makeCarEntries(schemaService, contentService, 3);

      const result = contentService.listForSchema("car", {
        limit: 10,
        cursor: 9999,
      });
      expect(result.entries).toEqual([]);
      expect(result.pagination).toEqual({ nextCursor: null, prevCursor: null });
    });

    it("listPublic pagination returns only compat entries", () => {
      const { schemaService, contentService } = setup();
      makeSchema(schemaService, "car", [
        { label: "make", type: "text", required: true },
      ]);

      const e1 = contentService.create("car", { "1": "A" }, "editor1");
      const e2 = contentService.create("car", { "1": "B" }, "editor1");

      // Make e2 conflicted by bumping compat_version
      schemaService.update(
        "car",
        [
          { id: 1, label: "make", type: "text", required: true },
          { label: "vin", type: "text", required: true },
        ],
        "editor1"
      );
      contentService.update(e1.id, { "2": "VIN" }, "editor1");

      // listForSchema returns both
      const editorResult = contentService.listForSchema("car", { limit: 10 });
      expect(editorResult.entries).toHaveLength(2);

      // listPublic returns only the resolved entry
      const publicResult = contentService.listPublic("car", { limit: 10 });
      expect(publicResult.entries).toHaveLength(1);
      expect(publicResult.entries[0].id).toBe(e1.id);
      expect(publicResult.pagination.nextCursor).toBeNull();
    });
  });
});
