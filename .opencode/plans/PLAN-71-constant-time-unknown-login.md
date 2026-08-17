# Equalize Login Timing for Unknown Editor Logins

## Goal

SPEC R3 requires that an unknown login and a wrong password be indistinguishable. The response **body** already is (both return `{ error: "Invalid credentials" }`), but the **timing** is not: in `createAuthRouter`'s `POST /login` handler, the editor branch returns 401 *immediately* for an unknown login (no bcrypt work), while a known login pays a bcrypt compare (~ms). An attacker can time responses to enumerate valid editor logins.

Fix: make **every** editor-login attempt perform exactly one bcrypt compare — comparing against a precomputed dummy hash when the login is unknown — while keeping the identical 401 body.

## Files Involved

- `server/src/routes/auth.ts` — the `POST /login` handler's editor-login branch, plus a module-scope dummy hash.
- `server/test/auth.test.ts` — the `POST /api/auth/login` describe block.

## Implementation Approach

1. **Introduce a precomputed dummy bcrypt hash at module scope** in `auth.ts`, computed **once** (not per request) with the same cost factor as real editor hashes (cost `10`, matching `UserService`'s `BCRYPT_COST`). It must be a **well-formed bcrypt hash** so `bcrypt.compare` performs the full compare — a malformed hash would short-circuit or throw, defeating the purpose. Import `bcrypt` in `auth.ts` to compute it (`UserService` already depends on bcrypt, so this is consistent).

2. **Rewrite the editor-login branch** so it always performs exactly one compare, then decides:
   - Look up the user by login (`userRepo.findByLogin(login)`).
   - Compare the supplied password against `(user ? user.hashed_password : DUMMY_HASH)` via the existing `UserService.comparePassword` (keep it `await`ed — it is async).
   - Return 401 with the **identical** body `{ error: "Invalid credentials" }` when there is **no user**, **or** the user is **disabled**, **or** the compare failed.
   - Otherwise sign and return the token (unchanged).

   This preserves every existing outcome (unknown → 401, disabled → 401, wrong password → 401, success → token) while making each attempt pay one bcrypt compare.

3. **Tests** in the `POST /api/auth/login` describe block (see Acceptance Criteria).

## Edge Cases

1. **Compute the dummy hash once.** A per-request `hashSync` would add ~100 ms to every login and could itself become a timing/DoS concern. Module scope (or a lazy singleton) is required.
2. **Match the cost factor.** The dummy hash's cost must equal the real hashes' (`10`). A lower-cost dummy would still be faster for unknown logins and leak.
3. **Do not touch the admin branch.** `login === "admin"` already uses a constant-time comparison (`crypto.timingSafeEqual`) and is a separate path. Only the editor branch changes.
4. **Body must stay byte-identical.** The pre-existing test `unknown login and wrong password return identical 401 bodies (R3)` must keep passing — all three failure cases return exactly `{ error: "Invalid credentials" }`.
5. **Disabled users now also pay a compare** (previously they returned before any bcrypt). This is intended (it equalizes timing further) and does not change the response — the `disabled editor returns 401 (R2)` test still passes.
6. **Success path unchanged.** For a known user the compare is against their real hash, exactly as before — only unknown users get the dummy.

## Acceptance Criteria

1. **Dummy compare on unknown login; indistinguishability preserved.** `cd server && npx vitest run` exits 0 with: (a) a new test under `POST /api/auth/login` that POSTs an unknown login, asserts HTTP **401**, and asserts the request performed **exactly one** bcrypt compare against a well-formed hash — verified by spying on `UserService.prototype.comparePassword` (the same prototype-spy pattern already used in `users.test.ts`; restore the spy afterward) and asserting it was called once with a second argument matching `/^\$2[abxy]\$\d{2}\$/`; and (b) the pre-existing tests still passing unmodified — including `unknown login returns 401 (R3)`, `wrong password returns 401 (R3)`, `disabled editor returns 401 (R2)`, `unknown login and wrong password return identical 401 bodies (R3)`, and the admin/editor success cases.
2. **Type-checks.** `cd server && npx tsc --noEmit` exits 0.
