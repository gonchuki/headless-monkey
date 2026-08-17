# Reject the Reserved `admin` Login When Creating Editors

## Goal

`POST /api/users` currently creates an editor row for **any** login, including the reserved admin login: sending `{ login: "admin", password: <x> }` returns `201` and inserts a `users` row named `admin`. That row can never authenticate — the login route (`createAuthRouter`, the `POST /login` handler) short-circuits `login === "admin"` straight into the admin-password branch and never consults the `users` table for it. The result is a zombie editor, which contradicts SPEC R1's premise that "`admin` is never a row in `users`."

Close the gap: reject editor creation when the requested login is the reserved admin login, with a clear error, and create no row.

## Files Involved

- `server/src/services/userService.ts` — `UserService.create(input)` (the domain rule belongs here; this is where the other `statusCode`-carrying domain errors are thrown).
- `server/src/routes/users.ts` — the `POST /` handler in `createUsersRouter` (must surface the new 422; its catch block currently only special-cases 409 and falls through to 500 for everything else).
- `server/test/users.test.ts` — the `POST /api/users` describe block.

## Implementation Approach

1. **Service: reject the reserved login before hashing.** In `UserService.create`, add a guard as the first statement, **before** `this.hashPassword(...)` (a rejected request must not pay a ~100 ms bcrypt hash). When the login is the reserved admin login, throw an `Error` carrying `statusCode = 422` and a message that clearly says the login is reserved (e.g. `Login "admin" is reserved`). Follow the exact error-construction pattern already used by `UserService.update` / `UserService.remove` (an `Error` cast to add `statusCode`).

   The comparison must be **case-sensitive equality against `"admin"`**, matching the login route's admin branch exactly so the rule and the short-circuit can never drift.

2. **Route: surface the 422.** In the `POST /` handler's catch block, add a branch for `statusCode === 422` that returns `res.status(422).json({ error: <the reserved-login message> })`, mirroring the existing `409 → "Duplicate login"` branch. Without this branch the rejection would surface as a 500.

3. **Tests** in the `POST /api/users` describe block (see Acceptance Criteria).

## Edge Cases

1. **Order matters:** the reserved check must run before `hashPassword`. If it runs after, every rejected request still burns a bcrypt hash.
2. **Case sensitivity:** only the exact string `"admin"` is reserved. `"Admin"`, `"ADMIN"`, etc. must remain valid editor logins — do not lowercase or normalize. This mirrors the login route, whose admin branch is `login === "admin"`.
3. **Distinct from the duplicate path:** a brand-new request with `login: "admin"` (no existing row) must return **422 (reserved)**, not 409. The message must not read like a duplicate-login error.
4. **Existing paths untouched:** the missing-field 422 (`Login and password are required`), the duplicate-login 409, and normal creation (201) must all behave exactly as before.
5. **Single source of truth for "reserved":** the literal `"admin"` now appears in both the login route and `UserService.create`. Keep them in sync; if you extract a shared constant, that is acceptable but not required.

## Acceptance Criteria

1. **Rejection is correct and nothing is over-rejected.** `cd server && npx vitest run` exits 0 with: (a) a new test under `POST /api/users` that POSTs `{ login: "admin", password: <anything> }` with a valid admin token and asserts HTTP **422**, that `body.error` is a string matching `/reserved/i` (and is **not** `"Duplicate login"`), and that no `users` row with login `"admin"` exists afterward (query the db or `GET /api/users`); and (b) the pre-existing tests `creates a user (R6)` (201 for a normal login such as `new-editor`) and `duplicate login returns 409 (R6)` still passing unmodified.
2. **Type-checks.** `cd server && npx tsc --noEmit` exits 0.
