# AGENTS.md

Engineering conventions for this repository. The functional spec is `SPEC.md`; domain rules, DB contracts, and acceptance criteria live there and take precedence for behavior. This file captures the reusable engineering principles an implementing agent must follow in every task.

## Stack

- pnpm workspaces monorepo. `server/` = Express + better-sqlite3 + TypeScript (strict). `client/` = Vite + React 19 + TypeScript (strict), `react-router@7` in SPA mode. Root `pnpm-workspace.yaml` lists both; the root `package.json` (private) only fans out to the packages.
- UI components: shadcn/ui is the component library (`@base-ui/react` is shadcn's underlying primitive set by default). Use shadcn components for everything they cover; reach for raw base-ui primitives only when no shadcn implementation exists. Never use Radix.
- Icons: `@phosphor-icons/react`. Never use lucide-react.
- All data access: `@tanstack/react-query`.

## Data access

- All data fetching and mutation goes through TanStack Query. Raw `fetch` inside `useEffect` is forbidden — no exceptions.
- Pure loading state (no data yet) renders skeleton loaders, not spinners or blank screens.
- Mutations use optimistic updates.
- Do not invent pagination, caching layers, or other infra the prompt doesn't ask for; keep the API layer thin and stateless.

## Component architecture

- Split JSX at the seams: each component has a single responsibility, and each `.tsx` file contains exactly one component.
- Move utilities into custom hooks.
- Favor `useReducer` over opaque indirection via `useEffect` and `useRef`.

## Workspace layout

- pnpm workspaces monorepo: `pnpm-workspace.yaml` lists the `client` and `server` packages, each with its own `package.json` (own name, scripts, and TypeScript strict config).
- Root `package.json` is private and only fans out: `pnpm -r --parallel dev` for dev, `pnpm -r test` / `pnpm -r build` otherwise.
- Dev runs both packages; the client's Vite dev server proxies `/api` to the server (target from the server's `PORT`).
- `.env` (repo root) holds server secrets: `ADMIN_PASSWORD`, `JWT_SECRET`, `PORT`, `DATABASE_PATH`. The server package loads it explicitly (pointing at the repo root) since filtered scripts run with the package dir as cwd.

## Server principles

- No ORM. Use a sequential SQL migration runner and thin repository modules over better-sqlite3.
- Password hashing via bcrypt (cost 10).
- Write server logic against an Express app factory so tests can run without a listening server (vitest + supertest).
- Schema versioning/compat rules, conflict resolution, and propagation logic live in a dedicated service layer with unit tests.
