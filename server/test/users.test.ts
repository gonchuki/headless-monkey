import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { openDatabase } from "../src/db/database";
import { UserRepo } from "../src/repositories/userRepo";

function createTestApp() {
  const db = openDatabase();
  const app = createApp(db);
  return { app, db };
}

function adminToken(): string {
  process.env.JWT_SECRET = "test-secret";
  return jwt.sign({ sub: "admin", role: "admin" }, "test-secret", { expiresIn: "8h" });
}

describe("Users routes (admin only)", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = "test-admin-pass";
    process.env.JWT_SECRET = "test-secret";
  });

  describe("GET /api/users", () => {
    it("returns list of users (R6)", async () => {
      const { app, db } = createTestApp();
      const hashed = await bcrypt.hash("pass1", 10);
      db.prepare(
        "INSERT INTO users (login, hashed_password) VALUES (?, ?)"
      ).run("editor1", hashed);

      const res = await request(app)
        .get("/api/users")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].login).toBe("editor1");
      expect(res.body[0].hashed_password).toBeUndefined();
    });

    it("returns 403 for editor token (R5)", async () => {
      const { app } = createTestApp();
      const editorJwt = jwt.sign({ sub: "editor1", role: "editor" }, "test-secret", { expiresIn: "8h" });
      const res = await request(app)
        .get("/api/users")
        .set("Authorization", `Bearer ${editorJwt}`);

      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/users", () => {
    it("creates a user (R6)", async () => {
      const { app } = createTestApp();
      const res = await request(app)
        .post("/api/users")
        .set("Authorization", `Bearer ${adminToken()}`)
        .send({ login: "new-editor", password: "new-pass" });

      expect(res.status).toBe(201);
      expect(res.body.login).toBe("new-editor");
      expect(res.body.id).toBeDefined();
    });

    it("duplicate login returns 409 (R6)", async () => {
      const { app, db } = createTestApp();
      const hashed = await bcrypt.hash("pass1", 10);
      db.prepare(
        "INSERT INTO users (login, hashed_password) VALUES (?, ?)"
      ).run("editor1", hashed);

      const res = await request(app)
        .post("/api/users")
        .set("Authorization", `Bearer ${adminToken()}`)
        .send({ login: "editor1", password: "another-pass" });

      expect(res.status).toBe(409);
    });
  });

  describe("PATCH /api/users/:id", () => {
    it("changes password (R7)", async () => {
      const { app, db } = createTestApp();
      const hashed = await bcrypt.hash("old-pass", 10);
      db.prepare(
        "INSERT INTO users (login, hashed_password) VALUES (?, ?)"
      ).run("editor1", hashed);

      const res = await request(app)
        .patch("/api/users/1")
        .set("Authorization", `Bearer ${adminToken()}`)
        .send({ password: "new-pass" });

      expect(res.status).toBe(200);
      expect(res.body.login).toBe("editor1");

      // Verify the new password works
      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({ login: "editor1", password: "new-pass" });

      expect(loginRes.status).toBe(200);
    });

    it("flips disabled (R7)", async () => {
      const { app, db } = createTestApp();
      const hashed = await bcrypt.hash("pass1", 10);
      db.prepare(
        "INSERT INTO users (login, hashed_password) VALUES (?, ?)"
      ).run("editor1", hashed);

      const res = await request(app)
        .patch("/api/users/1")
        .set("Authorization", `Bearer ${adminToken()}`)
        .send({ disabled: true });

      expect(res.status).toBe(200);
      expect(res.body.disabled).toBe(true);

      // Verify editor is now disabled
      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({ login: "editor1", password: "pass1" });

      expect(loginRes.status).toBe(401);
    });

    it("updates both password and disabled atomically", async () => {
      const { app, db } = createTestApp();
      const hashed = await bcrypt.hash("old-pass", 10);
      db.prepare(
        "INSERT INTO users (login, hashed_password) VALUES (?, ?)"
      ).run("editor1", hashed);

      const res = await request(app)
        .patch("/api/users/1")
        .set("Authorization", `Bearer ${adminToken()}`)
        .send({ password: "new-pass", disabled: true });

      expect(res.status).toBe(200);
      expect(res.body.disabled).toBe(true);

      // Verify the password was updated in the DB
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(1) as any;
      const passwordMatches = await bcrypt.compare("new-pass", user.hashed_password);
      expect(passwordMatches).toBe(true);
    });

    it("atomic update: if user is deleted before the call, no mutations are applied", async () => {
      const db = openDatabase();
      const app = createApp(db);
      const hashed = await bcrypt.hash("pass1", 10);
      db.prepare(
        "INSERT INTO users (login, hashed_password) VALUES (?, ?)"
      ).run("editor1", hashed);

      const originalFindById = UserRepo.prototype.findById;
      const spy = vi
        .spyOn(UserRepo.prototype, "findById")
        .mockImplementation(function (this: UserRepo, id: number) {
          // Delete the user BEFORE the original findById runs
          if (id === 1) {
            db.prepare("DELETE FROM users WHERE id = ?").run(1);
          }
          return originalFindById.call(this, id);
        });

      try {
        const res = await request(app)
          .patch("/api/users/1")
          .set("Authorization", `Bearer ${adminToken()}`)
          .send({ password: "new-pass", disabled: true });

        // The user was deleted before findById, so the atomic method
        // returns false and no mutations are applied.
        expect(res.status).toBe(404);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("DELETE /api/users/:id", () => {
    it("removes the editor (R7)", async () => {
      const { app, db } = createTestApp();
      const hashed = await bcrypt.hash("pass1", 10);
      db.prepare(
        "INSERT INTO users (login, hashed_password) VALUES (?, ?)"
      ).run("editor1", hashed);

      const res = await request(app)
        .delete("/api/users/1")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.status).toBe(204);

      // Verify user is gone
      const listRes = await request(app)
        .get("/api/users")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(listRes.body.length).toBe(0);
    });
  });
});
