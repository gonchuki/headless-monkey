import { Request, RequestHandler } from "express";
import type { PaginationParams } from "../types";

/**
 * Express middleware that validates a route parameter is a positive integer.
 * Rejects non-numeric, zero, negative, and float values with 422.
 */
export function validateNumericParam(paramName: string): RequestHandler {
  return (req, res, next) => {
    const raw = req.params[paramName];
    if (raw == null || Array.isArray(raw) || raw === "") {
      return res.status(422).json({ error: `Invalid ${paramName}: must be a positive integer` });
    }

    const parsed = Number.parseInt(raw, 10);

    // Reject NaN (non-numeric), zero, negative, and floats (e.g. "1.5" parses to 1 but round-trips differ)
    if (Number.isNaN(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
      return res.status(422).json({ error: `Invalid ${paramName}: must be a positive integer` });
    }

    next();
  };
}

/**
 * Parse cursor-based pagination query params (limit, cursor, direction).
 * Returns `undefined` when no pagination params are present (backward compat:
 * callers can fall through to the un-paginated code path).
 */
export function parsePaginationParams(req: Request): PaginationParams | undefined {
  const hasLimit = req.query.limit !== undefined;
  const hasCursor = req.query.cursor !== undefined;
  const hasDirection = req.query.direction !== undefined;

  if (!hasLimit && !hasCursor && !hasDirection) return undefined;

  const params: PaginationParams = {};

  if (hasLimit) {
    const n = Number(req.query.limit);
    if (Number.isFinite(n)) params.limit = n;
  }

  if (hasCursor) {
    const n = Number(req.query.cursor);
    if (Number.isFinite(n)) params.cursor = n;
  }

  const dir = req.query.direction;
  if (dir === "forward" || dir === "backward") {
    params.direction = dir;
  }

  return params;
}
