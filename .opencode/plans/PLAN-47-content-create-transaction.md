# PLAN-47 — Wrap ContentService.create in transaction for schema-ref validation

## Goal

`ContentService.create()` validates schema-ref targets via `entryExistsInSchema()` during `buildRows`, then calls `repo.insert()`. Between validation and insert, another request could delete the target entry. The FK constraint on `content_refs.target_content_id` (ON DELETE RESTRICT) catches dangling refs at INSERT time, but throws a raw SQLite error (500) instead of a clean 422. Additionally, the application-level check validates that the target belongs to the correct `ref_schema` — the FK only checks `content.id`, not `content.schema`. Wrap `create` in a transaction so validation and insert are atomic.

## Files involved

- `server/src/services/contentService.ts` — `create()` method; add transaction wrapper matching the pattern already used by `update()`
- `server/src/repositories/contentRepo.ts` — no changes needed; `insert()` already has its own internal transaction

## Implementation approach

1. Wrap the entire `create()` flow in a database transaction using `this.db.transaction()`. This matches the pattern already established by `update()`. The transaction ensures `entryExistsInSchema` validation sees a consistent DB state through insert, and the `ref_schema` validation is atomic with the insert.

2. Handle FK constraint errors: if the FK constraint fires (target deleted between validation and insert), better-sqlite3 throws a `SqliteError`. Catch this inside the transaction and rethrow as `ContentServiceError(422, ...)` so the route handler returns 422 instead of 500.

## Edge cases

- **Nested transactions**: `repo.insert()` has its own internal `this.db.transaction()`. better-sqlite3 handles nested transactions by deferring — the outer transaction commits last. This is safe; no deadlock.
- **Validation errors from buildRows**: `buildRows` throws `ContentServiceError` for invalid values. These propagate through the transaction, which rolls back automatically. No change needed.
- **Schema not found**: `requireSchema` throws before the transaction. This is correct — no need to wrap a read-only check in a transaction.

## Acceptance criteria

1. Creating an entry with a valid schema-ref target succeeds (201).
2. Creating an entry with a non-existent schema-ref target returns 422 (not 500).
3. Creating an entry with a schema-ref target from the wrong schema returns 422.
4. The existing test suite passes — no regression in content creation flow.
5. A concurrent delete of a schema-ref target during entry creation returns 422 (not 500).
