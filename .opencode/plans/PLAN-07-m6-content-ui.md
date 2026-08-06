# PLAN-07: M6 — Content UI (client)

**Originating milestone:** M6
**Depends on:** PLAN-04 (entry endpoints + conflict flag; confirm server suite passes), PLAN-06 (provides `NewEntrySelector`, schema listing, `useSchemas`)

## Goal

Editor creates/edits entries against a schema with type-appropriate inputs, a schema-ref `<select>`, conflicted-entry dual-field rendering, and optimistic/skeleton UX throughout.

## Spec refs (verbatim from milestone M6)

SPEC §2 R31, R32, R33; §4 content routes + serialization; §5 optimistic updates/skeletons.

## Files involved

- `client/src/routes/ContentPage.tsx`, `client/src/routes/ContentEditorPage.tsx`, `client/src/routes/NewContentPage.tsx`
- `client/src/hooks/useEntries.ts`
- `client/src/components/DynamicEntryForm.tsx`, `client/src/components/EntryFieldInput.tsx`
- `client/src/components/ReferenceSelect.tsx`
- `client/src/components/ConflictField.tsx`

## Approach

1. **List page:** `ContentPage` — entries for a schema with an edit button per row and conflict highlighting (from the `conflict` flag on `GET /api/schemas/:name/entries`). Skeletons on load; optimistic delete (R28).
2. **New content:** `NewContentPage` uses `NewEntrySelector` from PLAN-06; disabled when zero schemas.
3. **Dynamic form:** `DynamicEntryForm` — 2-column layout, `label | type-input` per field, red `*` next to required labels (R31). Field-type inputs per SPEC §2: text→`<input type="text">`, number→`<input type="number">`, date→`<input type="date">`, boolean→`<input type="checkbox">`.
4. **schema-ref select (R32):** `ReferenceSelect` lists the target schema's entries, each option labeled by the value of the target's *first required field by `sort_order`* (fallback: first field by `sort_order`; entry id when empty).
5. **Conflicted entry (R33):** when `conflict: true`, render each *affected* stored (old) field disabled with the new enabled field below it; unaffected fields render normally. Auto-coerced values (`number`→`text`) carry over into the new field; otherwise it starts empty (resolved decision #4). On save, validation re-runs and `schema_version` updates (R17). The editor loads its entry from `GET /api/schemas/:name/entries` — SPEC §4 defines no single-entry GET.
6. **Mutations:** `useEntries` with optimistic updates and query invalidation; required-field errors (including required `text` must be non-empty) surface inline (R16).

## Edge cases

- Required `text` validation: empty string is invalid — show an inline error before submit and rely on the server 422 as backstop (resolved decision #3).
- A schema-ref whose target schema has no required fields must still produce labels (fallback to first field by sort order, then entry id).
- After a breaking schema change, a previously-valid number that became text coerces and pre-fills; a text that became number must be re-entered (resolved decision #4).
- When saving an entry whose schema is gone (deleted concurrently), surface the 404 without crashing the form.
- Dates must serialize as `"YYYY-MM-DD"` per SPEC §4.

## Acceptance criteria

1. `pnpm --filter client build` passes.
2. Manual E2E against a running server: create an entry exercising every field type; each field renders the input element listed in approach step 3 (text→`<input type="text">`, number→`<input type="number">`, date→`<input type="date">`, boolean→`<input type="checkbox">`) in the 2-column `label | type-input` layout, with a red `*` next to required labels (R31).
3. A schema-ref field renders a `<select>` whose options are labeled by the target's first required field (R32). Cannot be verified mechanically; verify manually in a browser.
4. Manual E2E: make a breaking schema change (e.g. add a required field), reload the entry → it renders conflicted with old fields disabled and new fields enabled below (R33); save → entry becomes valid (R17).
5. A required text field rejects an empty string with an inline error (R16). Cannot be verified mechanically; verify manually in a browser.
6. Coercion (resolved decision #4): change a `number` field to `text` and reload a conflicted entry → the new field pre-fills with the coerced string; change a `text` field to `number` → the new field starts empty and save is blocked until a valid number is entered.

Milestone M6 verify gate (preserved): `pnpm --filter client build`; manual: create an entry exercising every field type; make a breaking schema change, reload the entry → dual-field conflicted editor, save → entry valid.
