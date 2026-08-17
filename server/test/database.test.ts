import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database";
import { SchemaService } from "../src/services/schemaService";

describe("database file persistence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-monkey-db-"));
  const dbPath = path.join(tempDir, "test.db");

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists data across close and reopen of the same file", () => {
    const db = openDatabase(dbPath);
    const service = new SchemaService(db);
    service.create("car", [
      { label: "make", type: "text", required: true },
      { label: "year", type: "number", required: false },
    ], "editor1");
    db.close();

    // Reopening the same file also exercises that applyMigrations skips the
    // already-applied migrations idempotently.
    const reopened = openDatabase(dbPath);
    const check = new SchemaService(reopened);
    const schema = check.get("car");

    expect(schema?.name).toBe("car");
    expect(schema?.version).toBe(1);
    expect(schema?.fields.length).toBe(2);

    // Close the reopened handle before removing the temp dir: on Windows an
    // open SQLite connection holds its -wal/-shm siblings locked.
    reopened.close();
  });
});

describe("greenfield DDL baseline (PLAN-24)", () => {
  const insertContent = (db: Db, schema: string, schemaVersion: number) => {
    const result = db
      .prepare(
        `INSERT INTO content (schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(schema, schemaVersion, new Date().toISOString(), "editor1", new Date().toISOString(), "editor1");
    return Number(result.lastInsertRowid);
  };

  it("has content_refs, idx_content_refs_target, and foreign_keys enforced", () => {
    const db = openDatabase();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((r) => r.name);
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("schemas");
    expect(tableNames).toContain("schema_fields");
    expect(tableNames).toContain("content");
    expect(tableNames).toContain("content_rows");
    expect(tableNames).toContain("content_refs");

    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_content_refs_target'")
      .get();
    expect(index).not.toBeUndefined();

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    db.close();
  });

  it("cascades a bare DELETE FROM schemas to fields, content, and content_rows", () => {
    const db = openDatabase();

    db.prepare(
      `INSERT INTO schemas (name, creation_date, created_by, last_modified_date, last_modified_by, version, compat_version) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("car", new Date().toISOString(), "editor1", new Date().toISOString(), "editor1", 1, 1);
    db.prepare(
      `INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("car", "make", "text", 1, null, 0);
    db.prepare(
      `INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("car", "color", "text", 0, null, 1);

    const entryId = insertContent(db, "car", 1);
    db.prepare(`INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`).run(entryId, 1, '"red"');
    db.prepare(`INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`).run(entryId, 2, '"blue"');

    // The whole point of the greenfield DDL: one bare DELETE, no manual
    // multi-statement cleanup.
    db.prepare("DELETE FROM schemas WHERE name = ?").run("car");

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM schema_fields WHERE schema = ?").get("car") as { n: number }).n
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM content WHERE schema = ?").get("car") as { n: number }).n
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM content_rows WHERE content_id = ?").get(entryId) as { n: number }).n
    ).toBe(0);

    db.close();
  });

  it("RESTRICTs deletion of a content_refs target but allows unreferenced deletes", () => {
    const db = openDatabase();

    db.prepare(
      `INSERT INTO schemas (name, creation_date, created_by, last_modified_date, last_modified_by, version, compat_version) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("person", new Date().toISOString(), "editor1", new Date().toISOString(), "editor1", 1, 1);
    db.prepare(
      `INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("person", "name", "text", 1, null, 0);

    const personId = insertContent(db, "person", 1);
    const unreferencedPersonId = insertContent(db, "person", 1);

    db.prepare(
      `INSERT INTO schemas (name, creation_date, created_by, last_modified_date, last_modified_by, version, compat_version) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("car", new Date().toISOString(), "editor1", new Date().toISOString(), "editor1", 1, 1);
    db.prepare(
      `INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("car", "owner", "schema-ref", 1, "person", 0);
    db.prepare(
      `INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("car", "make", "text", 1, null, 1);

    const carId = insertContent(db, "car", 1);
    db.prepare(
      `INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`
    ).run(carId, 2, '"Toyota"');

    const ownerFieldId = (
      db.prepare(`SELECT id FROM schema_fields WHERE schema = ? AND label = ?`).get("car", "owner") as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO content_refs (content_id, field_id, target_content_id) VALUES (?, ?, ?)`
    ).run(carId, ownerFieldId, personId);

    // RESTRICT: deleting the referenced target throws a SQLite FK error.
    expect(() =>
      db.prepare("DELETE FROM content WHERE id = ?").run(personId)
    ).toThrow(/FOREIGN KEY constraint failed/);

    // Unreferenced entries delete fine.
    expect(() =>
      db.prepare("DELETE FROM content WHERE id = ?").run(unreferencedPersonId)
    ).not.toThrow();

    db.close();
  });

  it("cascades schema_fields deletion to its content_rows", () => {
    const db = openDatabase();

    db.prepare(
      `INSERT INTO schemas (name, creation_date, created_by, last_modified_date, last_modified_by, version, compat_version) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("car", new Date().toISOString(), "editor1", new Date().toISOString(), "editor1", 1, 1);
    db.prepare(
      `INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("car", "make", "text", 1, null, 0);
    db.prepare(
      `INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("car", "color", "text", 0, null, 1);

    const entryId = insertContent(db, "car", 1);
    db.prepare(`INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`).run(entryId, 1, '"red"');
    db.prepare(`INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`).run(entryId, 2, '"blue"');

    const colorFieldId = (
      db.prepare(`SELECT id FROM schema_fields WHERE schema = ? AND label = ?`).get("car", "color") as { id: number }
    ).id;

    db.prepare("DELETE FROM schema_fields WHERE id = ?").run(colorFieldId);

    const remaining = db
      .prepare(`SELECT field_id FROM content_rows WHERE content_id = ?`)
      .all(entryId) as Array<{ field_id: number }>;
    expect(remaining.map((r) => r.field_id)).toEqual([1]);

    db.close();
  });
});

describe("secondary indexes (PLAN-69)", () => {
  it("creates all four indexes on a fresh database", () => {
    const db = openDatabase();

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((r) => r.name);

    // Pre-existing index from 001_initial_schema
    expect(names).toContain("idx_content_refs_target");
    // Three new indexes from 002_secondary_indexes
    expect(names).toContain("idx_content_schema");
    expect(names).toContain("idx_content_rows_field_id");
    expect(names).toContain("idx_content_refs_field_id");

    db.close();
  });

  it("uses idx_content_schema for WHERE content.schema = ?", () => {
    const db = openDatabase();

    // Seed a row so the plan is meaningful
    db.prepare(
      `INSERT INTO schemas (name, creation_date, created_by, last_modified_date, last_modified_by, version, compat_version) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("car", new Date().toISOString(), "editor1", new Date().toISOString(), "editor1", 1, 1);
    db.prepare(
      `INSERT INTO content (schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("car", 1, new Date().toISOString(), "editor1", new Date().toISOString(), "editor1");

    // Use a literal value instead of ? — EXPLAIN QUERY PLAN does not execute,
    // but better-sqlite3 still validates parameter count on prepare.
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM content WHERE schema = 'car'").all();
    const planStr = JSON.stringify(plan);

    // Index name must appear; bare SCAN of content table must not
    expect(planStr).toContain("idx_content_schema");
    expect(planStr).not.toMatch(/SCAN.*content\b/);

    db.close();
  });

  it("uses idx_content_rows_field_id for WHERE content_rows.field_id = ?", () => {
    const db = openDatabase();

    // Seed schema + field + content so FK constraints are satisfied
    db.prepare(
      `INSERT INTO schemas (name, creation_date, created_by, last_modified_date, last_modified_by, version, compat_version) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("car", new Date().toISOString(), "editor1", new Date().toISOString(), "editor1", 1, 1);
    db.prepare(
      `INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("car", "make", "text", 1, null, 0);
    db.prepare(
      `INSERT INTO content (schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("car", 1, new Date().toISOString(), "editor1", new Date().toISOString(), "editor1");
    db.prepare(
      `INSERT INTO content_rows (content_id, field_id, value) VALUES (?, ?, ?)`
    ).run(1, 1, '"Toyota"');

    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM content_rows WHERE field_id = 1").all();
    const planStr = JSON.stringify(plan);

    expect(planStr).toContain("idx_content_rows_field_id");
    expect(planStr).not.toMatch(/SCAN.*content_rows\b/);

    db.close();
  });

  it("uses idx_content_refs_field_id for WHERE content_refs.field_id = ?", () => {
    const db = openDatabase();

    // Seed: person schema (target), car schema with schema-ref field
    db.prepare(
      `INSERT INTO schemas (name, creation_date, created_by, last_modified_date, last_modified_by, version, compat_version) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("person", new Date().toISOString(), "editor1", new Date().toISOString(), "editor1", 1, 1);
    db.prepare(
      `INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("person", "name", "text", 1, null, 0);
    const personResult = db.prepare(
      `INSERT INTO content (schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("person", 1, new Date().toISOString(), "editor1", new Date().toISOString(), "editor1");
    const personId = Number(personResult.lastInsertRowid);

    db.prepare(
      `INSERT INTO schemas (name, creation_date, created_by, last_modified_date, last_modified_by, version, compat_version) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("car", new Date().toISOString(), "editor1", new Date().toISOString(), "editor1", 1, 1);
    db.prepare(
      `INSERT INTO schema_fields (schema, label, type, required, ref_schema, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("car", "owner", "schema-ref", 1, "person", 0);
    const ownerFieldId = (
      db.prepare(`SELECT id FROM schema_fields WHERE schema = 'car' AND label = 'owner'`).get() as { id: number }
    ).id;

    const carResult = db.prepare(
      `INSERT INTO content (schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("car", 1, new Date().toISOString(), "editor1", new Date().toISOString(), "editor1");
    const carId = Number(carResult.lastInsertRowid);

    db.prepare(
      `INSERT INTO content_refs (content_id, field_id, target_content_id) VALUES (?, ?, ?)`
    ).run(carId, ownerFieldId, personId);

    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM content_refs WHERE field_id = 1").all();
    const planStr = JSON.stringify(plan);

    expect(planStr).toContain("idx_content_refs_field_id");
    expect(planStr).not.toMatch(/SCAN.*content_refs\b/);

    db.close();
  });
});
