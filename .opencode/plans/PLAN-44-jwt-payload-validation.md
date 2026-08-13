# PLAN-44 — Validate JWT payload shape after verification

## Goal

`server/src/auth/jwt.ts` casts `jwt.verify()` output to `JwtPayload` with zero runtime shape checking. If the token payload is malformed (missing `sub`, missing `role`, wrong types), downstream code operates on `undefined` properties silently. Add runtime validation so malformed tokens are rejected with 401 before they reach route handlers.

## Files involved

- `server/src/auth/jwt.ts` — `verifyToken()` function; add shape validation after `jwt.verify`
- `server/src/auth/requireAuth.ts` — `requireAuth()` middleware; no changes needed if `verifyToken` validates
- `server/src/types.ts` (if a validation error type is introduced)

## Implementation approach

1. In `jwt.ts`, after `jwt.verify(token, env.jwtSecret)` returns, validate the payload shape before casting:
   - Check that the result is a non-null object
   - Assert `sub` exists and is a string
   - Assert `role` exists and is one of `"admin"` | `"editor"` (not just any string)
   - Assert `exp` exists and is a finite number
   - If any check fails, throw an Error (the bare `catch` in `requireAuth` maps it to 401)

2. Optionally pass `{ algorithms: ["HS256"] }` to `jwt.verify()` to prevent algorithm confusion attacks (currently only `signToken` specifies the algorithm; `verifyToken` does not).

3. The `JwtPayload` interface already defines the expected shape — use it as the validation contract.

## Edge cases

- **Token from a different issuer**: May have completely different fields. The validation catches this by requiring `sub` and `role`.
- **Token with extra fields**: Not dangerous; ignore them. The validation only checks required fields exist.
- **`sub` as non-string** (e.g., number, object): The route handlers pass `payload.sub` to service methods expecting a string. Validate `typeof payload.sub === "string"`.
- **Algorithm confusion**: Without `algorithms` option on verify, a token signed with RS256 could theoretically be verified against the HS256 secret. Adding `{ algorithms: ["HS256"] }` closes this.

## Acceptance criteria

1. A token signed with a valid secret but missing `sub` returns 401 (not 403 or 500) when used with `requireAuth`.
2. A token with `role: "superadmin"` (valid JWT, wrong role value) returns 401.
3. A token with all valid fields (`sub`, `role: "editor"`, `exp`) still authenticates successfully.
4. The existing test suite passes — no regression in auth flow.
5. A token with a structurally valid JWT but semantically invalid payload (e.g., `sub` as a number instead of string) is rejected with 401.
