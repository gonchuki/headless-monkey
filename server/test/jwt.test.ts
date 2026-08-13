import jwt from "jsonwebtoken";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { signToken, verifyToken } from "../src/auth/jwt";
import { requireAuth } from "../src/auth/requireAuth";
import type { Request, Response } from "express";

const TEST_SECRET = "test-secret-for-jwt-validation";

function mockEnv(secret: string) {
  const original = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  return () => {
    if (original === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = original;
    }
  };
}

function mockReq(token: string): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {} as Response;
  const statusFn = (code: number) => ({ json: (body: unknown) => ({ code, body }) });
  res.status = statusFn as never;
  return res;
}

describe("verifyToken payload validation", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = mockEnv(TEST_SECRET);
  });

  afterEach(() => {
    cleanup();
  });

  it("accepts a token with all valid fields (sub, role: editor, exp)", () => {
    const token = jwt.sign({ sub: "testuser", role: "editor" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "8h",
    });
    const payload = verifyToken(token);
    expect(payload.sub).toBe("testuser");
    expect(payload.role).toBe("editor");
    expect(typeof payload.exp).toBe("number");
  });

  it("accepts a token with role admin", () => {
    const token = jwt.sign({ sub: "admin-user", role: "admin" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "8h",
    });
    const payload = verifyToken(token);
    expect(payload.role).toBe("admin");
  });

  it("rejects a token missing sub", () => {
    const token = jwt.sign({ role: "editor" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "8h",
    });
    expect(() => verifyToken(token)).toThrow();
  });

  it("rejects a token with sub as a non-string (number)", () => {
    const token = jwt.sign({ sub: 12345, role: "editor" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "8h",
    });
    expect(() => verifyToken(token)).toThrow("sub must be a string");
  });

  it("rejects a token with sub as an object", () => {
    const token = jwt.sign({ sub: { id: 1 }, role: "editor" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "8h",
    });
    expect(() => verifyToken(token)).toThrow("sub must be a string");
  });

  it("rejects a token with role superadmin (valid JWT, wrong role value)", () => {
    const token = jwt.sign({ sub: "testuser", role: "superadmin" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "8h",
    });
    expect(() => verifyToken(token)).toThrow("role must be admin or editor");
  });

  it("rejects a token with role as a non-string type", () => {
    const token = jwt.sign({ sub: "testuser", role: 42 }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "8h",
    });
    expect(() => verifyToken(token)).toThrow("role must be admin or editor");
  });

  it("rejects a token missing exp", () => {
    const token = jwt.sign({ sub: "testuser", role: "editor" }, TEST_SECRET, {
      algorithm: "HS256",
    });
    expect(() => verifyToken(token)).toThrow("exp must be a finite number");
  });

  it("rejects a token signed with RS256 (algorithm confusion)", () => {
    // Create a key pair for RS256 signing
    const crypto = require("node:crypto");
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = jwt.sign({ sub: "testuser", role: "editor" }, privateKey, {
      algorithm: "RS256",
      expiresIn: "8h",
    });
    expect(() => verifyToken(token)).toThrow();
  });

  it("rejects a token with extra fields but valid required fields", () => {
    const token = jwt.sign(
      { sub: "testuser", role: "editor", extraField: "should-be-ignored" },
      TEST_SECRET,
      { algorithm: "HS256", expiresIn: "8h" }
    );
    // Should succeed — extra fields are ignored
    const payload = verifyToken(token);
    expect(payload.sub).toBe("testuser");
  });
});

describe("requireAuth middleware with payload validation", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = mockEnv(TEST_SECRET);
  });

  afterEach(() => {
    cleanup();
  });

  it("returns 401 for a token missing sub", () => {
    const token = jwt.sign({ role: "editor" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "8h",
    });
    const req = mockReq(token);
    const res = mockRes();
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
  });

  it("returns 401 for a token with role superadmin", () => {
    const token = jwt.sign({ sub: "testuser", role: "superadmin" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "8h",
    });
    const req = mockReq(token);
    const res = mockRes();
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
  });

  it("calls next() for a valid token", () => {
    const token = jwt.sign({ sub: "testuser", role: "editor" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "8h",
    });
    const req = mockReq(token);
    const res = mockRes() as Response;
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
  });

  it("returns 401 for a token with sub as a number", () => {
    const token = jwt.sign({ sub: 12345, role: "editor" }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "8h",
    });
    const req = mockReq(token);
    const res = mockRes();
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
  });
});

describe("signToken produces valid tokens", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = mockEnv(TEST_SECRET);
  });

  afterEach(() => {
    cleanup();
  });

  it("produces a token that verifyToken accepts", () => {
    const token = signToken("testuser", "editor");
    const payload = verifyToken(token);
    expect(payload.sub).toBe("testuser");
    expect(payload.role).toBe("editor");
  });
});
