# Keep the breaking-save gate closed while the preview is failing

## Goal

SPEC R37 requires confirmation before a breaking schema update is applied, and the confirmation dialog is the place where the user sees the impact. If the `?preview=true` dry-run request fails (e.g. a transient network error), the dialog currently shows "Couldn't check the impact of this change." yet the Save button stays enabled — and `handleSaveConfirm` reads `previewMutation.data?.breaking ?? false`, so confirming proceeds as if the change were *non*-breaking, bypassing the gate entirely. The gate must stay closed while the preview has no result.

## Files

- `client/src/components/SchemaSaveConfirmDialog.tsx` — the confirm button's `disabled` condition (currently `previewPending || savePending`).
- `client/src/routes/SchemaEditorPage.tsx` — `handleSaveConfirm` (the `breaking ?? false` read).

## Steps

1. Disable the dialog's confirm action while the `previewError` prop is present, in addition to the existing `previewPending || savePending` condition. The prop already flows into the dialog (the page passes `errorMessage(previewMutation.error)` while a save is pending) — no prop or call-site changes are needed.
2. In `handleSaveConfirm`, bail out (no-op) when the preview result is absent. This is defense in depth: after step 1 the confirm button cannot be clicked without a preview result, but the handler should not depend on the button.
3. The retry path is the existing one — document it in the dialog's behavior, not in new UI: canceling the dialog and clicking the page's "Save changes" button again re-fires the preview mutation (a fresh `mutate` call clears the previous error state and reopens the dialog with a live preview). Do not add an in-dialog retry button.

## Edge cases

- The auto-proceed path for non-breaking saves (the `useLayoutEffect` that applies the update immediately when the preview resolves with `breaking === false`) is unaffected: an errored preview is not `isSuccess`, so it can never auto-proceed.
- The affected-entries list is already hidden while `previewError` is set (`previewResolved` accounts for it); only the button state changes in this plan.
- After canceling an errored dialog, the draft is untouched and the preview mutation's error state is cleared by the next `mutate` — verify the dialog reopens normally on retry rather than staying stuck on the old error.

## Acceptance criteria

1. `pnpm --filter client typecheck` passes.
2. Manual (the client package has no test harness in this repo): stage a breaking schema edit (e.g. delete a field), force the preview request to fail (block the `?preview=true` request in devtools, or stop the server), and click "Save changes". The dialog must show "Couldn't check the impact of this change." with the Save button disabled. Cancel; the draft is untouched. Restore the server and click "Save changes" again — the dialog reopens with the impact summary and a working Save button.
3. Manual regression, server running: a breaking save still shows the affected-entries list and, on confirm, saves and lands on the conflicted content filter; a non-breaking save applies immediately with no dialog.
