import { Router, Request, Response } from "express";
import type { ContentService } from "../services/contentService";
import type { EventsEmitter } from "../services/events";
import type { AuthRequest } from "../auth/requireAuth";
import { validateNumericParam, parsePaginationParams, parseSortParams } from "./paramValidation";

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

export function createEntriesRouter(
  contentService: ContentService,
  emitter?: EventsEmitter
): Router {
  const router: Router = Router({ mergeParams: true });

  // Mounted at /api/schemas/:name/entries
  router.get("/", (req: Request, res: Response) => {
    try {
      const name = typeof req.params.name === "string" ? req.params.name : "";
      const pagination = parsePaginationParams(req);
      const sort = parseSortParams(req);
      if (pagination !== undefined) {
        const result = contentService.listForSchema(name, pagination, sort);
        res.json(result);
      } else if (sort !== undefined) {
        // Sort without pagination: use un-paginated list with sort
        const entries = contentService.listForSchema(name, sort);
        res.json(entries);
      } else {
        const entries = contentService.listForSchema(name);
        res.json(entries);
      }
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
      emitter?.emit({
        type: "entry.created",
        schema: entry.schema,
        entryId: entry.id,
        by: user,
      });
      res.status(201).json(entry);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Mounted at /api/entries
  router.patch("/:id", validateNumericParam("id"), (req: Request, res: Response) => {
    try {
      const id = Number.parseInt(req.params.id as string, 10);
      const values = req.body.values ?? {};
      const user = (req as AuthRequest).user.login;
      const entry = contentService.update(id, values, user);
      emitter?.emit({
        type: "entry.updated",
        schema: entry.schema,
        entryId: entry.id,
        by: user,
      });
      res.json(entry);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete("/:id", validateNumericParam("id"), (req: Request, res: Response) => {
    try {
      const id = Number.parseInt(req.params.id as string, 10);
      const user = (req as AuthRequest).user.login;
      const existing = contentService.getEntryMeta(id);
      contentService.delete(id);
      if (existing) {
        emitter?.emit({
          type: "entry.deleted",
          schema: existing.schema,
          entryId: existing.id,
          by: user,
        });
      }
      res.status(204).send();
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}
