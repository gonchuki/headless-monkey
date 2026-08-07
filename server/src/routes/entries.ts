import { Router, Request, Response } from "express";
import type { ContentService } from "../services/contentService";
import type { AuthRequest } from "../auth/requireAuth";

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

export function createEntriesRouter(contentService: ContentService): Router {
  const router: Router = Router({ mergeParams: true });

  // Mounted at /api/schemas/:name/entries
  router.get("/", (req: Request, res: Response) => {
    try {
      const name = typeof req.params.name === "string" ? req.params.name : "";
      const entries = contentService.listForSchema(name);
      res.json(entries);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/", (req: Request, res: Response) => {
    try {
      const name = typeof req.params.name === "string" ? req.params.name : "";
      const values = req.body.values ?? {};
      const user = (req as AuthRequest).user.login;
      const entry = contentService.create(name, values, user);
      res.status(201).json(entry);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Mounted at /api/entries
  router.patch("/:id", (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const values = req.body.values ?? {};
      const user = (req as AuthRequest).user.login;
      const entry = contentService.update(id, values, user);
      res.json(entry);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete("/:id", (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      contentService.delete(id);
      res.status(204).send();
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}
