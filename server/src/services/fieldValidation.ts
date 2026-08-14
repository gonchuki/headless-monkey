import type { ScalarFieldInput } from "../types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Full date string predicate: regex shape plus a calendar round-trip. */
export function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Scalar per-type validity (text | number | boolean | date). Schema-ref values
 * are NOT handled here — callers that need them (the content service, which
 * must confirm the target entry exists) keep that branch local.
 */
export function isScalarValueValid(
  type: ScalarFieldInput["type"],
  required: boolean,
  value: unknown
): boolean {
  switch (type) {
    case "text":
      return typeof value === "string" && (!required || value.length > 0);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && isValidDateString(value);
    default:
      return false;
  }
}

/** The only coercion rule: number→text (lossless, R13/R17). */
export function coerceScalarValue(type: ScalarFieldInput["type"], value: unknown): unknown {
  if (type === "text" && typeof value === "number") {
    return String(value);
  }
  return null;
}