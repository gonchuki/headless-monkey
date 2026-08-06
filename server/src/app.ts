import express from "express";
import type { Db } from "./db/database";
import { openDatabase } from "./db/database";
import { createSchemasRouter } from "./routes/schemas";
import { SchemaService } from "./services/schemaService";

export interface HealthResponse {
  status: "ok";
}

export function createApp(db?: Db): express.Express {
  const app = express();
  app.use(express.json());

  const database = db ?? openDatabase();
  const schemaService = new SchemaService(database);

  app.get("/api/health", (_req, res) => {
    const body: HealthResponse = { status: "ok" };
    res.status(200).json(body);
  });

  app.use("/api/schemas", createSchemasRouter(schemaService, "system"));

  return app;
}
