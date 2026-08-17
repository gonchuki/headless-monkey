# PLAN-52 — Wrap UserService.update in a transaction

**Goal:** Eliminate the TOCTOU race in `UserService.update()` where a concurrent `DELETE` between the password and disabled updates can leave the user in a partially-updated state.

**Depends on:** none.

## Files

- `server/src/repositories/userRepo.ts` — add `updateIfFound()` method
- `server/src/services/userService.ts` — rewrite `update()` to use new method
- `server/test/users.test.ts` — add tests for atomic update and concurrency

## Steps

1. Add a new method `updateIfFound(id, { hashedPassword?, disabled? })` to `UserRepo`. Inside a single `this.db.transaction(() => { ... })()` call: `findById(id)` once; if not found, return `false`; if found, apply `updatePassword` and/or `updateDisabled` depending on which fields are present in the changes object. Return `true`. This follows the same pattern as the existing `updatePasswordIfFound` and `updateDisabledIfFound` methods but combines both mutations in one transaction.

2. Rewrite `UserService.update()` to call the new `repo.updateIfFound()` instead of the two separate `*IfFound` methods. Keep `await this.hashPassword(input.password)` **outside** the transaction (bcrypt is async; better-sqlite3 transactions are synchronous). After the single repo call, if `found === false`, throw the existing 404 error.

3. Add a test: "updates both password and disabled atomically" — create a user, PATCH with both `password` and `disabled: true` in one call, verify the response has `disabled: true`, then login with the new password to confirm both changes took effect.

4. Add a concurrency test following the `vi.spyOn` pattern from `schemaService.test.ts`: spy on `UserRepo.findById`, and during the spy inject a competing `DELETE` of the user via raw SQL. Assert the PATCH returns 200 (the transaction commits the updates before the delete). If the old code were still in place, the delete could interleave between the two separate calls and cause a 404.

## Edge cases

- `input` has only `password` (no `disabled`) — only password mutation runs.
- `input` has only `disabled` (no `password`) — only disabled mutation runs.
- `input` has neither — no-op, returns successfully (no 404 if user exists; 404 if not).
- User does not exist — 404 thrown, no mutations applied.

## Acceptance criteria

1. `pnpm --filter server test` passes — all existing user tests still green, new tests pass.
2. A PATCH to `/api/users/:id` with both `password` and `disabled` applies both atomically — verified by the new test.
3. A concurrent DELETE cannot interleave between password and disabled updates — verified by the concurrency test.
