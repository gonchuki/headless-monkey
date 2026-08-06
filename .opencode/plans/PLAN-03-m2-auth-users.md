# PLAN-03: M2 — Auth + users (server)

**Originating milestone:** M2
**Depends on:** PLAN-02 (provides migrations incl. the `users` table and the mounted schemas router to be guarded — confirm `pnpm --filter server test` passes before starting)

## Goal

Admin logs in via the env password and manages editors; editors log in via DB users; every control-panel route enforces bearer auth and role separation.

## Spec refs (verbatim from milestone M2)

SPEC §2 R1–R7; §4 JWT, auth + users endpoints; §5 bcrypt cost 10, app factory.

## Files involved

- `server/src/auth/jwt.ts` — sign/verify helpers.
- `server/src/auth/requireAuth.ts` — bearer middleware + role guard.
- `server/src/repositories/userRepo.ts`
- `server/src/services/userService.ts`
- `server/src/routes/auth.ts`, `server/src/routes/users.ts`
- `server/src/app.ts` — mount auth/users routers; apply the auth guard to the schemas router from PLAN-02.
- `server/test/auth.test.ts`, `server/test/users.test.ts`.
- `server/package.json` — add `jsonwebtoken`, `bcrypt` (+ `@types/jsonwebtoken`, `@types/bcrypt`).

File provenance: `server/src/app.ts` and `server/package.json` come from PLAN-01; the `users` table and the mounted schemas router come from PLAN-02. All `server/src/auth/`, `server/src/routes/auth.ts`, `server/src/routes/users.ts`, the user repo/service, and the new test files are created by this plan.

## Approach

1. **JWT helpers:** HS256 sign/verify with `JWT_SECRET`, 8h expiry, payload `{ sub: login, role }` per SPEC §4.
2. **User repo + service:** `userRepo` CRUD over `users`; `userService` hashes with bcrypt cost 10, never returns plaintext, never creates/loads `admin` as a DB row (R1, R6).
3. **Auth routes:** `POST /api/auth/login` — admin branch compares against `ADMIN_PASSWORD` from env → role `admin`; editor branch loads from `users`, rejects `disabled=1` and bad/unknown credentials → all failure cases return 401 with an identical body (R2, R3). `POST /api/auth/logout` → 204 (requires auth, per R4); `GET /api/auth/me` → `{ login, role }` (requires auth).
4. **Middleware:** `requireAuth` reads `Authorization: Bearer <token>`, verifies, attaches identity; missing/invalid → 401 (R4). A `requireRole('admin')` guard → 403 for non-admin; `requireRole('editor')` → 403 for non-editor (R5).
5. **Guard application:** protect `/api/schemas` (R4/R5) and the new `/api/users` routes. Public `/api/health` and the public content routes (PLAN-04) stay unauthenticated.
6. **Users routes (admin only):** `GET /api/users`, `POST /api/users {login, password}` (duplicate login → 409, R6), `PATCH /api/users/:id {password?, disabled?}`, `DELETE /api/users/:id` (R7).
7. **Tests:** R1–R7 including 401 on a protected route with missing/invalid token, 403 cross-role (admin on CMS, editor on `/api/users`), disabled-editor login rejection, and identical 401 bodies for wrong password vs unknown login.

## Edge cases

- Token expiry: an expired token must be treated as 401 (verify checks `exp`).
- `ADMIN_PASSWORD`/`JWT_SECRET` must be present at boot (env.ts from PLAN-01 hard-fails if missing); tests inject their own values.
- The role guard must run after auth; an editor calling a users route gets 403, not 401.
- Logout is a no-op server-side (stateless JWT); it exists so the client can drop its token.

## Acceptance criteria

1. `pnpm --filter server test` passes, including `auth.test.ts` and `users.test.ts`.
2. Login tests: admin credentials → token with `role=admin`; editor credentials → token with `role=editor`; disabled editor, unknown login, and wrong password all → 401 with identical bodies (R1–R3).
3. Admission path: a valid editor token returns 200 on `GET /api/schemas`; a valid admin token returns 200 on `GET /api/users`; `GET /api/auth/me` with a valid token returns 200 with the correct `role`.
4. A test requests `GET /api/schemas` with no token and with a garbage token → 401 (R4). `POST /api/auth/logout` without a token → 401.
5. A test with an admin token hits `GET /api/schemas` → 403; an editor token hits `GET /api/users` → 403 (R5).
6. Users tests: duplicate login → 409; `PATCH` flips `disabled` and changes password; `DELETE` removes the editor (R6–R7).

Milestone M2 verify gate (preserved): `pnpm --filter server test` passes (auth + users suites).
