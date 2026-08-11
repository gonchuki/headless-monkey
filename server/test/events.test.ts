import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app";
import { openDatabase } from "../src/db/database";
import { EventsEmitter, computeSchemaChanges, type RealtimeEvent } from "../src/services/events";
import type { FieldWithId } from "../src/types";

const JWT_SECRET = "test-secret";

function setup() {
  process.env.ADMIN_PASSWORD = "test-admin-pass";
  process.env.JWT_SECRET = JWT_SECRET;
  const db = openDatabase();
  const app = createApp(db);
  return { app, db };
}

function editorToken(login = "editor1"): string {
  return jwt.sign({ sub: login, role: "editor" }, JWT_SECRET, { expiresIn: "8h" });
}

function field(id: number, label: string, type: string, required: boolean, sortOrder: number): FieldWithId {
  return { id, label, type: type as FieldWithId["type"], required, ref_schema: undefined, sort_order: sortOrder };
}

async function withServer(
  app: express.Express,
  fn: (port: number) => Promise<void>
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function openStream(
  port: number,
  token: string,
  events: RealtimeEvent[]
): Promise<http.ClientRequest> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/events",
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          for (const block of chunk.split("\n\n")) {
            const line = block.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            const json = line.slice(5).trim();
            if (!json) continue;
            try {
              events.push(JSON.parse(json) as RealtimeEvent);
            } catch {
              // skip malformed frames
            }
          }
        });
      }
    );
    req.on("error", reject);
    resolve(req);
  });
}

async function waitForEvent(
  events: RealtimeEvent[],
  predicate: (event: RealtimeEvent) => boolean,
  timeoutMs = 4000
): Promise<RealtimeEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for SSE event");
}

