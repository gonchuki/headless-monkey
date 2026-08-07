import { Router, Request, Response } from "express";
import type { ContentService } from "../services/contentService";

interface ServiceError {
  statusCode: number;
  message: string;
}

function isErrorWithStatus(err: unknown): err is ServiceError {
  return typeof err === "object" && err !== null && "statusCode" in err && "message" in err;
}

function handleError(res: Response, err: unknown): void {
  if (isErrorWithStatus(err)) {
    res.status(err.statusCode).json({ error: err.message });
  } else {
    res.status(500).json({ error: "Internal server error" });
  }
}

export function createContentRouter(contentService: ContentService): Router {
  const router: Router = Router();

  router.get("/:schema", (req: Request, res: Response) => {
    try {
      const schema = typeof req.params.schema === "string" ? req.params.schema : "";
      const entries = contentService.listPublic(schema);
      res.json(entries);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get("/:schema/:id", (req: Request, res: Response) => {
    try {
      const schema = typeof req.params.schema === "string" ? req.params.schema : "";
      const id = Number(req.params.id);
      const entry = contentService.getPublic(schema, id);
      res.json(entry);
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}
