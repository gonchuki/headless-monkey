import { describe, it, expect } from "vitest";
import type { SchemaField, SchemaEntry } from "@/lib/api";
import {
  isValidDateString,
  isValueValidForField,
  isStoredValueAffected,
  coerceStoredValue,
  deriveInitialValues,
  schemaLabelField,
  entryLabel,
} from "@/lib/entries";

function makeField(overrides: Partial<SchemaField> = {}): SchemaField {
  return {
    id: 1,
    label: "Test Field",
    type: "text",
    required: false,
    ...overrides,
  };
}

describe("isValidDateString", () => {
  it("accepts well-formed dates", () => {
    expect(isValidDateString("2024-01-15")).toBe(true);
    expect(isValidDateString("2024-12-31")).toBe(true);
  });

  it("rejects malformed shapes", () => {
    expect(isValidDateString("2024-1-5")).toBe(false);
    expect(isValidDateString("not-a-date")).toBe(false);
    expect(isValidDateString("")).toBe(false);
  });

  it("rejects impossible calendar dates", () => {
    expect(isValidDateString("2024-02-30")).toBe(false);
    expect(isValidDateString("2023-02-29")).toBe(false);
  });
});

describe("isValueValidForField", () => {
  it("text: accepts valid strings", () => {
    const field = makeField();
    expect(isValueValidForField(field, "hello")).toBe(true);
  });

  it("text required: rejects empty string", () => {
    const field = makeField({ required: true });
    expect(isValueValidForField(field, "")).toBe(false);
  });

  it("text optional: accepts empty string", () => {
    const field = makeField({ required: false });
    expect(isValueValidForField(field, "")).toBe(true);
  });

  it("number: accepts finite numbers", () => {
    const field = makeField({ type: "number" });
    expect(isValueValidForField(field, 42)).toBe(true);
    expect(isValueValidForField(field, -1)).toBe(true);
  });

  it("number: rejects non-finite", () => {
    const field = makeField({ type: "number" });
    expect(isValueValidForField(field, Infinity)).toBe(false);
    expect(isValueValidForField(field, NaN)).toBe(false);
  });

  it("boolean: accepts booleans", () => {
    const field = makeField({ type: "boolean" });
    expect(isValueValidForField(field, true)).toBe(true);
    expect(isValueValidForField(field, false)).toBe(true);
  });

  it("date: accepts valid date strings", () => {
    const field = makeField({ type: "date" });
    expect(isValueValidForField(field, "2024-01-15")).toBe(true);
  });

  it("date: rejects invalid date strings", () => {
    const field = makeField({ type: "date" });
    expect(isValueValidForField(field, "not-a-date")).toBe(false);
  });

  it("schema-ref: accepts positive integers", () => {
    const field = makeField({ type: "schema-ref" });
    expect(isValueValidForField(field, 1)).toBe(true);
    expect(isValueValidForField(field, 0)).toBe(false);
    expect(isValueValidForField(field, -1)).toBe(false);
  });

  it("unknown type returns false", () => {
    const field = makeField({ type: "unknown" as any });
    expect(isValueValidForField(field, "anything")).toBe(false);
  });
});

describe("isStoredValueAffected", () => {
  it("null stored: affected iff required", () => {
    const required = makeField({ required: true });
    const optional = makeField({ required: false });
    expect(isStoredValueAffected(required, null)).toBe(true);
    expect(isStoredValueAffected(optional, null)).toBe(false);
  });

  it("non-null stored: affected iff invalid for field", () => {
    const field = makeField({ type: "number" });
    expect(isStoredValueAffected(field, "not-a-number")).toBe(true);
    expect(isStoredValueAffected(field, 42)).toBe(false);
  });
});

describe("coerceStoredValue", () => {
  it("text field + number returns stringified", () => {
    const field = makeField({ type: "text" });
    expect(coerceStoredValue(field, 42)).toBe("42");
  });

  it("every other case returns null", () => {
    const field = makeField({ type: "number" });
    expect(coerceStoredValue(field, "42")).toBeNull();
  });

  it("null stored value returns null", () => {
    const field = makeField({ type: "text" });
    expect(coerceStoredValue(field, null)).toBeNull();
  });
});

