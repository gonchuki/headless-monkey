# PLAN-10 — Schema editor: align header with field rows, type first

## Goal

In the schema editor's field list, the column header labels must align with the corresponding row controls, and the field type column must be the first column.

Today the header (in `SchemaFieldGrid`) and each field row (in `SchemaFieldRow`) use the same grid-template string (`grid-cols-[minmax(0,1fr)_7.5rem_auto_auto]`), but they are **separate** CSS grid containers, so the two `auto` tracks resolve from each container's own content and every column boundary shifts: the header's "Required" text is wider than the row's 16px checkbox, and the header's `sr-only` "Actions" span collapses the fourth column to ~0 while the row's three icon buttons need ~92px. The flexible `minmax(0,1fr)` first column absorbs the difference.

The fix: reorder so type is the first column and give the Required and Actions columns **fixed** track widths (identical in header and row) so both containers resolve identical boundaries.

## Files involved

- `client/src/components/SchemaFieldGrid.tsx`
- `client/src/components/SchemaFieldRow.tsx`
- `client/src/lib/schemaGrid.ts` (new) — hosts the shared column-template constant

## Implementation approach

### 1. Define one shared column template

- Create `client/src/lib/schemaGrid.ts` exporting a single constant holding the grid class, e.g. `export const FIELD_GRID_TEMPLATE = "grid grid-cols-[7.5rem_minmax(0,1fr)_5rem_6rem] items-center gap-2"` (values are a starting point — the exact track widths are yours to choose, subject to the invariants below).
- **Do not** define the constant in `SchemaFieldGrid.tsx` or `SchemaFieldRow.tsx`: `SchemaFieldGrid.tsx` already imports `SchemaFieldRow`, so a constant living in the grid file would force the row to import back from it, closing a circular import. The shared module is the one place both can import without a cycle.
- Both `SchemaFieldGrid.tsx` and `SchemaFieldRow.tsx` import and use that constant instead of their own literals.
- Invariants for the template:
  - Column 1 — type: **fixed** (e.g. `7.5rem`) so the type `Select` and the "Field type" header sit in a known-width first column.
  - Column 2 — label: flexible `minmax(0,1fr)` so the label `Input` absorbs leftover width.
  - Column 3 — Required: **fixed** and wide enough to fit the "Required" header text (the row's checkbox is 16px; the header label must not be clipped).
  - Column 4 — Actions: **fixed** and wide enough for the three icon buttons (move up / move down / delete), ~`6rem`. Do not use `auto` — an `auto` Actions track collapses to ~0 in the header (its child is `sr-only`), which is the source of the misalignment.
  - `gap-2` and `items-center` stay.

### 2. Header (`SchemaFieldGrid.tsx`)

- Reorder the header grid's children so the order is: **Field type**, **Field label**, **Required**, `sr-only` "Actions". Keep the `sr-only` "Actions" span (it carries the column's accessible name; with a fixed track it no longer affects layout).
- Apply the shared template to the header grid div.

### 3. Row (`SchemaFieldRow.tsx`)

- Reorder the row grid's children so the order is: type `Select`, label `Input`, required `Checkbox`, actions `div`. Apply the shared template.
- Add `w-full` to the type `SelectTrigger` so it fills its fixed first column (the base `SelectTrigger` class is `w-fit`, so without this the select sits at content width inside the fixed column).
- Leave the `schema-ref` sub-select block (rendered below the row grid when `field.type === "schema-ref"`) untouched — it is outside the grid.

### 4. No other changes

- No changes to `SchemaEditorPage`, the page container (`max-w-2xl`), or any read-only views (there is none — `SchemasPage` is a plain list).

## Edge cases

- **Fixed-column sizing:** each fixed track must be wide enough for its widest content — "Required" header text, the three-icon actions group, and the longest type label in the type select ("Schema reference"). If a label truncates or wraps, widen the track.
- **Type select fills its cell:** without `w-full` on the trigger, the `Select` content (popup width) tracks the trigger, not the column, and the column looks empty to the right of the trigger.
- **`schema-ref` sub-select:** it lives below the grid and must not be pushed into a grid column.
- **Narrow viewports:** the flexible label column absorbs shrinkage first; the fixed columns do not compress. The page is `max-w-2xl`, so this is acceptable; do not add responsive stacking.
- **Single source of truth:** the template must be defined exactly once (in the shared module) and referenced by both the header and the row, so an edit in one place cannot desync the other. This is required, not optional — a duplicated literal is precisely the failure mode that caused this bug.
- **No circular import:** because `SchemaFieldGrid.tsx` imports `SchemaFieldRow.tsx`, the constant must not be defined in either component file; the shared module is the only cycle-free home.

## Acceptance criteria

1. `pnpm --filter client build` passes (the `build` script runs `tsc` and then `vite build`, so it covers type checking as well).
2. Manual (visual, no client test infra exists): run `pnpm -r dev`, open a schema editor; the "Field type", "Field label", and "Required" header labels sit directly above their row controls, the type column is the leftmost column, and the row action buttons align in one right-hand column.
