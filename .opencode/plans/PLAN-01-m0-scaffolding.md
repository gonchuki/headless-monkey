# PLAN-01: M0 — Scaffolding

**Originating milestone:** M0
**Depends on:** none

## Goal

Stand up the pnpm workspaces monorepo: a `server/` package (Express + better-sqlite3 + TypeScript strict) and a `client/` package (Vite + React 19 + TypeScript strict) that both boot, build, and test green, with the client dev server proxying `/api` to the server.

## Spec refs (verbatim from milestone M0)

SPEC §5 (workspace layout, `.env`, test harness); AGENTS.md (stack, workspace layout, server principles).

## Files involved

- Root: `pnpm-workspace.yaml`, `package.json`, `.gitignore` (extends existing), `.env.example` (already present — keep).
- Server: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/src/index.ts`, `server/src/app.ts`, `server/src/config/env.ts`, `server/test/health.test.ts`.
- Client: `client/package.json`, `client/tsconfig.json`, `client/vite.config.ts`, `client/index.html`, `client/src/main.tsx`, `client/src/App.tsx`.

## Approach

1. **Root workspace:** `pnpm-workspace.yaml` listing `packages: [client, server]`. Root `package.json` (private, no deps) with scripts that only fan out: `dev` → `pnpm -r --parallel dev`, `test` → `pnpm -r test`, `build` → `pnpm -r build`.
2. **Server package:** `server/package.json` with name `server`; deps `express`, `better-sqlite3`, `dotenv`; devDeps `typescript`, `tsx`, `vitest`, `supertest`, `@types/express`, `@types/node`, `@types/better-sqlite3`, `@types/supertest`. Scripts: `dev` (tsx watch src/index.ts), `build` (tsc), `test` (vitest run), `typecheck` (tsc --noEmit). `tsconfig.json` with `strict: true`, `moduleResolution: bundler` or `node` as fits, `outDir: dist`.
3. **Env loading:** `server/src/config/env.ts` reads `ADMIN_PASSWORD`, `JWT_SECRET`, `PORT` (default e.g. 4000), `DATABASE_PATH` from the root `.env`. Because filtered pnpm scripts run with the package dir as cwd, load the root `.env` explicitly (path relative to `server/`, i.e. `../../.env`). Missing `ADMIN_PASSWORD`/`JWT_SECRET` in non-test runs is a hard startup error; in tests it must not block (tests inject values).
4. **App factory:** `server/src/app.ts` exports `createApp(): Express`; mount `GET /api/health` returning 200 with a JSON status body. `server/src/index.ts` builds the app from `env.ts` config and calls `listen`.
5. **Health test:** `server/test/health.test.ts` uses supertest against `createApp()` and asserts `/api/health` → 200. A per-test in-memory DB is not needed yet.
6. **Client package:** `client/package.json` with name `client`; deps `react`, `react-dom`, `react-router@7` (import from `react-router`, SPA mode), `@tanstack/react-query`; devDeps `vite`, `@vitejs/plugin-react`, `typescript`, `@types/react`, `@types/react-dom`. `vite.config.ts` proxies `/api` → `http://localhost:${PORT}` where `PORT` is read from root `.env`. `index.html`, `src/main.tsx` (React root), minimal `src/App.tsx` placeholder. Scripts: `dev`, `build` (`tsc && vite build`), `typecheck`.
7. **Verification run:** `pnpm install`, `pnpm test`, `pnpm build` at the root; fix until green.

## Edge cases

- `.env` absent in CI/test: `env.ts` must not crash the vitest run; only the server boot path hard-fails.
- The Vite proxy target must come from the same `PORT` the server listens on, or the client cannot reach `/api` in dev.
- pnpm filtered scripts change cwd to the package dir — the root `.env` path must be resolved relative to `server/`, not the root.
- Windows-safe path resolution (this repo is developed on win32): use `path.resolve` for the `.env` location.

## Acceptance criteria

1. From the repo root, `pnpm install` completes without errors.
2. From the repo root, `pnpm test` runs vitest in the server package and the health suite passes.
3. From the repo root, `pnpm build` compiles both packages (TypeScript strict passes, Vite build emits `client/dist`).
4. With a root `.env` containing `PORT`, `pnpm dev` starts both packages; `curl http://localhost:$PORT/api/health` returns HTTP 200.
5. While the dev servers run, `curl http://localhost:5173/api/health` (the Vite port) returns the same 200 via the proxy.

Milestone M0 verify gate (preserved): `pnpm install && pnpm test` passes in both packages; `pnpm build` compiles both; with `.env` set, `pnpm dev` serves the client and `curl :$PORT/api/health` returns 200.
