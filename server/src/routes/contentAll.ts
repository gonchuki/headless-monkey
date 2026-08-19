import { Router, Request, Response, RequestHandler } from "express";
import type { ContentService } from "../services/contentService";
import { parsePaginationParams, parseConflictedParam } from "./paramValidation";

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

/**
 * Editor-authenticated index router for `GET /api/content`: a globally
 * keyset-paginated listing across all schemas. Mounted at `/api/content`
 * AFTER the public `createContentRouter` (whose `/:schema` and `/:schema/:id`
 * routes never match the bare index, so both coexist cleanly). The route is
 * the router index (`/`) — a suffixed path would be shadowed by the public
 * router's `/:schema` wildcard.
 */
export function createAllContentRouter(
  contentService: ContentService,
  requireAuth: RequestHandler,
  requireRole: (role: string) => RequestHandler
): Router {
  const router: Router = Router();

  router.get("/", requireAuth, requireRole("editor"), (req: Request, res: Response) => {
    try {
      const pagination = parsePaginationParams(req);
      const conflictedOnly = parseConflictedParam(req);
      if (pagination !== undefined) {
        const result = contentService.listAll(pagination, conflictedOnly);
        res.json(result);
      } else {
        const entries = contentService.listAll(conflictedOnly);
        res.json(entries);
      }
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}
