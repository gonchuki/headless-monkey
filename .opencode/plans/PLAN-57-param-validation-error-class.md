# PLAN-57 — Fix parseSortParams to throw proper Error

**Goal:** Replace the plain-object throw in `parseSortParams()` with a proper `Error` subclass, consistent with the `SchemaServiceError`/`ContentServiceError` pattern used elsewhere.

**Depends on:** none.

## Files

- `server/src/routes/paramValidation.ts` — add `ParamValidationError` class, update `parseSortParams`

## Steps

1. Add a `ParamValidationError` class at the top of `paramValidation.ts`:
   ```ts
   export class ParamValidationError extends Error {
     constructor(public statusCode: number, message: string) {
       super(message);
     }
   }
   ```
   This matches the `SchemaServiceError`/`ContentServiceError` shape (both extend `Error` with `statusCode`).

2. Replace the two `throw { statusCode: 422, message: "..." }` statements in `parseSortParams` with `throw new ParamValidationError(422, "...")`.

3. No changes needed to route handler catch blocks — the existing `isErrorWithStatus` duck-type guard already handles any object with `statusCode` and `message`, which `ParamValidationError` satisfies via its `Error` inheritance + `statusCode` property.

## Edge cases

- `parsePaginationParams` also throws plain objects (`{ statusCode: 422, message: "..." }` for invalid limit/cursor). Consider whether to fix those too for consistency. Out of scope for this plan unless the user requests it — the `parseSortParams` fix is the identified inconsistency.

## Acceptance criteria

1. `pnpm --filter server test` passes — all existing param validation tests still green.
2. `grep -n "throw {" server/src/routes/paramValidation.ts` returns no matches — no more plain-object throws.
3. `instanceof ParamValidationError` works in catch blocks if needed (the class is exported).
