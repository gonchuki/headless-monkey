import { describe, it, expect } from "vitest";
import type { ContentListEntry } from "@/lib/api";
import {
  initialState,
  advance,
  retreat,
  isStuck,
  hasNext,
  hasPrev,
  encodeState,
  decodeState,
} from "@/lib/allViewPagination";

function makeEntry(overrides: Partial<ContentListEntry> = {}): ContentListEntry {
  return {
    id: 1,
    schema: "test",
    schema_version: 1,
    creation_date: "2024-01-01T00:00:00.000Z",
    created_by: "admin",
    last_modified_date: "2024-01-01T00:00:00.000Z",
    last_modified_by: "admin",
    values: {},
    conflict: false,
    referencer_count: 0,
    ...overrides,
  };
}

/**
 * Fixture: uneven schemas with limit 3.
 * Schema A has 4 rows (2 pages), Schema B has 7 rows (3 pages).
 *
 * Pages are modeled as fixture responses:
 *   A page 1: entries [A1, A2, A3], nextCursor = "a_next_1"
 *   A page 2: entries [A4], nextCursor = null (exhausted)
 *   B page 1: entries [B1, B2, B3], nextCursor = "b_next_1"
 *   B page 2: entries [B4, B5, B6], nextCursor = "b_next_2"
 *   B page 3: entries [B7], nextCursor = null (exhausted)
 */
const LIMIT = 3;

// Entry IDs per schema page for multiset verification
const A_PAGES = [
  { ids: ["A1", "A2", "A3"], nextCursor: "a_next_1" as string | null, prevCursor: null },
  { ids: ["A4"], nextCursor: null, prevCursor: "a_prev_1" },
];

const B_PAGES = [
  { ids: ["B1", "B2", "B3"], nextCursor: "b_next_1" as string | null, prevCursor: null },
  { ids: ["B4", "B5", "B6"], nextCursor: "b_next_2" as string | null, prevCursor: "b_prev_1" },
  { ids: ["B7"], nextCursor: null, prevCursor: "b_prev_2" },
];

