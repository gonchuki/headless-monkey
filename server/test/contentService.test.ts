import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/db/database";
import { SchemaService } from "../src/services/schemaService";
import {
  ContentService,
  ContentServiceError,
} from "../src/services/contentService";
import type { FieldInput } from "../src/types";

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
    it("exposes the full §4 shape and §7 values keyed by field id (ids 12-16)", () => {
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
      expect(contentService.getPublic("car", entry.id).values["1"]).toBe("Civic");
      expect(contentService.getPublic("car", entry.id).values["2"]).toBe("VIN123");
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
});
