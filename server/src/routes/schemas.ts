import { Router, Request, Response } from "express";
import type { SchemaService } from "../services/schemaService";
import { computeSchemaChanges, type EventsEmitter } from "../services/events";
import type { FieldInput } from "../types";
import type { AuthRequest } from "../auth/requireAuth";

interface ServiceError {
  statusCode: number;
  message: string;
}

function isErrorWithStatus(err: unknown): err is ServiceError {
  return typeof err === "object" && err !== null && "statusCode" in err && "message" in err;
}

export function createSchemasRouter(
  schemaService: SchemaService,
  emitter?: EventsEmitter
): Router {
  const router: Router = Router();

  router.get("/", (_req: Request, res: Response) => {
    try {
      const schemas = schemaService.list();
      res.json(schemas);
    } catch (err) {
      if (isErrorWithStatus(err)) {
        res.status(err.statusCode).json({ error: err.message });
      } else {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  router.get("/:name", (req: Request, res: Response) => {
    try {
      const name = typeof req.params.name === "string" ? req.params.name : "";
      const schema = schemaService.get(name);
      if (!schema) {
        return res.status(404).json({ error: `Schema '${name}' not found` });
      }
      res.json(schema);
    } catch (err) {
      if (isErrorWithStatus(err)) {
        res.status(err.statusCode).json({ error: err.message });
      } else {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  router.post("/", (req: Request, res: Response) => {
    try {
      const { name, fields }: { name: string; fields: FieldInput[] } = req.body;
      const user = (req as AuthRequest).user.login;
      const schema = schemaService.create(name, fields, user);
      emitter?.emit({
        type: "schema.created",
        schema: schema.name,
        version: schema.version,
        compatVersion: schema.compat_version,
        by: user,
      });
      res.status(201).json(schema);
    } catch (err) {
      if (isErrorWithStatus(err)) {
        res.status(err.statusCode).json({ error: err.message });
      } else {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  router.patch("/:name", (req: Request, res: Response) => {
    try {
      const name = typeof req.params.name === "string" ? req.params.name : "";
      const fields = req.body.fields;
      const user = (req as AuthRequest).user.login;
      const existing = schemaService.get(name);
      const schema = schemaService.update(name, fields, user);
      if (emitter && existing) {
        emitter.emit({
          type: "schema.updated",
          schema: schema.name,
          version: schema.version,
          compatVersion: schema.compat_version,
          by: user,
          changes: computeSchemaChanges(existing.fields, schema.fields),
        });
      }
      res.json(schema);
    } catch (err) {
      if (isErrorWithStatus(err)) {
        res.status(err.statusCode).json({ error: err.message });
      } else {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  router.delete("/:name", (req: Request, res: Response) => {
    try {
      const name = typeof req.params.name === "string" ? req.params.name : "";
      const user = (req as AuthRequest).user.login;
      schemaService.delete(name);
      emitter?.emit({ type: "schema.deleted", schema: name, by: user });
      res.status(204).send();
    } catch (err) {
      if (isErrorWithStatus(err)) {
        res.status(err.statusCode).json({ error: err.message });
      } else {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  return router;
}
