import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database";
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
