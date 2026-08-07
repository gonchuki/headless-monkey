# PLAN-05: M4 — Client shell + auth (client)

**Originating milestone:** M4
**Depends on:** PLAN-01 (client package boots), PLAN-03 (server auth endpoints running — confirm `pnpm --filter server test` passes; manual E2E in the verify gate needs the server running)

## Goal

Admin and editor log in and land on role-appropriate screens; all data access flows through TanStack Query with skeleton loading; the `/admin` users screen is functional.

## Spec refs (verbatim from milestone M4)

SPEC §2 R27, R28, R29; §5 react-router SPA, tanstack, shadcn/ui, phosphor, one component per `.tsx`.

## Files involved

- `client/src/main.tsx` — router + `QueryClientProvider`.
- `client/src/lib/api.ts` — fetch wrapper attaching Bearer.
- `client/src/lib/query.ts` — shared query keys/helpers.
- `client/src/auth/AuthProvider.tsx`, `client/src/auth/RequireRole.tsx`
- `client/src/routes/LoginPage.tsx`, `client/src/routes/AdminUsersPage.tsx`
- `client/src/layouts/AppLayout.tsx`, `client/src/components/Nav.tsx`, `client/src/components/Skeleton.tsx`
- `client/src/components/ui/*` — shadcn primitives (button, input, alert, alert-dialog, toast).
- `client/package.json` — add `@phosphor-icons/react`, and Tailwind/PostCSS tooling (shadcn/ui brings `@base-ui/react` in as its default primitive dependency).
- `client/components.json`, Tailwind/PostCSS config.

## Approach

1. **Router + query setup:** `createBrowserRouter` imported from `react-router` (react-router@7, SPA mode — never `react-router-dom`) with the R29 paths: `/login`, `/admin`, `/schemas`, `/schemas/:name`, `/content`, `/content/new`, `/content/:schema/:id` (placeholders for schemas/content pages, fleshed out in PLAN-06/07). Wrap in `QueryClientProvider`.
2. **API client:** `lib/api.ts` wraps `fetch`, attaches `Authorization: Bearer <token>` from storage, and surfaces non-2xx as typed errors. `lib/query.ts` defines query keys (users, me).
3. **Auth provider:** `AuthProvider` holds token + identity via `GET /api/auth/me`; exposes login/logout. `RequireRole` guards routes: `admin` tokens only reach `/admin`, editor tokens only reach CMS routes; unauthenticated → redirect `/login`. On a 401 from any query/mutation, drop the token and redirect to `/login` (no refresh flow per SPEC §3).
4. **Login page:** login/password form → `POST /api/auth/login` → store token → navigate by role.
5. **Admin users page (`/admin`):** list editors, create editor (login + password), toggle `disabled`, delete — all as optimistic TanStack mutations with skeletons during first load (R27, R28).
6. **Layout/nav:** `AppLayout` + `Nav` with role-filtered links (admin: `/admin` only; editor: schemas/content). `Skeleton` component used for pure loading states.
7. **UI kit:** install shadcn/ui components via the shadcn CLI (`shadcn@latest` defaults to `@base-ui/react` primitives — no Radix). Use shadcn components for everything they cover; only hand-write thin components over raw base-ui primitives when no shadcn implementation exists. Add `@phosphor-icons/react`. Install the primitives actually used (button, input, alert, alert-dialog, toast) plus whatever the pages need. Component roles per SPEC §5: confirmations → `<AlertDialog />`; passive banners → `<Alert />`; notifications → `<Toast />`.

## Edge cases

- The 401-bounce (step 3) must not intercept the `POST /api/auth/login` response itself, or a failed login would redirect instead of showing the error.
- Token expiry mid-session: any 401 response should clear auth and bounce to `/login`, without a refresh loop.
- A `disabled` editor's login must fail on the server (PLAN-03) and show the same generic error as a bad password.
- The route guard must not flash content before checking auth — gate on the `me` query's settled state (skeleton, not blank).
- One component per `.tsx` file (AGENTS.md); utilities go in hooks.

## Acceptance criteria

1. `pnpm --filter client build` passes (strict TypeScript + Vite build).
2. Manual E2E against the running PLAN-03 server: logging in as `admin` lands on `/admin` and `/admin` is the only reachable section; logging in as an editor lands on the CMS shell and navigating to `/admin` redirects back to a CMS route. Cannot be verified mechanically; verify by hand in a browser.
3. On the admin screen, creating an editor, toggling `disabled`, and deleting an editor all reflect immediately (optimistic updates) and persist across refresh (R28). Cannot be verified mechanically; verify by hand in a browser.
4. A disabled editor's login attempt shows an error and does not navigate (R2). Cannot be verified mechanically; verify by hand in a browser.
5. During the first load of a page with no data yet, a skeleton renders instead of a spinner or blank screen (R28). Cannot be verified mechanically; verify by hand in a browser.

Milestone M4 verify gate (preserved): `pnpm --filter client build`; manual: admin login → `/admin` only; editor login → CMS only; disabled editor rejected at login; users CRUD reflects immediately.
