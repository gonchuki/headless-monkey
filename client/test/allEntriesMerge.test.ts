import { describe, it, expect } from "vitest";
import { mergeAllEntriesPages } from "@/lib/allEntriesMerge";
import type { ContentListEntry } from "@/lib/api";

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

describe("mergeAllEntriesPages", () => {
  it("concatenates entries from multiple schemas", () => {
    const pages = [
      {
        entries: [makeEntry({ id: 1 })],
        pagination: { nextCursor: "cursor_a", prevCursor: null },
      },
      {
        entries: [makeEntry({ id: 2 })],
        pagination: { nextCursor: "cursor_b", prevCursor: null },
      },
    ];
    const result = mergeAllEntriesPages(pages, true);
    expect(result.data).toHaveLength(2);
  });

  it("sorts entries by last_modified_date descending", () => {
    const pages = [
      {
        entries: [makeEntry({ id: 1, last_modified_date: "2024-01-01T00:00:00.000Z" })],
        pagination: { nextCursor: "a", prevCursor: null },
      },
      {
        entries: [makeEntry({ id: 2, last_modified_date: "2024-06-01T00:00:00.000Z" })],
        pagination: { nextCursor: "b", prevCursor: null },
      },
    ];
    const result = mergeAllEntriesPages(pages, true);
    expect(result.data[0].id).toBe(2);
    expect(result.data[1].id).toBe(1);
  });

  it("returns flat entries and null pagination when not paginated", () => {
    const pages = [
      {
        entries: [makeEntry({ id: 1 })],
        pagination: undefined,
      },
      {
        entries: [makeEntry({ id: 2 })],
        pagination: undefined,
      },
    ];
    const result = mergeAllEntriesPages(pages, false);
    expect(result.data).toHaveLength(2);
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.prevCursor).toBeNull();
  });

  it("nextCursor is null when any schema's nextCursor is null (known bug)", () => {
    const pages = [
      {
        entries: [makeEntry({ id: 1 })],
        pagination: { nextCursor: "cursor_a", prevCursor: null },
      },
      {
        entries: [makeEntry({ id: 2 })],
        pagination: { nextCursor: null, prevCursor: null },
      },
    ];
    const result = mergeAllEntriesPages(pages, true);
    // Known bug: any null cursor resets the merged cursor to null
    expect(result.pagination.nextCursor).toBeNull();
  });

  it("prevCursor is null when any schema's prevCursor is null (known bug)", () => {
    const pages = [
      {
        entries: [makeEntry({ id: 1 })],
        pagination: { nextCursor: "cursor_a", prevCursor: "prev_a" },
      },
      {
        entries: [makeEntry({ id: 2 })],
        pagination: { nextCursor: "cursor_b", prevCursor: null },
      },
    ];
    const result = mergeAllEntriesPages(pages, true);
    // Known bug: any null cursor resets the merged cursor to null
    expect(result.pagination.prevCursor).toBeNull();
  });

  it("handles empty pages", () => {
    const result = mergeAllEntriesPages([], true);
    expect(result.data).toHaveLength(0);
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.prevCursor).toBeNull();
  });

  it("handles single schema page", () => {
    const pages = [
      {
        entries: [makeEntry({ id: 1 })],
        pagination: { nextCursor: "only_cursor", prevCursor: null },
      },
    ];
    const result = mergeAllEntriesPages(pages, true);
    expect(result.data).toHaveLength(1);
    expect(result.pagination.nextCursor).toBe("only_cursor");
  });
});
