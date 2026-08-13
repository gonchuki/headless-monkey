import { RequestHandler } from "express";

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
