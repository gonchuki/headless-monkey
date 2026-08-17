# Fix Sort Dropdown Behavior

> **Dependency:** This plan assumes **PLAN-59-keyset-pagination.md** has already been executed. This plan makes `modified desc` the default sort, and the default view paginates — cursor pagination must already be correct for non-id sorts (keyset on the sort column, opaque string cursors) or the default view will misbehave from page 2 onward.

## Goal

Consolidate the "Newest first" and "Oldest first" options in the content-listing sort dropdown into a single **"Modified date"** option, with sort direction controlled by the adjacent toggle button.

The "Modified date" option must actually sort by `content.last_modified_date`. An earlier draft of this plan reused the existing `sort_field=id` token and merely relabeled it — but server-side `"id"` maps to `ORDER BY content.id` (primary key ≈ creation order), so the label would have been false. This revision threads a new **`"modified"`** sort token end-to-end (validation → service → SQL) and points the UI option at it. It also makes `modified desc` the system default sort, so the dropdown's first option matches what an unsorted URL actually does.

## Files Involved

- `server/src/types.ts` — `SortParams`, `ResolvedSortParams`
- `server/src/routes/paramValidation.ts` — `parseSortParams`
- `server/src/services/contentService.ts` — `ContentService.resolveSort`
- `server/src/repositories/contentRepo.ts` — `buildOrderClause`, `listEntries`, `listEntriesPaginated`
- `client/src/routes/ContentPage.tsx` — sort selector UI and URL state
- `server/test/contentService.test.ts` — modified-sort regression tests
- `server/test/paramValidation.test.ts` — new token acceptance tests (file exists but has no sort-param tests today)

## Implementation Approach

### 1. Extend the sort token type (`types.ts`)

Add `"modified"` to the `sortField` union in both `SortParams` and `ResolvedSortParams` (currently `number | "id" | "date"`), and update the doc comment so it states: `'id'` → `content.id`, `'date'` → `creation_date`, `'modified'` → `last_modified_date`.

### 2. Accept the token at the API boundary (`paramValidation.ts`)

In `parseSortParams`:
- Accept `"modified"` alongside `"id"` and `"date"` as a valid literal `sort_field` value, and update the 422 error message to enumerate it.
- Change the fieldless default (used when only `sort_order` is present, currently `{ sortField: "id" }`) to `{ sortField: "modified" }`.

### 3. Pass the token through sort resolution (`contentService.ts`)

In `ContentService.resolveSort`, extend the short-circuit branch that passes `"id"` / `"date"` through without a field lookup so it also includes `"modified"`.

### 4. Emit the ORDER BY clause and change defaults (`contentRepo.ts`)

- In `buildOrderClause`, add a case for `"modified"`: `ORDER BY content.last_modified_date <dir>, content.id <dir>` — the tiebreaker follows the **sort direction**, unlike other non-id sorts, which keep the existing universal `, content.id ASC`. Rationale: under `modified desc`, same-timestamp entries then render newest-created first, matching "Newest first"; and because every existing default-order test fixture only *creates* entries (never updates them), `last_modified_date` is monotonic-with-id or equal in those fixtures, so `modified desc, id desc` reproduces today's `id desc` output exactly — those tests stay green deterministically with no fixture changes.
- Change the default sort in both `listEntries` and `listEntriesPaginated` (currently `sort ?? { sortField: "id", sortOrder: "desc" }`) to `{ sortField: "modified", sortOrder: "desc" }`.

Constraint: `last_modified_date` is TEXT written via `new Date().toISOString()` (fixed-width ISO-8601 UTC), so lexicographic order equals chronological order — do **not** add CAST/strftime handling.

### 5. Point the dropdown at the new token (`ContentPage.tsx`)

In the sort-selector section of `ContentPage`:
- Replace the "Newest first" / "Oldest first" options with a single `<SelectItem value="modified">Modified date</SelectItem>`.
- In `handleSortChange`, handle `"modified"` by setting `sort_field=modified` and preserving the current sort order from the URL (the existing `"date"` branch hardcodes `asc`; do not copy that behavior — direction is controlled by the toggle). Custom field options keep defaulting to `asc`.
- Replace the select-value derivation branches that map `"id"` + direction to `"newest"` / `"oldest"` with a single mapping: both `"modified"` and legacy `"id"` resolve to the "Modified date" option. `"date"` and custom field ids pass through as today. Update the label mapping so the resolved value renders "Modified date".
- Change the client default sort fallback (currently `sortFieldRaw ?? "id"`) to `?? "modified"`, so a URL with no sort params actually sorts by modified date, matching what the dropdown shows.
- In `handleSortOrderToggle`, normalize a legacy `"id"` to `"modified"` when rewriting the URL: if `sortField === "id"`, write `sort_field=modified` instead of `sort_field=id`. This ensures the URL is rewritten to the canonical token on the first interaction.

