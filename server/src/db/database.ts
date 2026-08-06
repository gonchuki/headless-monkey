import Database from "better-sqlite3";
import { applyMigrations } from "./migrations";

export type Db = InstanceType<typeof Database>;

export function openDatabase(dbPath?: string): Db {
  const db = new Database(dbPath || ":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = on");
  applyMigrations(db);
  return db;
}
