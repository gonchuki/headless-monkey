# BUILD_PLAN: headless-monkey CMS   (v0.1 — 2026-08-06, derived from SPEC.md v0.3)

## M0 — Scaffolding

- **Goal:** `pnpm dev` boots a Vite client and an Express server that answers `GET /api/health` with 200, and `pnpm test`/`pnpm build` run green in both packages.
- **Spec refs:** SPEC §5 (workspace layout, `.env`, test harness); AGENTS.md (stack, workspace layout, server principles).
- **File scope:** root `pnpm-workspace.yaml`, root `package.json`, `.gitignore`; `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/src/index.ts`, `server/src/app.ts`, `server/src/config/env.ts`, `server/test/health.test.ts`; `client/package.json`, `client/tsconfig.json`, `client/vite.config.ts`, `client/index.html`, `client/src/main.tsx`, `client/src/App.tsx`.
- **Depends on:** none.
- **Steps:**
  1. Root workspace: `pnpm-workspace.yaml` listing `client` and `server`; private root `package.json` with `dev`/`test`/`build` fan-out scripts (`pnpm -r --parallel dev`, `pnpm -r test`, `pnpm -r build`).
  2. `server/`: package.json (express, better-sqlite3, dotenv; dev: typescript strict, vitest, supertest, tsx, types), `config/env.ts` loading root `.env` (ADMIN_PASSWORD, JWT_SECRET, PORT, DATABASE_PATH), `createApp()` with `GET /api/health`, `index.ts` booting the listener.
  3. `client/`: package.json (react, react-dom, react-router@7, @tanstack/react-query; dev: vite, @vitejs/plugin-react, typescript strict), `vite.config.ts` proxying `/api` → server `PORT`, `index.html`, `main.tsx`, placeholder `App.tsx`.
  4. `server/test/health.test.ts` via supertest against `createApp()`.
- **Verify:** `pnpm install && pnpm test` passes in both packages; `pnpm build` compiles both; with `.env` set, `pnpm dev` serves the client and `curl :$PORT/api/health` returns 200.
- **Out of scope:** any real route, DB, auth, or UI beyond the placeholder.

## M1 — DB + schema management (server)

