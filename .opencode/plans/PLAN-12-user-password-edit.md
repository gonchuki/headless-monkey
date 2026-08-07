# PLAN-12 — Admin: edit an existing user's password

## Goal

Let an admin change the password of an existing editor through the user management UI (`AdminUsersPage`).

The server already fully supports this — `PATCH /api/users/:id` accepts an optional `password` field, bcrypt-hashes it (cost 10), persists it via `userService.update`, and is covered by the existing test `server/test/users.test.ts` ("changes password (R7)"). **No server change is required.** The work is client-only: add a per-row password-edit affordance that sends that PATCH.

## Files involved

- `client/src/routes/AdminUsersPage.tsx`
- If the edit dialog grows into a component of its own, give it its own `.tsx` file (one component per file, per AGENTS.md) — that new file is then also in scope.

## Implementation approach

### 1. Add a password-edit affordance per row

- Each user row currently shows login + Active/Disabled and two buttons (Disable/Enable, Delete). Add an "edit password" control to each row — your choice of an inline expanding form or a modal dialog; the page already uses `AlertDialog` for delete, so a dialog is the established, consistent pattern. The row list must stay clean.
- The editor is scoped to one user: it shows that user's login (read-only context) and a single password input with Save/Cancel.

### 2. State

- Add state for the target user (`id` + `login`) and the new-password string. Reset/clear the password string whenever the editor is opened for a different user and when it closes, so a stale value is never submitted.

### 3. Mutation

- Add a `useMutation` mirroring the page's existing mutation conventions (`createMutation` / `toggleMutation` / `deleteMutation`):
  - `mutationFn`: send a `PATCH` to `/api/users/<target id>` whose JSON body is `{ password: <new password> }`. (Use the same `apiFetch` helper the other mutations use; the server response is `{ id, login, disabled }`.)
  - `onSuccess`: toast `"Password updated"`; close the editor and clear the password field.
  - `onError`: toast with `errorMessage(error)` (same shape as the other mutations).
  - `onSettled`: `queryClient.invalidateQueries({ queryKey: queryKeys.users() })`.
  - No optimistic update is needed — the password is never shown in the list.

### 4. Form behavior and validation

- Password input is `type="password"` with `autoComplete="new-password"`.
- Save is disabled while the mutation is pending **and** while the password field is empty — the dialog exists to change a password, so an empty value is not a valid submission. This matches the existing create-form rule ("required"): no min-length or strength rules exist anywhere in the codebase, and none are added here.
- Enter in the field submits the form (native form submit).

### 5. Explicitly out of scope

- No server changes (endpoint, hashing, or validation).
- No self-service password change; no change to the admin's own login (it is env-backed and never appears in this list — the page already notes this).
- No change to `createMutation` / `toggleMutation` / `deleteMutation`.

## Edge cases

- **Blank password:** the server treats absent/falsy `password` as "leave unchanged" (`userService.update` only re-hashes a truthy password). The client's non-empty Save guard means the action always has an effect and never accidentally no-ops.
- **Response shape:** the PATCH response is `{ id, login, disabled }` — no hash is ever echoed back; don't render or store one.
- **Stale field across users:** clearing the password string when the target user changes prevents submitting another user's password.
- **Pending state:** guard against double-submit with the pending disable.

## Acceptance criteria

1. `pnpm --filter client build` passes (the `build` script runs `tsc` and then `vite build`, so it covers type checking as well).
2. Grep check: `AdminUsersPage.tsx` contains a `PATCH` mutation whose body includes a `password` field against a `/api/users/` URL.
3. Manual (no client test infra exists; the server side is already covered by `users.test.ts`): run `pnpm -r dev`, log in as admin, open `/admin`, change an editor's password through the UI; that editor can then log in with the new password and fails with the old one. Also verify the Save button is inert when the password field is empty.
