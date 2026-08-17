/**
 * Per-schema pagination state model for the all-schemas content listing.
 *
 * Each schema carries its own cursor so schemas with different entry counts
 * never desynchronize. Schemas that run out of pages become "stuck" and stop
 * contributing until a retreat brings them back into range.
 *
 * Pure module — no React, no fetch. Fully unit-testable.
 */

/** How to fetch one schema's contribution at the current depth. */
export interface SchemaPageState {
  /** Opaque cursor string from the server. */
  cursor?: string;
  /** Direction of the last navigation that produced this cursor. */
  direction?: "fwd" | "bwd";
  /** Depth at which this schema ran out of pages (last page reached). Present only while current depth > stuckAt. */
  stuckAt?: number;
}

/** Complete all-view pagination state. */
export interface AllViewState {
  /** 1-based page position of the merged list ("Page N" counter). */
  depth: number;
  /** Per-schema fetch state. A schema absent from this map is treated as implicit first-page state. */
  schemas: Record<string, SchemaPageState>;
}

/** Initial state: page 1, no per-schema cursors. */
export function initialState(): AllViewState {
  return { depth: 1, schemas: {} };
}

/** Check whether a schema is stuck (exhausted and not yet restored by retreat). */
export function isStuck(state: AllViewState, schema: string): boolean {
  const s = state.schemas[schema];
  if (s == null) return false;
  return s.stuckAt != null && s.stuckAt < state.depth;
}

/** Check whether any non-stuck schema has a next cursor available. */
export function hasNext(state: AllViewState, nextCursors: Record<string, string | null>): boolean {
  for (const [schema, nextCursor] of Object.entries(nextCursors)) {
    if (!isStuck(state, schema) && nextCursor != null) return true;
  }
  return false;
}

/** Check whether retreat is possible. */
export function hasPrev(state: AllViewState): boolean {
  return state.depth > 1;
}

/**
 * Advance to the next page.
 *
 * `nextCursors` maps each visible (non-stuck) schema to its server response
 * `nextCursor` (string or null when exhausted). Stuck schemas are omitted
 * from `nextCursors`. Schemas absent from both `state.schemas` and
 * `nextCursors` are treated as implicit first-page state.
 */
export function advance(state: AllViewState, nextCursors: Record<string, string | null>): AllViewState {
  const newDepth = state.depth + 1;
  const newSchemas: Record<string, SchemaPageState> = {};

  // Union of schemas from current state and input cursors
  const allSchemaNames = new Set<string>([...Object.keys(state.schemas), ...Object.keys(nextCursors)]);

  for (const schema of allSchemaNames) {
    const s = state.schemas[schema];

    if (s != null && s.stuckAt != null && s.stuckAt < state.depth) {
      // Currently stuck — keep unchanged
      newSchemas[schema] = { ...s };
    } else {
      // Not stuck (or implicit first-page) — update from nextCursors
      const nextCursor = nextCursors[schema];
      if (nextCursor != null) {
        newSchemas[schema] = { cursor: nextCursor, direction: "fwd" as const };
      } else {
        // This schema ran out at the old depth
        newSchemas[schema] = { stuckAt: state.depth };
      }
    }
  }

  return { depth: newDepth, schemas: newSchemas };
}

/**
 * Retreat to the previous page.
 *
 * `prevCursors` maps each visible (non-stuck) schema to its server response
 * `prevCursor` (string or null when at first page). Stuck schemas are omitted.
 */
export function retreat(state: AllViewState, prevCursors: Record<string, string | null>): AllViewState {
  const newDepth = state.depth - 1;
  const newSchemas: Record<string, SchemaPageState> = {};

  // Union of schemas from current state and input cursors
  const allSchemaNames = new Set<string>([...Object.keys(state.schemas), ...Object.keys(prevCursors)]);

  for (const schema of allSchemaNames) {
    const s = state.schemas[schema];

    if (s != null && s.stuckAt != null) {
      // Was stuck — check if retreat un-sticks it
      if (s.stuckAt === newDepth) {
        // Retreat to exactly the depth where this schema's last page lives — restore fetch fields
        const prevCursor = prevCursors[schema];
        if (prevCursor != null) {
          newSchemas[schema] = { cursor: prevCursor, direction: "bwd" as const };
        } else {
          // At depth 1, retreat is disabled, but handle gracefully
          newSchemas[schema] = {};
        }
      } else if (s.stuckAt < newDepth) {
        // Still stuck after retreat
        newSchemas[schema] = { ...s };
      } else {
        // stuckAt > newDepth means this schema was not actually stuck at the old depth — shouldn't happen, but be safe
        newSchemas[schema] = { ...s };
      }
    } else {
      // Not stuck (or implicit first-page) — normal retreat
      const prevCursor = prevCursors[schema];
      if (prevCursor != null) {
        newSchemas[schema] = { cursor: prevCursor, direction: "bwd" as const };
      } else {
        // At depth 1, retreat is disabled — empty state means first page
        newSchemas[schema] = {};
      }
    }
  }

  return { depth: newDepth, schemas: newSchemas };
}

/** Encode state to a URL-safe string for the `allview` search param. */
export function encodeState(state: AllViewState): string {
  return JSON.stringify(state);
}

/**
 * Decode state from the `allview` search param value.
 * Returns initial state for null, malformed, or wrong-shape input.
 */
export function decodeState(raw: string | null): AllViewState {
  if (raw == null) return initialState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return initialState();
  }

  if (!isValidState(parsed)) return initialState();

  return parsed as AllViewState;
}

function isValidState(obj: unknown): obj is AllViewState {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.depth !== "number" || !Number.isInteger(o.depth) || o.depth < 1) return false;
  if (typeof o.schemas !== "object" || o.schemas === null || Array.isArray(o.schemas)) return false;
  for (const [, v] of Object.entries(o.schemas)) {
    if (!isValidSchemaPageState(v as unknown)) return false;
  }
  return true;
}

function isValidSchemaPageState(obj: unknown): obj is SchemaPageState {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if ("cursor" in o && typeof o.cursor !== "string") return false;
  if ("direction" in o && o.direction !== "fwd" && o.direction !== "bwd") return false;
  if ("stuckAt" in o && (typeof o.stuckAt !== "number" || !Number.isInteger(o.stuckAt) || o.stuckAt < 1)) return false;
  return true;
}
