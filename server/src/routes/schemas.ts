import { Router, Request, Response } from "express";
import type { SchemaService } from "../services/schemaService";
import type { FieldInput } from "../types";

interface ServiceError {
  statusCode: number;
  message: string;
}

function isErrorWithStatus(err: unknown): err is ServiceError {
  return typeof err === "object" && err !== null && "statusCode" in err && "message" in err;
}

export function createSchemasRouter(
  schemaService: SchemaService,
  _user: string = "system"
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
      const schema = schemaService.create(name, fields, _user);
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
      const schema = schemaService.update(name, fields, _user);
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
      schemaService.delete(name);
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