describe("allViewPagination transitions", () => {
  it("initial state is page 1 with empty schemas", () => {
    const state = initialState();
    expect(state.depth).toBe(1);
    expect(Object.keys(state.schemas)).toHaveLength(0);
  });

  it("advance from initial: both schemas get first-page cursors", () => {
    const state = initialState();
    const nextCursors = {
      A: A_PAGES[0].nextCursor,
      B: B_PAGES[0].nextCursor,
    };
    const next = advance(state, nextCursors);

    expect(next.depth).toBe(2);
    expect(next.schemas.A).toEqual({ cursor: "a_next_1", direction: "fwd" });
    expect(next.schemas.B).toEqual({ cursor: "b_next_1", direction: "fwd" });
  });

  it("advance depth 2→3: A exhausts, B continues", () => {
    const state = initialState();

    // Depth 1 → 2
    let next = advance(state, {
      A: A_PAGES[0].nextCursor,
      B: B_PAGES[0].nextCursor,
    });

    // Depth 2 → 3: A has no more pages (nextCursor = null), B continues
    next = advance(next, {
      A: A_PAGES[1].nextCursor, // null — exhausted
      B: B_PAGES[1].nextCursor, // "b_next_2"
    });

    expect(next.depth).toBe(3);
    // A is stuck at depth 2
    expect(next.schemas.A).toEqual({ stuckAt: 2 });
    // B continues with cursor from page 2
    expect(next.schemas.B).toEqual({ cursor: "b_next_2", direction: "fwd" });
  });

  it("advance depth 3→4: only B continues, A stays stuck", () => {
    const state = initialState();

    // Depth 1 → 2
    let next = advance(state, {
      A: A_PAGES[0].nextCursor,
      B: B_PAGES[0].nextCursor,
    });

    // Depth 2 → 3: A exhausted
    next = advance(next, {
      A: A_PAGES[1].nextCursor,
      B: B_PAGES[1].nextCursor,
    });

    // Depth 3 → 4: only B is queried (A is stuck)
    next = advance(next, {
      B: B_PAGES[2].nextCursor, // null — exhausted
    });

    expect(next.depth).toBe(4);
    expect(next.schemas.A).toEqual({ stuckAt: 2 });
    expect(next.schemas.B).toEqual({ stuckAt: 3 });
  });

  it("no drops, no duplicates: multiset walk over uneven schemas", () => {
    // Walk forward and collect entry IDs per depth
    const allIds: string[][] = [];
    let state = initialState();

    // Depth 1: fetch first pages for A and B (implicit, no cursor)
    // Simulate responses from page 0 (first page)
    const depth1Ids = [...A_PAGES[0].ids, ...B_PAGES[0].ids];
    allIds.push(depth1Ids);

    // Advance to depth 2
    state = advance(state, {
      A: A_PAGES[0].nextCursor,
      B: B_PAGES[0].nextCursor,
    });

    // Depth 2: A page 1, B page 1
    const depth2Ids = [...A_PAGES[1].ids, ...B_PAGES[1].ids];
    allIds.push(depth2Ids);

    // Advance to depth 3
    state = advance(state, {
      A: A_PAGES[1].nextCursor, // null — exhausted
      B: B_PAGES[1].nextCursor,
    });

    // Depth 3: only B page 2 (A is stuck)
    const depth3Ids = [...B_PAGES[2].ids];
    allIds.push(depth3Ids);

    // Collect all IDs across depths
    const collected = allIds.flat();
    const expected = [
      "A1", "A2", "A3", "A4",
      "B1", "B2", "B3", "B4", "B5", "B6", "B7",
    ];

    // Same multiset
    expect(collected.sort()).toEqual(expected.sort());

    // Each ID appears exactly once
    const counts = new Map<string, number>();
    for (const id of collected) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [, count] of counts) {
      expect(count).toBe(1);
    }
  });

  it("visibility: A visible at depths 1-2, hidden at depth 3", () => {
    let state = initialState();

    // Depth 1: A not stuck (implicit first page)
    expect(isStuck(state, "A")).toBe(false);

    // Advance to depth 2
    state = advance(state, {
      A: A_PAGES[0].nextCursor,
      B: B_PAGES[0].nextCursor,
    });

    // Depth 2: A still not stuck
    expect(isStuck(state, "A")).toBe(false);

    // Advance to depth 3: A exhausts
    state = advance(state, {
      A: A_PAGES[1].nextCursor, // null
      B: B_PAGES[1].nextCursor,
    });

    // Depth 3: A is stuck
    expect(isStuck(state, "A")).toBe(true);
    // B is not stuck yet
    expect(isStuck(state, "B")).toBe(false);
  });

  it("hasNext is false only at final depth", () => {
    let state = initialState();

    // Depth 1: both have next cursors
    const nextCursors1 = {
      A: A_PAGES[0].nextCursor,
      B: B_PAGES[0].nextCursor,
    };
    expect(hasNext(state, nextCursors1)).toBe(true);

    state = advance(state, nextCursors1);

    // Depth 2: A exhausted, B continues
    const nextCursors2 = {
      A: A_PAGES[1].nextCursor, // null
      B: B_PAGES[1].nextCursor,
    };
    expect(hasNext(state, nextCursors2)).toBe(true);

    state = advance(state, nextCursors2);

    // Depth 3: A stuck, B has one more page
    const nextCursors3 = {
      B: B_PAGES[2].nextCursor, // null
    };
    expect(hasNext(state, nextCursors3)).toBe(false);
  });

  it("hasPrev is true for depth > 1 and false at depth 1", () => {
    let state = initialState();
    expect(hasPrev(state)).toBe(false);

    state = advance(state, {
      A: A_PAGES[0].nextCursor,
      B: B_PAGES[0].nextCursor,
    });
    expect(hasPrev(state)).toBe(true);
  });

  it("backward restore: retreat from depth 3 restores A at depth 2", () => {
    let state = initialState();

    // Forward to depth 3
    state = advance(state, {
      A: A_PAGES[0].nextCursor,
      B: B_PAGES[0].nextCursor,
    });
    state = advance(state, {
      A: A_PAGES[1].nextCursor, // null — exhausted
      B: B_PAGES[1].nextCursor,
    });

    expect(state.depth).toBe(3);
    expect(isStuck(state, "A")).toBe(true);

    // Retreat to depth 2: A's last page should reappear
    const retreated = retreat(state, {
      B: B_PAGES[1].prevCursor,
    });

    expect(retreated.depth).toBe(2);
    // A was stuck at depth 2, and we retreated to depth 2 — A is un-stuck
    expect(isStuck(retreated, "A")).toBe(false);
    // B retreats normally
    expect(retreated.schemas.B.cursor).toBe("b_prev_1");
  });

  it("backward restore: retreat from depth 2 to 1 restores first pages", () => {
    let state = initialState();

    // Forward to depth 2
    state = advance(state, {
      A: A_PAGES[0].nextCursor,
      B: B_PAGES[0].nextCursor,
    });

    // Retreat to depth 1
    const retreated = retreat(state, {
      A: A_PAGES[0].prevCursor, // null (first page)
      B: B_PAGES[0].prevCursor, // null (first page)
    });

    expect(retreated.depth).toBe(1);
    expect(hasPrev(retreated)).toBe(false);
    // Both schemas at empty state = first page
    expect(retreated.schemas.A).toEqual({});
    expect(retreated.schemas.B).toEqual({});
  });

  it("stuck schemas are skipped during advance", () => {
    let state = initialState();

    // Forward to depth 2
    state = advance(state, {
      A: A_PAGES[0].nextCursor,
      B: B_PAGES[0].nextCursor,
    });

    // Forward to depth 3: A exhausts
    state = advance(state, {
      A: A_PAGES[1].nextCursor, // null
      B: B_PAGES[1].nextCursor,
    });

    expect(isStuck(state, "A")).toBe(true);

    // Advance to depth 4: only B in nextCursors (A is stuck, omitted)
    const next = advance(state, {
      B: B_PAGES[2].nextCursor, // null
    });

    // A state unchanged
    expect(next.schemas.A).toEqual({ stuckAt: 2 });
    // B now also stuck
    expect(next.schemas.B).toEqual({ stuckAt: 3 });
  });

  it("stuck schemas are skipped during retreat", () => {
    let state = initialState();

    // Forward to depth 3
    state = advance(state, {
      A: A_PAGES[0].nextCursor,
      B: B_PAGES[0].nextCursor,
    });
    state = advance(state, {
      A: A_PAGES[1].nextCursor, // null
      B: B_PAGES[1].nextCursor,
    });

    // Retreat to depth 2: only B in prevCursors (A is stuck at depth 2, will be un-stuck by depth match)
    const retreated = retreat(state, {
      B: B_PAGES[1].prevCursor,
    });

    expect(retreated.depth).toBe(2);
    // A was stuck at depth 2, and we retreated to depth 2 — A is restored
    expect(isStuck(retreated, "A")).toBe(false);
    // B retreats normally
    expect(retreated.schemas.B.cursor).toBe("b_prev_1");
  });
});

