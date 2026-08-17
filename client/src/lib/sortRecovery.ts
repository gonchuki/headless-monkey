import { ApiError } from "@/lib/api";

const STALE_SORT_PREFIXES = [
  "Unknown sort field_id:",
  "Cannot sort by field",
  "Invalid sort_field:",
  "Invalid sort_order:",
];

/**
 * Returns true when the error is a 422 caused by stale/invalid sort params.
 * These are the four server messages that signal the URL's sort params are
 * unusable for this schema and should be dropped.
 */
export function isStaleSortError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status !== 422) return false;

  return STALE_SORT_PREFIXES.some((prefix) => error.message.startsWith(prefix));
}

/**
 * Returns a new URLSearchParams with `sort_field` and `sort_order` keys removed,
 * or `null` when neither key is present (no-op guard).
 */
export function dropSortParams(params: URLSearchParams): URLSearchParams | null {
  const hasSortField = params.has("sort_field");
  const hasSortOrder = params.has("sort_order");

  if (!hasSortField && !hasSortOrder) return null;

  const cleaned = new URLSearchParams(params);
  cleaned.delete("sort_field");
  cleaned.delete("sort_order");

  return cleaned;
}