### 6. Tests

In `server/test/contentService.test.ts` (which has an existing sort test suite for `listForSchema`):
- Add the key regression test proving the sort is by modification time, not row id: create two entries such that the **earlier-created** entry is modified after the later-created one, then assert that `{ sortField: "modified", sortOrder: "desc" }` returns the earlier-created entry first even though its `id` is lower. This test fails against `ORDER BY content.id`, which is the whole point of this plan. Also cover ascending order.
  - **The timestamps must be set explicitly, not left to wall-clock time.** `last_modified_date` has millisecond precision and is written from `new Date()`; if the create/update calls land in the same millisecond the two entries' timestamps are equal and the assertion would pass or fail via the id tiebreak instead of proving modification-time sorting. The test's `setup()` exposes the raw `db` — after creating the entries, write distinct ISO-8601 values directly with `UPDATE content SET last_modified_date = ? WHERE id = ?`.
- Add a pagination walk for `modified desc` (small limit, forward from page 1) asserting every row appears exactly once — this exercises the PLAN-59 keyset path with the new sort column and proves no pagination change was needed.

In `server/test/paramValidation.test.ts`:
- Assert `parseSortParams` accepts `sort_field=modified` (returning `{ sortField: "modified" }`) and still rejects an unknown literal with 422.

## Edge Cases

1. **Legacy URLs** — bookmarked or shared URLs may still contain `sort_field=id`. The server must keep accepting `"id"` (backward compatibility for direct API consumers), but the UI never emits it again: the select-value derivation treats `"id"` as the "Modified date" option, and any sort interaction rewrites the URL with `sort_field=modified` — `handleSortChange` writes `"modified"` directly, and `handleSortOrderToggle` normalizes legacy `"id"` to `"modified"` before navigating.
2. **Ties** — entries sharing the same `last_modified_date` are ordered by `content.id` in the **same direction as the sort** (`id desc` under `modified desc`, `id asc` under `modified asc`), so "newest first" holds within a same-millisecond group. This is deliberate: it makes the new default reproduce today's `id desc` order whenever timestamps tie, which keeps every existing default-order test deterministic (those fixtures only create entries, so `last_modified_date` is monotonic-with-id or equal).
3. **Timestamp format** — `last_modified_date` is always written as `new Date().toISOString()` (fixed-width ISO-8601 UTC), so a plain lexicographic ORDER BY on the TEXT column is chronological. Do not add CAST/strftime handling.
4. **Direction toggle** — the existing toggle handler flips asc/desc for whatever `sort_field` is in the URL; it works unchanged for `"modified"` once the URL carries that token (it must normalize a legacy `"id"` per edge case 1).

## Acceptance Criteria

1. **Server behavior + no regressions.** `cd server && npx vitest run` exits 0, with a suite that includes: (a) the new regression test — for two entries where the earlier-created entry was modified later, `{ sortField: "modified", sortOrder: "desc" }` returns it first despite its lower id, and ascending order is the reverse; (b) the new `modified desc` pagination walk asserting every row appears exactly once across pages; (c) the new `parseSortParams` test accepting `sort_field=modified` while an unknown literal still throws 422; (d) all pre-existing sort and default-order pagination tests unchanged — the direction-matching tiebreak from step 4 keeps the default-order fixtures deterministic, so no fixture edits are needed.
2. **Client type-checks.** `cd client && npx tsc --noEmit` exits 0.
3. **UI behavior (manual — requires a running app with a schema that has entries).** Open the content page with a schema selected: the dropdown shows "Modified date", "Creation date", and any custom fields, and "Newest first" / "Oldest first" are gone. Selecting "Modified date" puts `sort_field=modified` in the URL; the direction button flips `sort_order` between asc/desc and reorders the entries (icon changes); navigating away and back preserves the selection via URL params.
