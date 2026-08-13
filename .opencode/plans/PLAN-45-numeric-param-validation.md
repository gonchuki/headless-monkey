# PLAN-45 — Validate numeric route params before service calls

## Goal

Five route handlers across three files use `Number(req.params.id)` to parse entry/user IDs. When the client sends a non-numeric param (e.g., `/api/entries/abc`), `Number("abc")` returns `NaN`, which propagates to the service layer and produces 404 "not found" instead of a proper 400/422 error. Add input validation that rejects non-integer params before they reach the service layer.

## Files involved

- `server/src/routes/entries.ts` — PATCH `/:id` handler and DELETE `/:id` handler
- `server/src/routes/users.ts` — PATCH `/:id` handler and DELETE `/:id` handler
- `server/src/routes/content.ts` — GET `/:schema/:id` handler

## Implementation approach

1. Create a small middleware function `validateNumericParam(paramName: string)` in a shared location (e.g., `server/src/routes/paramValidation.ts` or inline in each route file). The middleware checks:
   - `req.params[paramName]` is defined and non-empty
   - `Number.parseInt(value, 10)` produces a valid integer (not `NaN`)
   - The value is positive (> 0)
   - On failure, returns 422 with `{ error: "Invalid <paramName>: must be a positive integer" }`

2. Apply the middleware to each affected route handler. Express allows multiple handlers per route:
   ```
   router.patch("/:id", validateNumericParam("id"), async (req, res) => { ... });
   ```

3. Replace `Number(req.params.id)` with `Number.parseInt(req.params.id, 10)` in the handlers — the middleware guarantees it's valid, but parseInt is semantically clearer than Number().

4. Use 422 status code (consistent with the codebase's validation error pattern — see the body field presence check in `users.ts` and `ContentServiceError` usage). Do not introduce 400, which is unused in this codebase.

## Edge cases

- **Float params** (`/api/entries/1.5`): `parseInt("1.5", 10)` returns `1`, which would silently accept a partial ID. The middleware should check that `String(Number.parseInt(value, 10)) === value.trim()` to reject floats.
- **Leading zeros** (`/api/entries/01`): `parseInt("01", 10)` returns `1`. This is acceptable — the ID is valid.
- **Negative IDs** (`/api/entries/-1`): Reject with validation error; SQLite AUTOINCREMENT IDs are always positive.
- **Very large numbers** (`/api/entries/9999999999999999`): These parse as valid integers but won't match any row. The service layer returns 404, which is correct behavior — no middleware change needed.

## Acceptance criteria

1. `PATCH /api/entries/abc` returns 422 (not 404) with an error message about invalid ID.
2. `DELETE /api/users/abc` returns 422 (not 404).
3. `GET /api/content/person/abc` returns 422 (not 404).
4. Valid numeric IDs (`PATCH /api/entries/1`, `DELETE /api/users/5`) continue to work correctly.
5. The existing test suite passes — no regression in route behavior for valid IDs.
