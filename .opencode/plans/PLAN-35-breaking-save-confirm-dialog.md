# PLAN-35 — Breaking-change save confirmation in the schema editor

## Goal

The schema editor currently applies any valid PATCH with one click; breaking changes (retype `text→number`, `optional→required`, delete field, added required field, `ref_schema` retarget) can invalidate existing entries with zero warning. When the user clicks **Save changes** in `SchemaEditorPage` for an **existing** schema, ask the server what the pending PATCH would do (via PLAN-33's `PATCH ?preview=true`), and:

- if the change is **non-breaking** (`breaking: false`): apply the save immediately — the user already clicked Save, don't add friction;
- if **breaking** (`breaking: true`): show a confirmation dialog that lists the affected entries **inline** (the preview payload already carries them), and only apply on explicit confirm. After a confirmed breaking save, land on PLAN-34's `/content/<schema>?conflicted=1` so the remediation hop is one click — always **after** the draft is committed, never before (draft-preservation principle below);
- if the **preview request fails**: surface the failure but keep the Save button available — a preview outage must never block a save (degrades to today's behavior);
- **create mode** (`/schemas/new`) and the **deleted-schema** state skip the preview entirely (no existing entries to warn about; the Save button is already disabled when the schema was deleted).

**Draft-preservation principle: never navigate away from the schema editor with an uncommitted draft.** The editor's field draft lives in component state (`useReducer`); leaving the page destroys it. The dialog therefore must **not** navigate anywhere before the PATCH is confirmed — affected entries are surfaced inside the dialog instead of via a link. The only screen change in this flow is the `onSuccess` landing after the PATCH has applied, when the draft is either committed or the page is leaving anyway.

The client does **not** reimplement the breaking-change table — that logic lives server-side in `SchemaService` (SPEC §7/R13–R14). The dialog is a new component; the existing `DeleteConfirmDialog` is delete-specific (labels, destructive action, no link slot) and is **not** reused.

## Dependencies

- Requires **PLAN-33** — the `PATCH /api/schemas/:name?preview=true` endpoint and its `SchemaUpdatePreview` response shape. Without it the preview query has nothing to call.
- Assumes **PLAN-34** — the post-save landing target for a confirmed breaking save is `/content/<schema>?conflicted=1`, which only filters when the param is implemented. If PLAN-34 is not yet in place, the landing still navigates to the content page (the param just has no effect); the plan authors intend PLAN-34 to land first.

## Files involved

- `client/src/components/SchemaSaveConfirmDialog.tsx` — NEW component; renders the base-ui `AlertDialog` primitives (same set `DeleteConfirmDialog` imports from `@/components/ui/alert-dialog`). One component per file per repo convention.
- `client/src/routes/SchemaEditorPage.tsx` — gate `handleSave` behind the preview flow; hold the pending-save payload; render the dialog.
- `client/src/hooks/useSchemas.ts` — add `useSchemaPatchPreview(name, fields, enabled)`.
- `client/src/lib/api.ts` — add the `SchemaUpdatePreview` response type.
- `client/src/lib/query.ts` — add a `schemaPreview` query-key factory.
- Not touched: `DeleteConfirmDialog.tsx`, `ContentPage.tsx`, server code.

## Implementation approach

1. **Client type** (`client/src/lib/api.ts`): add
   ```ts
   export interface SchemaUpdatePreviewEntry {
     id: number;
     label: string; // human-readable label from PLAN-33 (first required field value, else "Entry #<id>")
     affectedFieldIds: number[];
   }
   export interface SchemaUpdatePreview {
     breaking: boolean;
     version: number;
     compatVersion: number;
     affectedEntries: SchemaUpdatePreviewEntry[];
   }
   ```
   Matching the server response from PLAN-33 exactly (field names must not drift).

2. **Query key** (`client/src/lib/query.ts`): add `schemaPreview: (name: string, fingerprint: string) => ["schemas", "detail", name, "preview", fingerprint] as const`. The fingerprint must change whenever the pending payload changes (see step 3) so a second Save attempt with different fields can never render a stale preview.

3. **Preview hook** (`client/src/hooks/useSchemas.ts`): add
   ```ts
   export function useSchemaPatchPreview(name: string, fields: SchemaFieldInput[], enabled: boolean)
   ```
   returning a `useQuery` that calls `apiFetch<SchemaUpdatePreview>(`/api/schemas/${encodeURIComponent(name)}?preview=true`, { method: "PATCH", body: JSON.stringify({ fields }) })`. Two constraints:
   - `enabled` must be false whenever no save is pending, so **each** Save click transitions disabled→enabled and refetches (React Query fetches when `enabled` flips true);
   - the `queryKey` includes a stable fingerprint of `fields` (e.g. `JSON.stringify(fields)`), because the endpoint is stateless and React Query would otherwise serve a cached preview for a different payload.

4. **Previous-value state in the editor** (`SchemaEditorPage.tsx`): add a single piece of state, e.g. `const [pendingSave, setPendingSave] = useState<{ fields: SchemaFieldInput[] } | null>(null);`. In `handleSave`, keep the existing client-side validation (`fields.length === 0`, blank labels, at least one required field) and `toPayload` unchanged. Create mode calls `create.mutate` exactly as today. Update mode calls `setPendingSave({ fields })` instead of `update.mutate` — the dialog and the preview query key off that state. Clear `pendingSave` when the dialog closes (cancel, confirm, or auto-proceed).

5. **Wire the preview query** in the page: `const previewQuery = useSchemaPatchPreview(state.name, pendingSave?.fields ?? [], pendingSave != null && !deleted);`. Note `state.name` is the schema name for update mode; the query must be disabled in create mode (where `pendingSave` is never set).

6. **Auto-proceed for non-breaking changes.** Add an effect that observes the preview: when `pendingSave != null`, `previewQuery.isSuccess`, and `previewQuery.data.breaking === false`, immediately apply the save — clear `pendingSave`, call `update.mutate({ name: state.name, fields: pendingSave.fields })`, and keep the existing success handler (toast + `navigate("/schemas", { replace: true })` — auto-proceed is only ever non-breaking). This is the "user clicked Save, so non-breaking changes just save" behavior. Keep this effect idempotent (guard on `pendingSave` still being set when it runs).

7. **The dialog component** (`SchemaSaveConfirmDialog.tsx`): props roughly:
   ```ts
   interface SchemaSaveConfirmDialogProps {
     open: boolean;
     onOpenChange: (open: boolean) => void;
     schemaName: string;
     previewPending: boolean;
     previewError: string | null;
     affectedCount: number | null;   // null while preview is loading
     affectedEntries: SchemaUpdatePreviewEntry[] | null; // null while preview is loading
     savePending: boolean;
     saveError: string | null;
     onConfirm: () => void;
   }
   ```
   Render, using `AlertDialog` primitives:
   - **Loading**: description "Checking how many entries are affected…" (matching the existing "Counting affected entries…" tone in the repo) with the confirm disabled.
   - **Preview error**: description "Couldn't check the impact of this change." and the Save action **enabled** — a preview failure degrades to today's behavior.
   - **Breaking**: explanation ("This change will make stored values out of date."), the count line `This will affect N entries.` (pluralize like the existing dialogs), and an **inline, read-only list of the affected entries** — scrollable (`max-h` + `overflow-auto`, capped at 50 rows, then `…and N more`) with each row showing the entry's preview `label` and `#<id>`. The dialog must **not** navigate anywhere; it only closes (Cancel) or confirms. The confirm action is labeled "Save changes" ("Saving…" while `savePending`). Do **not** label it "Delete" or use the delete-specific copy.
   - A `saveError` notice rendered inside the dialog like `DeleteConfirmDialog` renders its `error` prop.

8. **Action wiring in `SchemaEditorPage`**: 
   - **Drive `open` from the pending state**: `open = pendingSave != null`, cleared by cancel, confirm, and auto-proceed (step 6). The loading and preview-error states only ever render inside the dialog, so `open` must **not** be derived from `breaking` alone — a weaker implementation keying the dialog on `breaking === true` would silently drop the loading and error states.
   - `onConfirm`: capture `breakingAtConfirm = previewQuery.data?.breaking ?? false`, then `setPendingSave(null); update.mutate({ name: state.name, fields: pendingSave.fields }, { onSuccess: <success handler> });` where the handler toasts and navigates to `\`/content/${encodeURIComponent(state.name)}?conflicted=1\`` (with `{ replace: true }`) when `breakingAtConfirm` is true and `/schemas` otherwise — this landing is the **only** screen change in the flow and runs strictly after the PATCH applied.
   - `onOpenChange(false)`: `setPendingSave(null)` (cancel only — the dialog never navigates).
   - Live `deleted` guard: if the schema is deleted while the dialog is open, the pending PATCH would 404; bail out of confirm when `deleted` is true (the `update.error` would also surface through `saveError` as a backstop).
   - When `affectedCount === 0` on a breaking change, still show the dialog (a breaking change escalates `compat_version` even with no data); the inline list renders empty.

9. **Create mode and the button disabled state are unchanged.** `canSave` (save button disabled logic) is untouched; `handleSave` still early-returns for invalid drafts, so the dialog only ever opens for a valid payload.

## Edge cases

- **Double-save**: the dialog is modal (base-ui `AlertDialog`), and the confirm is disabled while `savePending`; the auto-proceed effect runs once. Two PATCHes cannot be issued for one Save click.
- **Draft preservation (the reason there is no dialog link)**: the dialog never navigates. Cancel returns to the untouched editor draft; confirm commits the draft server-side and only then does the `onSuccess` landing leave the page. A future implementer must not reintroduce a pre-commit navigation affordance (e.g. a "view affected entries" link) without also stashing the draft — unsubmitted edits would be lost on return.
- **Stale preview across Save attempts**: canceled Save A (fields F1), user changes a field, clicks Save again (fields F2) → the keyed fingerprint forces a fresh preview; never show F1's impact for F2.
- **Preview failure must not block saves**: the confirm action stays enabled on preview error (step 7). This is a deliberate degrade-to-current-behavior decision.
- **Concurrent edit staleness**: the preview reflects the server's current schema state, not the editor draft. If another editor saved meanwhile, the draft can be stale and a save would apply against the newer server schema (a pre-existing gap — the editor has no optimistic concurrency). Do not try to fix version-locking here; the preview at least makes the impact honest at apply time.
- **SSE `schema.updated` while the dialog is open**: invalidates the schema query; the existing `LOAD` guard (`state.loadedName !== name`) ensures the draft isn't clobbered mid-edit. The preview query has its own key and is unaffected.
- **Optional retargeted ref field with no stored target**: such an entry is not in `affectedEntries` (PLAN-33 rule) — the dialog's count reflects only entries whose stored data actually changes.
- **`pendingSave` vs. payload shape**: the preview must receive exactly what `update.mutate` sends — `fields` from `toPayload(state.fields)` with negative draft ids already stripped. Any divergence makes the preview meaningless.

## Acceptance criteria

1. `pnpm --filter client typecheck` exits 0 — `tsc --noEmit` under `strict` + `noUnusedLocals` + `noUnusedParameters`.
2. `pnpm --filter client build` exits 0.
3. **Dependency presence gate**: `pnpm --filter server test` passes in full **and** `grep -n "preview=true" server/test/schemaRoutes.test.ts` shows the PLAN-33 route test. The grep is the ordering gate — the rest of the suite is green today even with PLAN-33 absent, so only the grep can fail until PLAN-33 is executed — while the suite run proves the endpoint behaves as this plan's `SchemaUpdatePreview` client type expects. (Deliberate source-inspection exception: this criterion gates plan ordering, not feature behavior; the behavior itself is exercised by the PLAN-33 route test and by manual criterion 4.)
4. Manual browser verification (no client test infrastructure exists; these cannot be automated mechanically). Start two entries against a schema, then on the schema editor:
   - a. **Breaking change**: retype a field `text→number` and click Save → a dialog appears, shows "This will affect 2 entries." plus an inline list naming both entries, and the Save action is disabled until the preview resolves.
   - b. **Inline list, no navigation**: the dialog shows a scrollable list of the affected entries (label + `#<id>`) and no navigation happens while it is open — canceling returns to the editor with the draft intact.
   - c. **Cancel**: the dialog closes, nothing is saved (the `GET /api/schemas/:name` version is unchanged), and the editor's draft fields are exactly as the user left them.
   - d. **Confirm**: the PATCH applies, the toast reports the new version, and the editor lands on `/content/<schema>?conflicted=1` (filtered to the now-conflicted entries); the entries stay conflicted until re-edited (existing R33 flow).
   - e. **Non-breaking change**: rename a field label and click Save → no dialog, saves immediately, lands on `/schemas`.
   - f. **Create mode**: create a new schema via `/schemas/new` → no dialog.
   - g. **Zero affected entries on a breaking change**: retype a field on a schema with no entries → dialog shows "This will affect 0 entries." and an empty inline list.
   - h. **Preview failure degrade**: with the server stopped, click Save → the dialog reports it couldn't check the impact and the Save action is still enabled.

## Verify notes

`pnpm --filter server test`, then `pnpm --filter client typecheck`, then `pnpm --filter client build`, then the manual checklist (a–h). The endpoint contract this plan consumes — including `SchemaUpdatePreview` — is owned by PLAN-33 and must be executed first. Client test backfill is tracked separately and deliberately out of scope.