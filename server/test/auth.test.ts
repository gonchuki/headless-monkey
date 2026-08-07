import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { openDatabase } from "../src/db/database";

function createTestApp() {
  const db = openDatabase();
  const app = createApp(db);
  return { app, db };
}

function adminToken(): string {
  const env = { ADMIN_PASSWORD: "test-admin-pass", JWT_SECRET: "test-secret" };
  process.env.ADMIN_PASSWORD = env.ADMIN_PASSWORD;
  process.env.JWT_SECRET = env.JWT_SECRET;
  return jwt.sign({ sub: "admin", role: "admin" }, env.JWT_SECRET, { expiresIn: "8h" });
}

function editorToken(login: string = "editor1"): string {
  const env = { JWT_SECRET: "test-secret" };
  process.env.JWT_SECRET = env.JWT_SECRET;
  return jwt.sign({ sub: login, role: "editor" }, env.JWT_SECRET, { expiresIn: "8h" });
}

describe("Auth routes", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = "test-admin-pass";
    process.env.JWT_SECRET = "test-secret";
  });

  describe("POST /api/auth/login", () => {
    it("admin login returns token with role=admin (R1)", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post("/api/auth/login")
        .send({ login: "admin", password: "test-admin-pass" });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();

      const decoded = jwt.decode(res.body.token) as { sub: string; role: string };
      expect(decoded.sub).toBe("admin");
      expect(decoded.role).toBe("admin");
    });

    it("editor login returns token with role=editor (R2)", async () => {
      const { app, db } = createTestApp();
      const hashed = await bcrypt.hash("editor-pass", 10);
      db.prepare(
        "INSERT INTO users (login, hashed_password) VALUES (?, ?)"
      ).run("editor1", hashed);

      const res = await request(app)
        .post("/api/auth/login")
        .send({ login: "editor1", password: "editor-pass" });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();

      const decoded = jwt.decode(res.body.token) as { sub: string; role: string };
      expect(decoded.sub).toBe("editor1");
      expect(decoded.role).toBe("editor");
    });

    it("disabled editor returns 401 (R2)", async () => {
      const { app, db } = createTestApp();
      const hashed = await bcrypt.hash("editor-pass", 10);
      db.prepare(
        "INSERT INTO users (login, hashed_password, disabled) VALUES (?, ?, ?)"
      ).run("disabled-editor", hashed, 1);

      const res = await request(app)
        .post("/api/auth/login")
        .send({ login: "disabled-editor", password: "editor-pass" });

      expect(res.status).toBe(401);
    });

    it("unknown login returns 401 (R3)", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post("/api/auth/login")
        .send({ login: "unknown", password: "anything" });

      expect(res.status).toBe(401);
    });

    it("wrong password returns 401 (R3)", async () => {
      const { app, db } = createTestApp();
      const hashed = await bcrypt.hash("correct-pass", 10);
      db.prepare(
        "INSERT INTO users (login, hashed_password) VALUES (?, ?)"
      ).run("editor1", hashed);

      const res = await request(app)
        .post("/api/auth/login")
        .send({ login: "editor1", password: "wrong-pass" });

      expect(res.status).toBe(401);
    });

    it("unknown login and wrong password return identical 401 bodies (R3)", async () => {
      const { app, db } = createTestApp();
      const hashed = await bcrypt.hash("correct-pass", 10);
      db.prepare(
        "INSERT INTO users (login, hashed_password) VALUES (?, ?)"
      ).run("editor1", hashed);

      const unknownRes = await request(app)
        .post("/api/auth/login")
        .send({ login: "unknown", password: "anything" });

      const wrongPassRes = await request(app)
        .post("/api/auth/login")
        .send({ login: "editor1", password: "wrong-pass" });

      expect(unknownRes.status).toBe(401);
      expect(wrongPassRes.status).toBe(401);
      expect(unknownRes.body.error).toBe(wrongPassRes.body.error);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("returns 204 (R4)", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${editorToken()}`);

      expect(res.status).toBe(204);
    });

    it("returns 401 without token (R4)", async () => {
      const { app } = createTestApp();
      const res = await request(app).post("/api/auth/logout");

      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns login and role with valid token", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${editorToken("editor1")}`);

      expect(res.status).toBe(200);
      expect(res.body.login).toBe("editor1");
      expect(res.body.role).toBe("editor");
    });

    it("returns 401 without token (R4)", async () => {
      const { app } = createTestApp();
      const res = await request(app).get("/api/auth/me");

      expect(res.status).toBe(401);
    });
  });

  describe("Protected routes require auth (R4)", () => {
    it("GET /api/schemas without token returns 401", async () => {
      const { app } = createTestApp();
      const res = await request(app).get("/api/schemas");

      expect(res.status).toBe(401);
    });

    it("GET /api/schemas with garbage token returns 401", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get("/api/schemas")
        .set("Authorization", "Bearer garbage-token");

      expect(res.status).toBe(401);
    });
  });

  describe("Role guards (R5)", () => {
    it("admin token on schemas route returns 403", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get("/api/schemas")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.status).toBe(403);
    });

    it("editor token on users route returns 403", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get("/api/users")
        .set("Authorization", `Bearer ${editorToken()}`);

      expect(res.status).toBe(403);
    });
  });

  describe("Admission paths", () => {
    it("editor token returns 200 on GET /api/schemas", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get("/api/schemas")
        .set("Authorization", `Bearer ${editorToken()}`);

      expect(res.status).toBe(200);
    });

    it("admin token returns 200 on GET /api/users", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .get("/api/users")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.status).toBe(200);
    });
  });
});
