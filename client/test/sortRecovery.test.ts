import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import { isStaleSortError, dropSortParams } from "@/lib/sortRecovery";

describe("isStaleSortError", () => {
  it("matches 'Unknown sort field_id:' prefix", () => {
    const error = new ApiError(422, "Unknown sort field_id: 42");
    expect(isStaleSortError(error)).toBe(true);
  });

  it("matches 'Cannot sort by field' prefix", () => {
    const error = new ApiError(422, "Cannot sort by field 'Active' (type: boolean)");
    expect(isStaleSortError(error)).toBe(true);
  });

  it("matches 'Invalid sort_field:' prefix", () => {
    const error = new ApiError(422, "Invalid sort_field: must be 'id', 'date', 'modified', or a positive integer");
    expect(isStaleSortError(error)).toBe(true);
  });

  it("matches 'Invalid sort_order:' prefix", () => {
    const error = new ApiError(422, "Invalid sort_order: must be 'asc' or 'desc'");
    expect(isStaleSortError(error)).toBe(true);
  });

  it("rejects other 422 messages", () => {
    expect(isStaleSortError(new ApiError(422, "Missing required field 'name'"))).toBe(false);
    expect(isStaleSortError(new ApiError(422, "Entry 5 not found"))).toBe(false);
  });

  it("rejects non-422 ApiErrors even with matching-looking messages", () => {
    const error = new ApiError(500, "Unknown sort field_id: 42");
    expect(isStaleSortError(error)).toBe(false);
  });

  it("rejects plain Error objects", () => {
    expect(isStaleSortError(new Error("Unknown sort field_id: 42"))).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isStaleSortError(null)).toBe(false);
    expect(isStaleSortError(undefined)).toBe(false);
  });
});

describe("dropSortParams", () => {
  it("drops sort keys and page while preserving other params", () => {
    const params = new URLSearchParams({
      sort_field: "42",
      sort_order: "desc",
      conflicted: "1",
      page: "2",
    });

    const result = dropSortParams(params);

    expect(result).not.toBeNull();
    expect(result!.get("sort_field")).toBeNull();
    expect(result!.get("sort_order")).toBeNull();
    expect(result!.get("conflicted")).toBe("1");
    // A page derived under a dead sort is meaningless — pagination restarts
    // at page 1, so page is dropped along with the sort keys.
    expect(result!.get("page")).toBeNull();
  });

  it("returns null when no sort param is present", () => {
    const params = new URLSearchParams({ conflicted: "1", page: "2" });
    expect(dropSortParams(params)).toBeNull();
  });

  it("never mutates its input", () => {
    const params = new URLSearchParams({ sort_field: "42", sort_order: "desc", page: "3" });
    dropSortParams(params);

    expect(params.get("sort_field")).toBe("42");
    expect(params.get("sort_order")).toBe("desc");
    expect(params.get("page")).toBe("3");
  });

  it("handles only sort_field present", () => {
    const params = new URLSearchParams({ sort_field: "42", page: "1" });
    const result = dropSortParams(params);

    expect(result).not.toBeNull();
    expect(result!.get("sort_field")).toBeNull();
    expect(result!.get("page")).toBeNull();
  });

  it("handles only sort_order present", () => {
    const params = new URLSearchParams({ sort_order: "asc", conflicted: "1" });
    const result = dropSortParams(params);

    expect(result).not.toBeNull();
    expect(result!.get("sort_order")).toBeNull();
    expect(result!.get("conflicted")).toBe("1");
  });
});