- **Goal:** Schema create/read/update/delete endpoints produce correct `version`/`compat_version`, reject cycles, and propagate deletions per §7.
- **Spec refs:** SPEC §2 R8–R15, R21, R22; §4 DB DDL, schema routes, id-stable field contract; §5 no-ORM migrations + ASSUMPTION (block referenced-schema delete); §7 compat table.
- **File scope:** `server/src/db/migrations.ts`, `server/src/db/database.ts`, `server/src/repositories/schemaRepo.ts`, `server/src/services/schemaService.ts`, `server/src/routes/schemas.ts`, `server/src/types.ts`, `server/src/app.ts` (mount schemas router), `server/test/schemaService.test.ts`, `server/test/schemaRoutes.test.ts`.
- **Depends on:** M0.
- **Steps:**
  1. Sequential migration runner + migrations creating `users`, `schemas`, `schema_fields`, `content`, `content_rows` exactly per §4 DDL (FKs, type CHECK, UNIQUE, ON DELETE CASCADE).
  2. `schemaRepo`: insert/get/update fields, delete schema (cascades content), count entries per schema, list.
  3. `schemaService` per SPEC §6: create (≥1 field, unique name → 409, type whitelist → 422, ref_schema exists, cycle detection over the full ref graph → 422, version=compat_version=1); update (id-stable fields — existing carry `id`, new omit it, absent ids deleted; version always +1; compat per §7 table; field-delete propagation R21: purge `content_rows` for deleted field_ids and set those entries' `schema_version` to the new version; delete R22: cascade; referenced-schema delete blocked 409 per ASSUMPTION).
  4. Routes `GET/POST /api/schemas`, `GET/PATCH/DELETE /api/schemas/:name` with R8–R10 status codes. Mounted unauthenticated here; the guard lands in M2.
  5. Tests: every row of the §7 compat table (assert resulting version + compat_version), R8–R15, R21–R22, direct + transitive cycle rejection.
- **Verify:** `pnpm --filter server test` passes (schema suite).
- **Out of scope:** auth/guards (M2), entry CRUD (M3), all client code.

## M2 — Auth + users (server)

- **Goal:** Admin logs in via env password and manages editors; editors log in via DB users; every control-panel route enforces auth and role.
- **Spec refs:** SPEC §2 R1–R7; §4 JWT, auth + users endpoints; §5 bcrypt cost 10, app factory.
- **File scope:** `server/src/auth/jwt.ts`, `server/src/auth/requireAuth.ts`, `server/src/repositories/userRepo.ts`, `server/src/services/userService.ts`, `server/src/routes/auth.ts`, `server/src/routes/users.ts`, `server/src/app.ts` (mount + guard M1's schemas router), `server/test/auth.test.ts`, `server/test/users.test.ts`.
- **Depends on:** M1 (users table + app factory).
- **Steps:**
  1. JWT sign/verify: HS256, `JWT_SECRET`, 8h expiry, payload `{ sub: login, role }`.
  2. `userRepo` + `userService`: create editor (bcrypt hash, cost 10), update password/disabled, delete, list; `admin` never a DB row.
  3. `POST /api/auth/login`: admin via `ADMIN_PASSWORD` → role admin; editor via users table with `disabled=0` → role editor; disabled/unknown/wrong-password → 401 with identical body (R2, R3). `POST /api/auth/logout` → 204, `GET /api/auth/me`.
  4. `requireAuth` middleware + role guard; guard all control-panel routes (401 missing/invalid token R4; 403 wrong role R5 — admin blocked from CMS, editor blocked from `/api/users`).
  5. Users routes: list, create (dup login → 409 R6), patch password/disabled, delete (R7).
  6. Tests R1–R7, incl. 401 on a control-panel route with no/invalid token and 403 cross-role.
- **Verify:** `pnpm --filter server test` passes (auth + users suites).
- **Out of scope:** client login screen (M4), refresh tokens, lockout, password reset.

## M3 — Content + public API (server)

- **Goal:** Editors create/edit/delete entries; the unauthenticated data API returns valid entries and distinguishes unknown (404) from conflicted (422).
- **Spec refs:** SPEC §2 R16–R20; §4 content routes, public API shapes, value serialization; §7 status + serialization examples; §5 service-layer tests.
- **File scope:** `server/src/repositories/contentRepo.ts`, `server/src/services/contentService.ts`, `server/src/routes/content.ts` (public, unauthenticated), `server/src/routes/entries.ts` (guarded), `server/src/app.ts` (mount), `server/test/contentService.test.ts`, `server/test/publicApi.test.ts`.
- **Depends on:** M2.
- **Steps:**
  1. `contentRepo`: insert entry + `content_rows`, replace rows on update, delete, list by schema (with `conflict` flag = `schema_version < compat_version`), get by id.
  2. `contentService` per SPEC §6: validation (required fields present and type-valid — required `text` must be non-empty, unknown `field_id` → 422, schema-ref value is an existing entry of the target schema → 422 — R16); on save auto-coerce values when lossless (`number`→`text`), reject until re-entered otherwise, and set `schema_version` = schema's current version (R17).
  3. Editor routes: `GET /api/schemas/:name/entries` (incl. conflicted, each `conflict: boolean`), `POST /api/schemas/:name/entries`, `PATCH /api/entries/:id`, `DELETE /api/entries/:id`.
  4. Public routes (no auth): `GET /api/content/:schema` → 200 valid-only / 404 unknown schema (R18); `GET /api/content/:schema/:id` → 200 / 404 unknown id / 422 conflicted (R19, mutually exclusive).
  5. Tests R16–R20 + §7 serialization (`values` keyed by field id) + conflict→edit→valid cycle.
- **Verify:** `pnpm --filter server test` passes (content + public API suites).
- **Out of scope:** SSE (M7), pagination/search (non-goal), client code.

## M4 — Client shell + auth (client)

- **Goal:** Admin and editor log in and land on role-appropriate screens; all data flows through TanStack Query with skeleton loading.
- **Spec refs:** SPEC §2 R27, R28, R29; §5 react-router SPA, tanstack, shadcn/base-ui, phosphor, one component per `.tsx`.
- **File scope:** `client/src/main.tsx`, `client/src/lib/api.ts`, `client/src/lib/query.ts`, `client/src/auth/AuthProvider.tsx`, `client/src/auth/RequireRole.tsx`, `client/src/routes/LoginPage.tsx`, `client/src/routes/AdminUsersPage.tsx`, `client/src/layouts/AppLayout.tsx`, `client/src/components/Nav.tsx`, `client/src/components/Skeleton.tsx`, `client/src/components/ui/` (shadcn button, input, alert, toast), `client/components.json` + tailwind/css config.
- **Depends on:** M2.
- **Steps:**
  1. Router with R29 paths, `QueryClientProvider`, api client attaching Bearer from storage.
  2. `AuthProvider` (login/logout/me + token persistence); `RequireRole` guards: admin → only `/admin`, editor → only CMS routes (R29).
  3. Login page (login/password); `/admin` users page: list, create editor, toggle disabled, delete — optimistic updates + skeletons (R27, R28).
  4. `AppLayout` + nav with role-filtered links; skeleton component.
  5. Install/configure shadcn/ui on base-ui + `@phosphor-icons/react`; add the ui primitives above.
- **Verify:** `pnpm --filter client build` passes; manual against running M2 server: admin login → `/admin` only; editor login → CMS only; disabled editor rejected at login; users CRUD reflects immediately.
- **Out of scope:** schema/content screens (M5/M6), realtime (M7).

## M5 — Schemas UI (client)

- **Goal:** Editor lists schemas and builds/edits one in a 3-column sortable grid, with confirmed deletes showing affected counts.
- **Spec refs:** SPEC §2 R30; §2 R22 (confirmations + affected counts); §4 schema routes; §5 optimistic updates/skeletons.
- **File scope:** `client/src/routes/SchemasPage.tsx`, `client/src/routes/SchemaEditorPage.tsx`, `client/src/hooks/useSchemas.ts`, `client/src/components/SchemaFieldGrid.tsx`, `client/src/components/SchemaFieldRow.tsx`, `client/src/components/DeleteConfirmDialog.tsx`, `client/src/components/NewEntrySelector.tsx`, `client/src/components/ui/Alert.tsx`.
- **Depends on:** M4, M3.
- **Steps:**
  1. Schemas list page (skeletons, optimistic delete).
  2. Schema editor: name field + 3-col grid `field_label | field_type | required` (R30), add/remove rows, reorder (up/down/drag), type select, ref_schema select for `schema-ref`.
  3. Save → `PATCH` with id-stable fields (renames keep `id`, new fields omit it); display resulting version; surface 409/422 inline.
  4. Delete confirmations: schema delete shows affected content count, field delete shows affected entry count (R22); deleted schemas render disabled in the list.
  5. `NewEntrySelector` (disabled when zero schemas) for M6.
- **Verify:** `pnpm --filter client build`; manual against running server: create schema → listed; rename/reorder/optional-add → version +1 with compat unchanged; delete warns with correct counts.
- **Out of scope:** content editor (M6), realtime (M7).

## M6 — Content UI (client)

- **Goal:** Editor creates/edits entries with type-appropriate inputs, and conflicted entries render stored-old + new fields.
- **Spec refs:** SPEC §2 R31, R32, R33; §4 content routes + serialization; §5 optimistic updates/skeletons.
- **File scope:** `client/src/routes/ContentPage.tsx`, `client/src/routes/ContentEditorPage.tsx`, `client/src/routes/NewContentPage.tsx`, `client/src/hooks/useEntries.ts`, `client/src/components/DynamicEntryForm.tsx`, `client/src/components/EntryFieldInput.tsx`, `client/src/components/ReferenceSelect.tsx`, `client/src/components/ConflictField.tsx`.
- **Depends on:** M5, M3.
- **Steps:**
  1. Content list page (per schema), edit buttons, conflict highlighting from the `conflict` flag.
  2. `NewContentPage` using `NewEntrySelector`; disabled with zero schemas.
  3. Dynamic 2-column form: `label | type-input`, red `*` on required (R31).
  4. schema-ref `<select>` listing target entries labeled by the target's first required field by `sort_order` (fallback: first field; entry id when empty) (R32).
  5. Conflicted entry: render stored (old) field disabled with the new enabled field below (R33); auto-coerced values (e.g. `number`→`text`) carry over into the new field, otherwise it starts empty; save re-validates and sets `schema_version` (R17).
  6. Skeletons on load, optimistic updates on save/delete (R28).
- **Verify:** `pnpm --filter client build`; manual: create an entry exercising every field type; make a breaking schema change, reload the entry → dual-field conflicted editor, save → entry valid.
- **Out of scope:** realtime (M7).

## M7 — SSE realtime + conflict UX (server + client)

- **Goal:** Two logged-in editors observe each other's changes live: toasts on affected views, disabled rows/banners on deletion, dual-field render on incompatible type change.
- **Spec refs:** SPEC §2 R23–R26; §4 SSE contract; §5 useRealtime/optimistic.
- **File scope:** server `server/src/services/events.ts`, `server/src/routes/events.ts`, emit calls in `routes/schemas.ts` + `routes/entries.ts`, `server/src/app.ts` (mount + keep guarded); client `client/src/hooks/useRealtime.ts`, `client/src/components/Toast.tsx`, disabled/banner states in `SchemasPage.tsx`, `ContentPage.tsx`, `SchemaEditorPage.tsx`, `ContentEditorPage.tsx`.
- **Depends on:** M6 (editors to modify), M3 (emit from content mutations).
- **Steps:**
  1. Server event emitter (in-memory, per schema) + `GET /api/events` (Bearer) streaming `schema.created|updated|deleted`, `entry.created|updated|deleted` with `changes` payloads per §4.
  2. Emit from every schema create/update/delete and entry create/update/delete mutation.
  3. Client `useRealtime` hook per SPEC §6: fetch-based SSE reader (Bearer header), subscribes to the schema(s) on screen, invalidates affected queries.
  4. Toast on events affecting the current view (R26).
  5. Transient states: schema deleted → open schema/entry editors disabled + banner, listing rows disabled (R24); incompatible `typeChanged` → old field disabled with new field below (R25), pre-filled when the old value coerces losslessly (`number`→`text`).
- **Verify:** `pnpm --filter server test` and `pnpm --filter client build` pass; two-browser manual: A creates a schema → B sees toast + list update; A deletes the schema → B's open editor disabled + banner; A changes a field type → B's open entry shows the dual-field editor.
- **Out of scope:** OT/collision merging, presence indicators, offline queueing.

## Resolved decisions

Logged 2026-08-06 by the spec owner; these override any contrary reading of SPEC.md and are baked into the steps above.

1. **Deleting a referenced schema** — block with 409 naming the referencing schema (SPEC §5 ASSUMPTION kept). Enforced in M1 `schemaService`.
2. **SSE Bearer auth transport** — fetch-based SSE reader keeps the `Authorization` header; no token in the URL. M7 step 3.
3. **Required `text` field** — must be non-empty; `""` violates required. M3 `contentService` validation.
4. **Type-changed value on save** — auto-coerce when lossless (`number`→`text`); otherwise the new field starts empty and the editor must re-enter. M3 validation, M6 step 5, M7 step 5.
