import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { Request } from "express";
import { createApp } from "../src/app";
import { openDatabase } from "../src/db/database";
import { SchemaService } from "../src/services/schemaService";
import { parseSortParams, ParamValidationError } from "../src/routes/paramValidation";

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

describe("Numeric param validation (PLAN-45)", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = "test-admin-pass";
    process.env.JWT_SECRET = "test-secret";
  });

  describe("PATCH /api/entries/:id", () => {
    it("returns 422 for non-numeric id", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .patch("/api/entries/abc")
        .set("Authorization", `Bearer ${editorToken()}`);

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("Invalid id");
    });

    it("returns 422 for float id", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .patch("/api/entries/1.5")
        .set("Authorization", `Bearer ${editorToken()}`);

      expect(res.status).toBe(422);
    });

    it("returns 422 for negative id", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .patch("/api/entries/-1")
        .set("Authorization", `Bearer ${editorToken()}`);

      expect(res.status).toBe(422);
    });

    it("returns 422 for zero id", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .patch("/api/entries/0")
        .set("Authorization", `Bearer ${editorToken()}`);

      expect(res.status).toBe(422);
    });
  });

  describe("DELETE /api/users/:id", () => {
    it("returns 422 for non-numeric id", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .delete("/api/users/abc")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("Invalid id");
    });
  });

  describe("GET /api/content/:schema/:id", () => {
    it("returns 422 for non-numeric id", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create(
        "person",
        [{ label: "name", type: "text", required: true }],
        "editor1"
      );

      const res = await request(app).get("/api/content/person/abc");

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("Invalid id");
    });
  });

  describe("Valid numeric IDs still work", () => {
    it("PATCH /api/entries/1 works with valid id (returns 404 since entry doesn't exist, not 422)", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .patch("/api/entries/1")
        .set("Authorization", `Bearer ${editorToken()}`)
        .send({ values: {} });

      // Entry 1 doesn't exist, so it should be 404 (not found), not 422 (validation error)
      expect(res.status).toBe(404);
    });

    it("DELETE /api/users/5 works with valid id (returns 404 since user doesn't exist)", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .delete("/api/users/5")
        .set("Authorization", `Bearer ${adminToken()}`);

      // User 5 doesn't exist, so it should be 404 (not found), not 422 (validation error)
      expect(res.status).toBe(404);
    });

    it("GET /api/content/person/1 works with valid id (returns 404 since entry doesn't exist)", async () => {
      const { app, schemaService } = createTestApp();
      schemaService.create(
        "person",
        [{ label: "name", type: "text", required: true }],
        "editor1"
      );

      const res = await request(app).get("/api/content/person/1");

      // Entry 1 doesn't exist, so it should be 404 (not found), not 422 (validation error)
      expect(res.status).toBe(404);
    });
  });
});

describe("parseSortParams (PLAN-60)", () => {
  function reqWith(query: Record<string, string>): Request {
    return { query } as unknown as Request;
  }

  it("accepts sort_field=modified", () => {
    expect(parseSortParams(reqWith({ sort_field: "modified" }))).toEqual({
      sortField: "modified",
    });
  });

  it("still accepts the legacy 'id'/'date' literals and numeric field ids", () => {
    expect(parseSortParams(reqWith({ sort_field: "id" }))).toEqual({ sortField: "id" });
    expect(parseSortParams(reqWith({ sort_field: "date" }))).toEqual({ sortField: "date" });
    expect(parseSortParams(reqWith({ sort_field: "7" }))).toEqual({ sortField: 7 });
  });

  it("rejects an unknown literal with 422", () => {
    let caught: unknown;
    try {
      parseSortParams(reqWith({ sort_field: "bogus" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParamValidationError);
    expect((caught as ParamValidationError).statusCode).toBe(422);
  });
});
