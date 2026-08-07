import express from "express";
import type { Db } from "./db/database";
import { openDatabase } from "./db/database";
import { createSchemasRouter } from "./routes/schemas";
import { SchemaService } from "./services/schemaService";
import { createAuthRouter } from "./routes/auth";
import { createUsersRouter } from "./routes/users";
import { requireAuth, requireRole } from "./auth/requireAuth";

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

  // Auth routes (login is public; logout and me require auth)
  const authRouter = createAuthRouter(database, requireAuth);
  app.use("/api/auth", authRouter);

  // Schemas routes — editor only
  const schemasRouter = createSchemasRouter(schemaService, "editor");
  app.use("/api/schemas", requireAuth, requireRole("editor"), schemasRouter);

  // Users routes — admin only
  const usersRouter = createUsersRouter(database);
  app.use("/api/users", requireAuth, requireRole("admin"), usersRouter);

  return app;
}
