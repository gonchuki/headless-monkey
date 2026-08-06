import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";

describe("GET /api/health", () => {
  it("returns 200 with a JSON status body", async () => {
    const app = createApp();
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
