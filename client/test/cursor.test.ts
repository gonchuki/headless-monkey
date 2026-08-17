import { describe, it, expect } from "vitest";
import { decodeCursor, compareCursors, compareRawCursors } from "@/lib/cursor";

describe("decodeCursor", () => {
  it("returns null for undefined input", () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(decodeCursor(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decodeCursor("")).toBeNull();
  });

  it("decodes legacy bare positive integer cursor", () => {
    const result = decodeCursor("42");
    expect(result).toEqual({ value: 42, id: 42 });
  });

  it("rejects legacy cursor with zero", () => {
    expect(decodeCursor("0")).toBeNull();
  });

  it("rejects legacy cursor with decimal", () => {
    expect(decodeCursor("1.5")).toBeNull();
  });

  it("rejects legacy cursor with negative", () => {
    expect(decodeCursor("-3")).toBeNull();
  });

  it("decodes base64url-encoded JSON cursor with string v", () => {
    const obj = { v: "hello", i: 5 };
    const json = JSON.stringify(obj);
    const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_");
    const result = decodeCursor(b64);
    expect(result).toEqual({ value: "hello", id: 5 });
  });

  it("decodes base64url-encoded JSON cursor with number v", () => {
    const obj = { v: 42, i: 3 };
    const json = JSON.stringify(obj);
    const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_");
    const result = decodeCursor(b64);
    expect(result).toEqual({ value: 42, id: 3 });
  });

  it("decodes base64url-encoded JSON cursor with null v", () => {
    const obj = { v: null, i: 7 };
    const json = JSON.stringify(obj);
    const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_");
    const result = decodeCursor(b64);
    expect(result).toEqual({ value: null, id: 7 });
  });

  it("rejects cursor with i less than 1", () => {
    const obj = { v: "x", i: 0 };
    const json = JSON.stringify(obj);
    const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodeCursor(b64)).toBeNull();
  });

  it("rejects cursor with non-integer i", () => {
    const obj = { v: "x", i: 1.5 };
    const json = JSON.stringify(obj);
    const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodeCursor(b64)).toBeNull();
  });

  it("rejects cursor with boolean v", () => {
    const obj = { v: true, i: 1 };
    const json = JSON.stringify(obj);
    const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodeCursor(b64)).toBeNull();
  });

  it("rejects garbage string", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });

  it("rejects JSON that parses to an array", () => {
    const json = JSON.stringify([1, 2]);
    const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodeCursor(b64)).toBeNull();
  });

  it("rejects JSON that parses to a non-object", () => {
    const json = JSON.stringify("string");
    const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodeCursor(b64)).toBeNull();
  });
});

describe("compareCursors", () => {
  it("both null values: id decides", () => {
    const a = { value: null as number | string | null, id: 1 };
    const b = { value: null as number | string | null, id: 5 };
    expect(compareCursors(a, b)).toBeLessThan(0);
  });

  it("one null value: non-null side is smaller", () => {
    const a = { value: "x", id: 1 };
    const b = { value: null, id: 5 };
    expect(compareCursors(a, b)).toBeLessThan(0);
  });

  it("both numbers: ascending order", () => {
    const a = { value: 1, id: 1 };
    const b = { value: 5, id: 2 };
    expect(compareCursors(a, b)).toBeLessThan(0);
  });

  it("both strings: lexicographic order", () => {
    const a = { value: "a", id: 1 };
    const b = { value: "b", id: 2 };
    expect(compareCursors(a, b)).toBeLessThan(0);
  });

  it("number vs string: number side is smaller", () => {
    const a = { value: 1, id: 1 };
    const b = { value: "x", id: 2 };
    expect(compareCursors(a, b)).toBeLessThan(0);
  });

  it("equal values: id ascending", () => {
    const a = { value: "x", id: 1 };
    const b = { value: "x", id: 5 };
    expect(compareCursors(a, b)).toBeLessThan(0);
  });
});

describe("compareRawCursors", () => {
  it("returns null when either side is undecodable", () => {
    const validCursor = (() => {
      const obj = { v: "x", i: 1 };
      const json = JSON.stringify(obj);
      return btoa(json).replace(/\+/g, "-").replace(/\//g, "_");
    })();
    expect(compareRawCursors(validCursor, "garbage")).toBeNull();
  });

  it("delegates to decoded comparison when both are valid", () => {
    const makeCursor = (v: string | number | null, i: number) => {
      const obj = { v, i };
      const json = JSON.stringify(obj);
      return btoa(json).replace(/\+/g, "-").replace(/\//g, "_");
    };

    const a = makeCursor("a", 1);
    const b = makeCursor("b", 2);
    const result = compareRawCursors(a, b);
    expect(result).not.toBeNull();
    expect(result!).toBeLessThan(0);
  });
});
