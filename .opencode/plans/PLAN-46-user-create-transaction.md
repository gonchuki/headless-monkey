# PLAN-46 — Wrap UserService.create in transaction for duplicate detection

## Goal

`UserService.create()` checks `findByLogin` then calls `repo.create()`. Between the check and the insert, a concurrent request can insert the same login. The UNIQUE constraint catches it but throws a raw SQLite `SQLITE_CONSTRAINT` error (500 Internal Server Error) instead of the intended 409 Conflict. Wrap the check-and-insert in a transaction so the race window is eliminated.

## Files involved

- `server/src/services/userService.ts` — `create()` method; add transaction wrapper
- `server/src/repositories/userRepo.ts` — no changes needed (the repo methods are called from within the service's transaction)
- `server/src/routes/users.ts` — POST `/` handler; may need to handle SqliteError if the transaction approach doesn't catch it

## Implementation approach

1. Add a new method to `UserRepo` that wraps the existence check and insert in a single transaction. This keeps the transaction logic at the data layer where it belongs and avoids exposing `db` through the service layer. The method should throw an error with `statusCode = 409` when a duplicate login is detected inside the transaction.

2. Update `UserService.create()` to call the new repo method instead of the separate check-then-create pattern. Remove the existence check from the service layer — it is now handled atomically in the repo.

3. Hash the password BEFORE entering the transaction (bcrypt is async; better-sqlite3 transactions are synchronous and cannot contain async operations). Pass the already-hashed password into the transactional method.

## Edge cases

- **Async hashPassword**: `bcrypt.hash()` is async. The transaction must be synchronous (better-sqlite3 transactions are synchronous). The hash must complete before entering the transaction, or the transaction must not contain async operations. Hash the password BEFORE entering the transaction, then pass the hashed value in.
- **Error propagation**: If the transaction throws (duplicate login), the error propagates to the route handler which already maps `statusCode === 409` to a 409 response. No change needed there.

## Acceptance criteria

1. Two concurrent POST requests with the same login: one returns 201, the other returns 409 (not 500).
2. A single POST request with a unique login returns 201 and creates the user.
3. The existing test suite passes — no regression in user creation flow.
4. Two concurrent POST requests with the same login produce one 201 and one 409, never a 500.