describe("GET /api/events", () => {
  it("returns 401 without a token (R4)", async () => {
    const { app } = setup();
    const res = await request(app).get("/api/events");
    expect(res.status).toBe(401);
  });

  it("returns 401 with an invalid token (R4)", async () => {
    const { app } = setup();
    const res = await request(app).get("/api/events").set("Authorization", "Bearer garbage-token");
    expect(res.status).toBe(401);
  });

  it("returns 200 text/event-stream with a valid editor token", async () => {
    const { app } = setup();
    await withServer(app, async (port) => {
      const events: RealtimeEvent[] = [];
      const req = await openStream(port, editorToken(), events);
      const status = await new Promise<number>((resolve, reject) => {
        req.on("response", (res) => {
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
      });
      expect(status).toBe(200);
      req.destroy();
    });
  });

  it("streams schema.created, schema.updated with changes, entry events, and schema.deleted", async () => {
    const { app } = setup();
    const token = editorToken("alice");

    await withServer(app, async (port) => {
      const events: RealtimeEvent[] = [];
      const req = await openStream(port, token, events);
      await new Promise<void>((resolve, reject) => {
        req.on("response", () => resolve());
        req.on("error", reject);
      });

      // Create a schema — client must receive schema.created
      const created = await request(app)
        .post("/api/schemas")
        .set("Authorization", `Bearer ${token}`)
        .send({
          name: "car",
          fields: [
            { label: "make", type: "text", required: true },
            { label: "year", type: "number", required: false },
          ],
        });
      expect(created.status).toBe(201);

      const createdEvent = await waitForEvent(
        events,
        (e) => e.type === "schema.created" && e.schema === "car"
      );
      expect(createdEvent).toMatchObject({ type: "schema.created", schema: "car", by: "alice", version: 1, compatVersion: 1 });

      // Update a field type + add a field — schema.updated must carry changes
      const updated = await request(app)
        .patch("/api/schemas/car")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fields: [
            { id: 1, label: "manufacturer", type: "text", required: true },
            { id: 2, label: "year", type: "text", required: false },
            { label: "color", type: "text", required: false },
          ],
        });
      expect(updated.status).toBe(200);

      const updatedEvent = await waitForEvent(
        events,
        (e) => e.type === "schema.updated" && e.schema === "car"
      );
      expect(updatedEvent.version).toBe(2);
      expect(updatedEvent.changes).toContainEqual({ kind: "renamed", fieldId: 1, label: "manufacturer" });
      expect(updatedEvent.changes).toContainEqual({ kind: "typeChanged", fieldId: 2, label: "year", type: "text" });
      expect(updatedEvent.changes).toContainEqual({ kind: "added", fieldId: 3, label: "color", type: "text", required: false });

      // Create an entry — entry.created must carry entryId
      const entryRes = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { "1": "Honda", "2": "2020" } });
      expect(entryRes.status).toBe(201);
      const entryId = entryRes.body.id;

      const createdEntry = await waitForEvent(
        events,
        (e) => e.type === "entry.created" && e.schema === "car" && e.entryId === entryId
      );
      expect(createdEntry.by).toBe("alice");

      // Update the entry
      await request(app)
        .patch(`/api/entries/${entryId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { "1": "Honda", "2": "2021" } });

      const updatedEntry = await waitForEvent(
        events,
        (e) => e.type === "entry.updated" && e.schema === "car" && e.entryId === entryId
      );
      expect(updatedEntry.by).toBe("alice");

      // Delete the entry
      await request(app).delete(`/api/entries/${entryId}`).set("Authorization", `Bearer ${token}`);
      await waitForEvent(
        events,
        (e) => e.type === "entry.deleted" && e.schema === "car" && e.entryId === entryId
      );

      // Delete the schema — schema.deleted must arrive
      await request(app).delete("/api/schemas/car").set("Authorization", `Bearer ${token}`);
      const deletedEvent = await waitForEvent(
        events,
        (e) => e.type === "schema.deleted" && e.schema === "car"
      );
      expect(deletedEvent.by).toBe("alice");

      req.destroy();
    });
  });

  it("does not broadcast entry.deleted for a blocked delete (R34)", async () => {
    const { app } = setup();
    const token = editorToken("alice");

    await withServer(app, async (port) => {
      const events: RealtimeEvent[] = [];
      const req = await openStream(port, token, events);
      await new Promise<void>((resolve, reject) => {
        req.on("response", () => resolve());
        req.on("error", reject);
      });

      // person: single name field (id 1). car: make (id 2) + owner → person (id 3)
      const personSchemaRes = await request(app)
        .post("/api/schemas")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "person", fields: [{ label: "name", type: "text", required: true }] });
      expect(personSchemaRes.status).toBe(201);

      const carSchemaRes = await request(app)
        .post("/api/schemas")
        .set("Authorization", `Bearer ${token}`)
        .send({
          name: "car",
          fields: [
            { label: "make", type: "text", required: true },
            { label: "owner", type: "schema-ref", required: false, ref_schema: "person" },
          ],
        });
      expect(carSchemaRes.status).toBe(201);

      const personRes = await request(app)
        .post("/api/schemas/person/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { "1": "Alice" } });
      expect(personRes.status).toBe(201);
      const personId = personRes.body.id as number;

      await waitForEvent(events, (e) => e.type === "entry.created" && e.entryId === personId);

      const carRes = await request(app)
        .post("/api/schemas/car/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ values: { "2": "Civic", "3": personId } });
      expect(carRes.status).toBe(201);
      const carId = carRes.body.id as number;

      // Deleting the referenced entry now succeeds (204) and emits the event.
      const delPerson = await request(app)
        .delete(`/api/entries/${personId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(delPerson.status).toBe(204);
      await waitForEvent(
        events,
        (e) => e.type === "entry.deleted" && e.entryId === personId
      );

      // Positive control: an unreferenced delete still emits the event.
      const del = await request(app)
        .delete(`/api/entries/${carId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(del.status).toBe(204);
      await waitForEvent(
        events,
        (e) => e.type === "entry.deleted" && e.entryId === carId
      );

      req.destroy();
    });
  });
});

describe("EventsEmitter", () => {
  it("delivers events to subscribers and stops after unsubscribe", () => {
    const emitter = new EventsEmitter();
    const received: RealtimeEvent[] = [];
    const unsubscribe = emitter.subscribe(null, (event) => received.push(event));

    emitter.emit({ type: "schema.created", schema: "car", by: "a" });
    expect(received).toHaveLength(1);

    unsubscribe();
    emitter.emit({ type: "schema.deleted", schema: "car", by: "a" });
    expect(received).toHaveLength(1);
  });

  it("routes events to schema-keyed subscriptions and to all listeners", () => {
    const emitter = new EventsEmitter();
    const car: RealtimeEvent[] = [];
    const all: RealtimeEvent[] = [];
    emitter.subscribe("car", (event) => car.push(event));
    emitter.subscribe(null, (event) => all.push(event));

    emitter.emit({ type: "entry.created", schema: "car", entryId: 1, by: "a" });
    emitter.emit({ type: "entry.created", schema: "boat", entryId: 2, by: "a" });

    expect(car.map((e) => e.schema)).toEqual(["car"]);
    expect(all).toHaveLength(2);
  });
});

describe("computeSchemaChanges", () => {
  it("detects every change kind from a single field update", () => {
    const oldFields = [
      field(1, "make", "text", true, 0),
      field(2, "year", "number", false, 1),
      field(3, "color", "text", false, 2),
    ];
    const newFields = [
      field(2, "modelYear", "text", true, 0),
      field(3, "color", "text", false, 1),
      field(4, "vin", "text", false, 2),
    ];

    const changes = computeSchemaChanges(oldFields, newFields);

    expect(changes).toContainEqual({ kind: "deleted", fieldId: 1, label: "make" });
    expect(changes).toContainEqual({ kind: "added", fieldId: 4, label: "vin", type: "text", required: false });
    expect(changes).toContainEqual({ kind: "renamed", fieldId: 2, label: "modelYear" });
    expect(changes).toContainEqual({ kind: "typeChanged", fieldId: 2, label: "modelYear", type: "text" });
    expect(changes).toContainEqual({ kind: "requiredChanged", fieldId: 2, label: "modelYear", required: true });
    expect(changes).toContainEqual({ kind: "reordered", fieldId: 2, label: "modelYear" });
  });

  it("returns an empty list when nothing changed", () => {
    const fields = [field(1, "make", "text", true, 0)];
    expect(computeSchemaChanges(fields, [...fields])).toEqual([]);
  });
});
