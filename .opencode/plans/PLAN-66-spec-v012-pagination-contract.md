# Revise SPEC to v0.12: Bless Public-API Pagination/Sorting and Re-freeze the Contract

## Goal

SPEC.md is at v0.11. The public data API has shipped keyset pagination and field sorting — query params `limit`, `cursor`, `direction`, `sort_field`, `sort_order`, an always-present `pagination` envelope key, and a `modified desc` default ordering — but §3's binding non-goal still reads "No pagination or search in the data API", and §4's frozen contract never documented the new params, the envelope key, or the default ordering (which silently changed observable output for existing consumers). Separately, R32 under-documents that the schema-ref `<select>` filters conflicted entries out of its options (ratified behavior, client-side).

This plan revises SPEC.md to v0.12 with the decision **bless**: amend §3 to scope the non-goal to search only, and document the shipped pagination/sorting contract in §4 so the frozen contract matches observable behavior. The alternative — stripping pagination/sorting from the public routes to restore §3 — was rejected: the feature is fully implemented and tested (including corrected keyset cursor semantics), the public data API is the product's primary deliverable, and §4 itself prescribes a spec revision as the mechanism for contract change.

## Files Involved

- `SPEC.md` — the only file modified. Anchors, all by stable name:
  - The title line (`# SPEC: headless-monkey CMS (v0.11 — ...)`).
  - The changelog list directly under the title (one `vN.M —` line per revision, newest first).
  - §2 requirement R32 (the line beginning "A `schema-ref` field renders a `<select>`").
  - §3 Non-goals (the sentence "No pagination or search in the data API.").
  - §4 `Public API (no auth):` block (from that heading's first bullet through the `values`-keys bullet).

## Implementation Approach

1. **Bump the version.** Change the title line to v0.12 with today's date, keeping the existing `(vX.Y — YYYY-MM-DD)` format.

2. **Add the changelog line** as the newest entry, directly above the v0.11 line, in the existing style (version — prose summary; the touched sections listed at the end). It must record: public-data-API pagination/sorting blessed and documented; §3's non-goal scoped to search; §4 documenting the query params, the `pagination` envelope key, the default ordering, and the 422 rules; R32 recording the conflicted-entry exclusion.

3. **Amend §3.** In the Non-goals paragraph, change "No pagination or search in the data API." to "No search in the data API." Leave every other sentence in the paragraph untouched.

4. **Document the shipped contract in §4.** Amend the `Public API (no auth):` block so that `GET /api/content/:schema`'s documented response includes the always-present `pagination` key and the query parameters are specified. Keep §4's terse contract style (bullets, not prose paragraphs). The documentation must state these facts — all verified against the current implementation; do not invent different behavior:
   - **Params.** `limit`, `cursor`, `direction`, `sort_field`, `sort_order`.
   - **Pagination activation.** Any of `limit`/`cursor`/`direction` present → paginated path; none present → all valid entries, no pagination. Sorting without pagination params is also supported: `sort_field`/`sort_order` alone returns all valid entries in that order.
   - **`limit`.** Integer, clamped to [1, 200]; absent or non-numeric on the paginated path → 50.
   - **`cursor`.** Opaque string; undecodable → first page (lenient).
   - **`direction`.** `forward` | `backward`; any other value is ignored (treated as forward).
   - **`sort_field`.** `id` | `date` | `modified` | a positive integer field_id. **`sort_order`.** `asc` | `desc`; with `sort_order` but no `sort_field`, the sort is by `modified` in that order.
   - **422 rules.** Non-integer/non-literal `sort_field` → 422; integer `sort_field` that is not a field of the schema → 422; sorting by a `boolean` or `schema-ref` field → 422; invalid `sort_order` → 422.
   - **Default ordering.** With no sort params: `modified desc` (last-modified date descending, ties broken by entry id descending).
   - **NULLS LAST.** For a custom-field sort, rows with a NULL value sort last in display order, in both directions.
   - **Envelope.** Both public routes respond with a `pagination: { nextCursor, prevCursor }` key (`string | null`); cursors are null exactly when no entries remain in that direction (keyset on the sort column with entry-id tiebreak).
   - **Out of scope:** the editor route `GET /api/schemas/:name/entries` has its own pagination/sorting params; do not document or change them in this revision.

5. **Add the R32 sentence.** R32 must additionally record that the select's options exclude entries in conflict with the target schema (`schema_version` below the target schema's `compat_version`).

## Edge Cases

1. **Changelog format** — existing entries end with the touched sections in parentheses (e.g. "§2 R21, R38; §7 delete-field example updated"); match it.
2. **Scope of the revision** — this is a documentation revision of an already-shipped contract: no R-number is added, removed, or renumbered; the DB, JWT, value-serialization, and editor-route sections of §4 are untouched; R18/R19 remain accurate as-is (valid-entries-only and 404/422 semantics are unchanged).
3. **§4's own rule** — "Changes here require a spec revision, not a judgment call." This revision *is* that mechanism; the implementer is recording the blessed decision, not making a contract judgment.
4. **The §3 edit** is one sentence of a run-on paragraph; edit only that sentence.

## Acceptance Criteria

1. **Version bump + changelog.** `grep -n "^# SPEC: headless-monkey CMS (v0.12" SPEC.md` matches the title line, and `grep -n "^v0.12 — " SPEC.md` matches exactly one line that sits above the v0.11 entry.
2. **§3 scoped to search.** `grep -n "No pagination" SPEC.md` returns no match, and §3 still contains the sentence "No search in the data API."
3. **§4 documents the contract.** Within the `Public API (no auth):` block of §4, all of the following are present: the five query params (`limit`, `cursor`, `direction`, `sort_field`, `sort_order`); the `pagination` envelope key with `nextCursor`/`prevCursor`; the `modified desc` default ordering; the 422 rules for invalid sort params; the NULLS LAST rule for custom-field sorts; and the clamped/default `limit` behavior.
4. **R32 records the exclusion.** The R32 requirement line mentions that conflicted entries (below the target schema's `compat_version`) are excluded from the select's options.
5. **No other contract changes.** `git diff -- SPEC.md` shows edits confined to: the title line, the changelog list, the §3 pagination/search sentence, the §4 `Public API (no auth):` block, and the R32 line.