describe("deriveInitialValues", () => {
  function makeSchema(fields: Partial<SchemaField>[]): SchemaEntry {
    return {
      name: "test",
      version: 1,
      compat_version: 1,
      creation_date: "2024-01-01T00:00:00.000Z",
      created_by: "admin",
      last_modified_date: "2024-01-01T00:00:00.000Z",
      last_modified_by: "admin",
      fields: fields.map((f, i) => ({ id: i + 1, label: `Field ${i + 1}`, type: "text", required: false, ...f })),
    };
  }

  it("non-conflict entry passes stored values through untouched", () => {
    const schema = makeSchema([{ id: 1 }]);
    const result = deriveInitialValues(schema, {
      conflict: false,
      values: { "1": "hello" },
    });
    expect(result).toEqual({ "1": "hello" });
  });

  it("non-conflict entry preserves invalid values (editor surfaces them)", () => {
    const schema = makeSchema([{ id: 1, type: "number" }]);
    const result = deriveInitialValues(schema, {
      conflict: false,
      values: { "1": "not-a-number" },
    });
    expect(result).toEqual({ "1": "not-a-number" });
  });

  it("conflict entry coerces affected fields", () => {
    const schema = makeSchema([{ id: 1, type: "text" }]);
    const result = deriveInitialValues(schema, {
      conflict: true,
      values: { "1": 42 },
    });
    expect(result).toEqual({ "1": "42" });
  });

  it("conflict entry leaves unaffected fields", () => {
    const schema = makeSchema([{ id: 1, type: "text" }]);
    const result = deriveInitialValues(schema, {
      conflict: true,
      values: { "1": "hello" },
    });
    expect(result).toEqual({ "1": "hello" });
  });

  it("missing stored value under conflict+required returns null", () => {
    const schema = makeSchema([{ id: 1, type: "text", required: true }]);
    const result = deriveInitialValues(schema, {
      conflict: true,
      values: {},
    });
    expect(result).toEqual({ "1": null });
  });

  it("keys are String(field.id)", () => {
    const schema = makeSchema([{ id: 42 }]);
    const result = deriveInitialValues(schema, {
      conflict: false,
      values: {},
    });
    expect("42" in result).toBe(true);
  });
});

describe("schemaLabelField", () => {
  function makeSchema(fields: Partial<SchemaField>[]): SchemaEntry {
    return {
      name: "test",
      version: 1,
      compat_version: 1,
      creation_date: "2024-01-01T00:00:00.000Z",
      created_by: "admin",
      last_modified_date: "2024-01-01T00:00:00.000Z",
      last_modified_by: "admin",
      fields: fields.map((f, i) => ({ id: i + 1, label: `Field ${i + 1}`, type: "text", required: false, ...f })),
    };
  }

  it("returns first required field id", () => {
    const schema = makeSchema([{ id: 1 }, { id: 2, required: true }]);
    expect(schemaLabelField(schema)).toBe(2);
  });

  it("returns first field when none required", () => {
    const schema = makeSchema([{ id: 1 }, { id: 2 }]);
    expect(schemaLabelField(schema)).toBe(1);
  });

  it("returns null for empty schema", () => {
    const schema = makeSchema([]);
    expect(schemaLabelField(schema)).toBeNull();
  });
});

describe("entryLabel", () => {
  it("returns label-field value when present", () => {
    const entry = { id: 1, values: { "5": "My Entry" } };
    expect(entryLabel(entry, 5)).toBe("My Entry");
  });

  it("falls back to Entry #<id> when no label field", () => {
    const entry = { id: 42, values: {} };
    expect(entryLabel(entry, null)).toBe("Entry #42");
  });

  it("falls through empty-string value to Entry #<id>", () => {
    const entry = { id: 1, values: { "5": "" } };
    expect(entryLabel(entry, 5)).toBe("Entry #1");
  });
});