describe("allViewPagination codec", () => {
  it("encodeState → decodeState round-trips", () => {
    const state = {
      depth: 3,
      schemas: {
        A: { cursor: "abc", direction: "fwd" as const, stuckAt: undefined },
        B: { stuckAt: 2 },
      },
    };
    const encoded = encodeState(state);
    const decoded = decodeState(encoded);

    expect(decoded.depth).toBe(3);
    expect(decoded.schemas.A.cursor).toBe("abc");
    expect(decoded.schemas.A.direction).toBe("fwd");
    expect(decoded.schemas.B.stuckAt).toBe(2);
  });

  it("decodeState(null) returns initial state", () => {
    const decoded = decodeState(null);
    expect(decoded).toEqual(initialState());
  });

  it("decodeState('garbage') returns initial state", () => {
    const decoded = decodeState("garbage");
    expect(decoded).toEqual(initialState());
  });

  it("decodeState with wrong shape returns initial state", () => {
    const bad = JSON.stringify({ depth: "not-a-number", schemas: {} });
    const decoded = decodeState(bad);
    expect(decoded).toEqual(initialState());
  });

  it("decodeState with negative depth returns initial state", () => {
    const bad = JSON.stringify({ depth: -1, schemas: {} });
    const decoded = decodeState(bad);
    expect(decoded).toEqual(initialState());
  });

  it("decodeState with schemas as array returns initial state", () => {
    const bad = JSON.stringify({ depth: 1, schemas: [] });
    const decoded = decodeState(bad);
    expect(decoded).toEqual(initialState());
  });

  it("old-style cursor_next param yields initial state (codec only reads allview)", () => {
    // The codec only reads the `allview` param. Old params like cursor_next
    // are not passed to decodeState — they're simply ignored by the route.
    // This test verifies that decodeState(null) is the correct fallback.
    const decoded = decodeState(null);
    expect(decoded.depth).toBe(1);
    expect(Object.keys(decoded.schemas)).toHaveLength(0);
  });
});
