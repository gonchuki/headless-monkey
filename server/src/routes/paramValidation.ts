import { Request, RequestHandler } from "express";
import type { PaginationParams, SortParams } from "../types";

export class ParamValidationError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

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
    // The cursor is an opaque string carried unchanged to the service/repo,
    // which decodes it (undecodable → first page).
    const raw = req.query.cursor;
    if (typeof raw === "string") params.cursor = raw;
  }

  const dir = req.query.direction;
  if (dir === "forward" || dir === "backward") {
    params.direction = dir;
  }

  return params;
}

/**
 * Parse sort query params (sort_field, sort_order).
 * Returns `undefined` when no sort params are present.
 * Throws with statusCode 422 for invalid sort_field values.
 */
export function parseSortParams(req: Request): SortParams | undefined {
  const hasField = req.query.sort_field !== undefined;
  const hasOrder = req.query.sort_order !== undefined;

  if (!hasField && !hasOrder) return undefined;

  const params: SortParams = { sortField: "modified" };

  if (hasField) {
    const raw = String(req.query.sort_field);
    if (raw === "id" || raw === "date" || raw === "modified") {
      params.sortField = raw;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || String(n) !== raw.trim()) {
        throw new ParamValidationError(422, "Invalid sort_field: must be 'id', 'date', 'modified', or a positive integer");
      }
      params.sortField = n;
    }
  }

  if (hasOrder) {
    const raw = String(req.query.sort_order);
    if (raw === "asc" || raw === "desc") {
      params.sortOrder = raw;
    } else {
      throw new ParamValidationError(422, "Invalid sort_order: must be 'asc' or 'desc'");
    }
  }

  return params;
}
