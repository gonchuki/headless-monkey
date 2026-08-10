# PLAN-32 — Clear affordance for the schema-ref select (M6)

**Milestone / traceability:** Milestone M6 — claims SPEC §2 R32 (schema-ref `<select>` rendering) and SPEC §2 R16 read per the SPEC v0.9 patch-like/null semantics (an explicit `null` for an *optional* field clears its stored value; an omitted key leaves the stored value unchanged; `null` for a *required* field is a 422; the "never `null`" invariant applies to reads/serialization only), matching BUILD_PLAN.md v0.3's M6 step 4 ("for *optional* schema-ref fields the select gains a special `[empty]` entry that submits `null` (which the server's patch-like write semantics treat as the clear signal), removing the stored `content_ref` on save (R16, R32)") and its resolved decision 5 (the OQ1 resolution).

## Goal

A selected schema-ref value in the entry editor cannot currently be deselected: `ReferenceSelect` renders one `<select>` option per target entry and nothing else, so once a value is chosen the only way to clear it is to change the stored entry by other means. Add a special `[empty]` entry to the select, rendered only for **optional** schema-ref fields, that maps to "no value" (`null` in the form state). The null round-trip is the mechanism: `[empty]` → `onChange(null)` → form state `null` → the submit path sends `null` on the wire → the server's existing `null` branch clears the stored `content_ref`. Pre-select `[empty]` whenever the field's current value is `null`, and keep the trigger's disable logic sensible: an optional select with zero target entries must still render and remain openable, because clearing may still be relevant.

**This plan stands alone.** It requires no server change and no companion client plan. The patch-like/null write semantics are already implemented in `ContentService.buildRows` (`server/src/services/contentService.ts`): an explicit `null` on an optional field writes nothing, `ContentRepository.replaceRows` deletes the entry's existing rows and refs before re-inserting the built set, so the stored `content_ref` is removed; an omitted key carries the stored value forward, and `null` on a required field is a 422 — all pinned by existing server tests. Two earlier draft directions are discarded: complete-replacement writes (an absent key would clear the stored value) never matched the server's actual behavior, and payload null-stripping would actively destroy this plan's clear signal, because turning `null` into an absent key would be read by patch-like semantics as "keep stored". The client already sends `null` for empty optional fields today — `deriveInitialValues` in `client/src/lib/entries.ts` initializes them to `null`, and `ContentEditorPage`/`NewContentPage` submit the form `values` as-is — so no payload-stripping or payload-shaping helper is involved.

## Files

- `client/src/components/ReferenceSelect.tsx` — the `ReferenceSelect` component and its use of the shadcn `Select` primitives (`SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` from `@/components/ui/select`). The schema-ref input surface that renders it is `EntryFieldInput` (the `"schema-ref"` case in `client/src/components/EntryFieldInput.tsx`), which passes `value` and `onChange` straight through.

## Approach

1. **Add a module-level sentinel constant** for the empty option in `ReferenceSelect.tsx` — e.g. `const EMPTY_OPTION = "__none__"`. It must be a string that can never collide with a target entry id, which are positive integers (choose a non-numeric string). This constant is the select-internal representation of "no value"; it never leaves the component.

2. **Map the controlled select value through the sentinel.** The shadcn `Select` is string-valued. Pass `value={typeof value === "number" ? String(value) : field.required ? null : EMPTY_OPTION}`:
   - A real selected target id is its string form (unchanged).
   - `null` on an **optional** field maps to the sentinel — this is the pre-select-when-null behavior (the `[empty]` entry shows as selected).
   - `null` on a **required** field stays `null` (no `[empty]` entry exists for required fields, so base-ui keeps showing the placeholder). Required fields can never legitimately submit `null` (the form's validation rejects it, and the server's patch-like read treats required-field `null` as a 422), so no clearing affordance is needed there.

3. **Map selection back through the sentinel in `onValueChange`.** `onChange(selected === EMPTY_OPTION ? null : Number(selected))` — picking `[empty]` yields `null` in the form state; picking a real entry yields its numeric id (unchanged).

4. **Render the `[empty]` entry.** Inside `SelectContent`, for optional fields render a leading `SelectItem` with `value={EMPTY_OPTION}` and display text `[empty]` before the mapped entries. For required fields render nothing extra.

5. **Display it.** The `SelectValue` children render function currently looks up the selected string among `entries` and returns `null` when unmatched. Handle the sentinel before the lookup and return `[empty]` for it — otherwise the trigger would fall through to the placeholder text and look unselected. Keep the existing entry-label lookup and the placeholder text (`Select an entry` / `No entries to reference`) for the genuinely-unselected (required-field, `null`) case.

6. **Fix the trigger disable logic.** The current `disabled={disabled || entries.length === 0}` makes an optional select with zero target entries completely inert. Change it to `disabled={disabled || (field.required && entries.length === 0)}`:
   - Optional + zero targets → still enabled, lists only `[empty]`, so a stored ref can still be cleared.
   - Required + zero targets → disabled, as before (there is nothing to select and nothing to clear).

## Edge cases

- **Sentinel collision.** The sentinel must be a non-numeric string; entry ids are positive integers, so `"__none__"`-style constants are safe. Keep it a named constant, not an inline literal, so the value/onValueChange/display mapping can't drift.
- **Stale numeric value.** If the current value is a number not present in the target list (e.g. a stale cached list), the existing behavior (lookup returns `null`, placeholder shows) is preserved — only the sentinel is special-cased.
- **Required fields never render `[empty]`.** A required schema-ref with `null` must keep showing the placeholder, not a selectable clear entry; the form's client-side validation already blocks submitting a required `null`, and the server's patch-like read would 422 it.
- **Empty target list on an optional field.** The select renders `[empty]` and stays openable; the user can clear even though no targets exist.
- **The null round-trip is the clear signal.** `onChange(null)` flows through `EntryFieldInput`/`DynamicEntryForm` into the form state; `ContentEditorPage`/`NewContentPage` submit `values` as-is, so the payload carries `null` for the field (key present, value `null`) rather than an omitted key. `ContentService.buildRows` sees `submitted === null` on an optional field, writes nothing for it, and `ContentRepository.replaceRows` has already deleted the entry's prior rows and refs — so the stored `content_ref` is removed. Do not add any stripping that would turn this `null` into an omitted key; omitted keys mean "keep stored" under patch-like semantics.

## Acceptance criteria

1. `pnpm --filter client typecheck` exits 0 — `tsc --noEmit` under `strict` + `noUnusedLocals` + `noUnusedParameters` (the client package has no test runner, so this is the mechanical gate).
2. `pnpm --filter client build` exits 0.
3. Manual browser verification (no client test infrastructure exists; these cannot be automated mechanically):
   - For an **optional** schema-ref field, the select shows a selectable `[empty]` entry; when the field has no value it is pre-selected; choosing it clears the field back to no value.
   - Choosing `[empty]` and saving clears the stored ref: the saved entry's editor read (`GET /api/schemas/:name/entries`) and public read both omit the field's key from `values`, and the DevTools network tab shows the save request sends the field's key with value `null` (not an omitted key).
   - For a **required** schema-ref field, no `[empty]` entry appears and the placeholder behavior is unchanged.
   - A schema-ref field whose target schema has zero entries renders an openable select (not a disabled one) when the field is optional, and the `[empty]` entry remains selectable.
