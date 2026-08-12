# BUILD_PLAN: headless-monkey CMS   (v0.4 — 2026-08-12, derived from SPEC.md v0.9)

v0.4 — corrected R34's delete semantics to match the implementation (SPEC R34 updated in lockstep): deleting an entry that other entries reference no longer 409-blocks — the delete clears the incoming `content_refs` in the same transaction and returns 204, leaving the referencers' field as an absent key until re-edited (never `null`). The `referencer_count` stays on editor list rows as the delete-confirmation warning, not an enforcement gate (M3 steps 1/3/5, M6 step 1).

v0.3 — reconciled to SPEC v0.9: the v0.2 open questions are resolved and folded into Resolved decisions — R16 editor `POST`/`PATCH` writes are patch-like (an omitted key leaves the stored value unchanged; an explicit `null` for an *optional* field clears its stored value, removing the stored `content_ref` for a schema-ref field; `null` for a *required* field is 422); `GET /api/schemas/:name/entries` rows add `referencer_count` (M3 returns it; M6's delete confirmation and M7's realtime disable consume it); the M6 schema-ref `<select>` gains an `[empty]` entry that submits `null`; M4 registers the full R29 route table with placeholder pages. No milestones added, retired, or renumbered.

v0.2 — reconciled to SPEC v0.8: M1 gains `content_refs` DDL, R8's required-label/required-field rules, R35 ref-retarget propagation, and R21's mixed-PATCH exception; M3 gains the `{schema, entries}` public envelope, `String(field_id)`-keyed values with `schema.fields`, `{id, schema}` ref serialization, and R34's referencer-count 409; M4/M5/M6 pick up R29's new routes (`/schemas/new`, `/content/:schema`, "All schemas" merged view); M5 adopts R30's `type | label | required` + actions column.

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

- **Goal:** Schema create/read/update/delete endpoints produce correct `version`/`compat_version`, reject invalid shapes and cycles, and propagate deletions and ref-retargets per §7, R21 and R35.
- **Spec refs:** SPEC §2 R8–R15, R21, R22, R35; §4 DB DDL (incl. `content_refs`), schema routes, id-stable field contract; §5 no-ORM migrations, full-graph cycle detection, referenced-schema delete blocked 409; §7 compat table.
- **File scope:** `server/src/db/migrations.ts`, `server/src/db/database.ts`, `server/src/repositories/schemaRepo.ts`, `server/src/services/schemaService.ts`, `server/src/routes/schemas.ts`, `server/src/types.ts`, `server/src/app.ts` (mount schemas router), `server/test/schemaService.test.ts`, `server/test/schemaRoutes.test.ts`.
- **Depends on:** M0.
- **Steps:**
  1. Sequential migration runner + migrations creating `users`, `schemas`, `schema_fields`, `content`, `content_rows`, `content_refs` exactly per §4 DDL (FKs, type CHECK, `UNIQUE (schema, label)`, `ON DELETE CASCADE`, `content_refs.target_content_id ON DELETE RESTRICT`, `idx_content_refs_target`).
  2. `schemaRepo`: insert/get/update fields, delete schema (cascades content), count entries per schema, list, purge/read `content_refs` (R21/R35 propagation).
  3. `schemaService` per SPEC §6: create (≥1 field, ≥1 required field, non-empty non-whitespace labels, no duplicate labels — each → 422; unique name → 409; type whitelist → 422; ref_schema exists; cycle detection over the full ref graph → 422; version=compat_version=1); update (id-stable fields — existing carry `id`, new omit it, absent ids deleted; version always +1; compat per §7 table; field-delete propagation R21: purge `content_rows` **and** `content_refs` for deleted field_ids and set surviving entries' `schema_version` to the new version; ref-retarget propagation R35: purge the retargeted field's `content_refs`, entries keep `schema_version` (no bump) and stay conflicted; mixed PATCH (R21 v0.8): one update that both deletes a field and retargets a schema-ref skips the schema-wide bump — purges run, entries stay conflicted; delete R22: cascade; referenced-schema delete blocked 409 naming the referencing schema per §5 invariant).
  4. Routes `GET/POST /api/schemas`, `GET/PATCH/DELETE /api/schemas/:name` with R8–R10 status codes. Mounted unauthenticated here; the guard lands in M2.
  5. Tests: every row of the §7 compat table (assert resulting version + compat_version), R8 (incl. whitespace-only labels, no-required-fields, duplicate labels), R9–R15, R21 (incl. `content_refs` purge + mixed-PATCH exception), R22, R35, direct + transitive cycle rejection.
- **Verify:** `pnpm --filter server test` passes (schema suite).
- **Out of scope:** auth/guards (M2), entry CRUD + R34 referencer clear-then-delete (M3), all client code.

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

- **Goal:** Editors create/edit/delete entries (deleting a schema-ref target clears the incoming refs in the same transaction and returns 204 — R34); the unauthenticated data API returns the `{schema, entries}` envelope and distinguishes unknown (404) from conflicted (422).
- **Spec refs:** SPEC §2 R15 (self-describing public shape), R16–R20, R34; §4 content routes, public API envelope, value serialization; §7 status + serialization examples; §5 service-layer tests.
- **File scope:** `server/src/repositories/contentRepo.ts`, `server/src/services/contentService.ts`, `server/src/routes/content.ts` (public, unauthenticated), `server/src/routes/entries.ts` (guarded), `server/src/app.ts` (mount), `server/test/contentService.test.ts`, `server/test/publicApi.test.ts`.
- **Depends on:** M2.
- **Steps:**
  1. `contentRepo`: insert entry + `content_rows` (scalars) + `content_refs` (schema-ref targets as INTEGER), replace rows/refs on update, delete, list by schema (with `conflict` flag = `schema_version < compat_version`), get by id, count referencers per target (R34).
  2. `contentService` per SPEC §6: validation (required fields present and type-valid — required `text` must be non-empty, unknown `field_id` → 422, schema-ref value is an existing entry of the target schema → 422, optional schema-ref with no target omitted from `values` and never serialized as `null`; editor `POST`/`PATCH` writes are patch-like per R16 — an omitted key leaves the stored value unchanged, an explicit `null` for an optional field clears it (schema-ref: removes the stored `content_ref`), `null` for a required field is a validation error (422). The server already implements the patch-like/null behavior, so no behavior change is required here); on save auto-coerce values when lossless (`number`→`text`), reject until re-entered otherwise, and set `schema_version` = schema's current version (R17); store refs in `content_refs`, never as a JSON number in `content_rows.value` (§4 value serialization).
  3. Editor routes: `GET /api/schemas/:name/entries` (incl. conflicted; each row carries `conflict: boolean` and `referencer_count` — the count of distinct entries referencing the row via schema-ref, served cheaply from `idx_content_refs_target`); `POST /api/schemas/:name/entries`, `PATCH /api/entries/:id` (both payloads are patch-like per R16), `DELETE /api/entries/:id` (clears all `content_refs` pointing at the entry and deletes it in one transaction → 204 — R34; the `referencer_count` feeds the delete-dialog warning, it does not block).
  4. Public routes (no auth): `GET /api/content/:schema` → 200 `{schema, entries}` valid-only / 404 unknown schema (R18); `GET /api/content/:schema/:id` → 200 one-element `entries` / 404 unknown id / 422 conflicted (R19, mutually exclusive); `schema.fields` is a `String(field_id)` → current label map, `values` keyed by `String(field_id)`, schema-ref values `{id, schema}`, entries carry no redundant schema field (§4 envelope, R15).
  5. Tests R15 (self-describing), R16–R20 (incl. the null-clear and omitted-key cases: a `PATCH` sending `null` for an optional schema-ref field removes its stored `content_ref`; omitting the key leaves the stored value unchanged; `null` for a required field → 422), R34 (clear-then-delete → 204, refs gone, referencer rows keep the absent-key field; editor list rows carry `referencer_count`), §7 serialization examples (envelope, `String(field_id)` keys, `{id, schema}` refs), conflict→edit→valid cycle.
- **Verify:** `pnpm --filter server test` passes (content + public API suites).
- **Out of scope:** SSE (M7), pagination/search (non-goal), client code.

## M4 — Client shell + auth (client)

- **Goal:** Admin and editor log in and land on role-appropriate screens; all data flows through TanStack Query with skeleton loading.
- **Spec refs:** SPEC §2 R27, R28, R29 (full route set incl. `/schemas/new`, `/content/:schema`); §5 react-router SPA, tanstack, shadcn/ui, phosphor, one component per `.tsx`.
- **File scope:** `client/src/main.tsx`, `client/src/lib/api.ts`, `client/src/lib/query.ts`, `client/src/auth/AuthProvider.tsx`, `client/src/auth/RequireRole.tsx`, `client/src/routes/LoginPage.tsx`, `client/src/routes/AdminUsersPage.tsx`, `client/src/layouts/AppLayout.tsx`, `client/src/components/Nav.tsx`, `client/src/components/Skeleton.tsx`, `client/src/components/ui/` (shadcn button, input, alert, alert-dialog, toast), `client/components.json` + tailwind/css config.
- **Depends on:** M2.
- **Steps:**
  1. Router with R29's full path set — `/login`, `/admin`, `/schemas`, `/schemas/:name` (create mode when `name === "new"`), `/content`, `/content/:schema`, `/content/new`, `/content/:schema/:id`; M4 registers the complete R29 route table with minimal placeholder pages, and M5 (`/schemas/new`) / M6 (`/content/:schema`) replace those placeholders with the real pages (resolved OQ4).
  2. `AuthProvider` (login/logout/me + token persistence); `RequireRole` guards: admin → only `/admin`, editor → only CMS routes (R29).
  3. Login page (login/password); `/admin` users page: list, create editor, toggle disabled, delete — optimistic updates + skeletons (R27, R28).
  4. `AppLayout` + nav with role-filtered links; skeleton component.
  5. Install/configure shadcn/ui (defaults to `@base-ui/react` primitives) + `@phosphor-icons/react`; add the ui primitives above.
- **Verify:** `pnpm --filter client build` passes; manual against running M2 server: admin login → `/admin` only; editor login → CMS only; disabled editor rejected at login; users CRUD reflects immediately.
- **Out of scope:** schema/content screens (M5/M6), realtime (M7).

## M5 — Schemas UI (client)

- **Goal:** Editor lists schemas and builds/edits/creates one in a sortable `type | label | required` grid with a trailing actions column, with confirmed deletes showing affected counts.
- **Spec refs:** SPEC §2 R29 (`/schemas/new` create route), R30; §2 R22 (confirmations + affected counts); §4 schema routes; §5 optimistic updates/skeletons.
- **File scope:** `client/src/routes/SchemasPage.tsx`, `client/src/routes/SchemaEditorPage.tsx`, `client/src/hooks/useSchemas.ts`, `client/src/components/SchemaFieldGrid.tsx`, `client/src/components/SchemaFieldRow.tsx`, `client/src/components/DeleteConfirmDialog.tsx`, `client/src/components/NewEntrySelector.tsx`, `client/src/components/ui/AlertDialog.tsx` (delete confirmations).
- **Depends on:** M4, M3.
- **Steps:**
  1. Schemas list page (skeletons, optimistic delete).
  2. Schema editor: name field + grid columns `type | label | required` in that order plus a trailing actions column (reorder up/down, delete) (R30); add/remove rows; reorder; type select; ref_schema select for `schema-ref`. Create route `/schemas/new` resolved through `/schemas/:name` — `name === "new"` renders create mode and saves via `POST` (R29).
  3. Save → `PATCH` (or `POST` in create mode) with id-stable fields (renames keep `id`, new fields omit it); editor enforces ≥1 required field, non-empty labels, no duplicate labels (block/inline-422 before save); display resulting version; surface 409/422 inline.
  4. Delete confirmations via `<AlertDialog />`: schema delete shows affected content count (R22); field delete warns with the affected entry count (R21 propagation); deleted schemas render disabled in the list.
  5. `NewEntrySelector` (disabled when zero schemas) for M6.
- **Verify:** `pnpm --filter client build`; manual against running server: create schema → listed; rename/reorder/optional-add → version +1 with compat unchanged; delete warns with correct counts.
- **Out of scope:** content editor (M6), realtime (M7).

## M6 — Content UI (client)

- **Goal:** Editor creates/edits entries with type-appropriate inputs, a per-schema filter with an "All schemas" merged list, and conflicted entries render stored-old + new fields.
- **Spec refs:** SPEC §2 R29 (`/content/:schema` filter, `/content/new`), R31, R32, R33, R34 (entry-delete confirmation via `referencer_count`); §4 content routes + serialization; §5 optimistic updates/skeletons.
- **File scope:** `client/src/routes/ContentPage.tsx`, `client/src/routes/ContentEditorPage.tsx`, `client/src/routes/NewContentPage.tsx`, `client/src/hooks/useEntries.ts`, `client/src/components/DynamicEntryForm.tsx`, `client/src/components/EntryFieldInput.tsx`, `client/src/components/ReferenceSelect.tsx`, `client/src/components/ConflictField.tsx`.
- **Depends on:** M5, M3.
- **Steps:**
  1. Content list page: `/content` = "All schemas" merged view (one entries query per schema, merged into a single list) with an "All schemas" selector; `/content/:schema` = the same list filtered to one schema (R29); edit buttons; entry delete confirmed via `<AlertDialog />` warning against the row's `referencer_count` before the attempt (R34, resolved OQ2); conflict highlighting from the `conflict` flag.
  2. `/content/new` → `NewContentPage` using `NewEntrySelector`; disabled with zero schemas.
  3. Dynamic 2-column form: `label | type-input`, red `*` on required (R31).
  4. schema-ref `<select>` listing target entries labeled by the target's first required field by `sort_order` (fallback: first field; entry id when empty); for *optional* schema-ref fields the select gains a special `[empty]` entry that submits `null` (which the server's patch-like write semantics treat as the clear signal), removing the stored `content_ref` on save (R16, R32).
  5. Conflicted entry: render stored (old) field disabled with the new enabled field below (R33); auto-coerced values (e.g. `number`→`text`) carry over into the new field, otherwise it starts empty; save re-validates and sets `schema_version` (R17).
  6. Skeletons on load, optimistic updates on save/delete (R28).
- **Verify:** `pnpm --filter client build`; manual: create an entry exercising every field type; make a breaking schema change, reload the entry → dual-field conflicted editor, save → entry valid.
- **Out of scope:** realtime (M7).

## M7 — SSE realtime + conflict UX (server + client)

- **Goal:** Two logged-in editors observe each other's changes live: toasts on affected views, disabled rows/banners on deletion, dual-field render on incompatible type change.
- **Spec refs:** SPEC §2 R23–R26; §4 SSE contract; §6 useRealtime (fetch reader); §5 optimistic updates/skeletons.
- **File scope:** server `server/src/services/events.ts`, `server/src/routes/events.ts`, emit calls in `routes/schemas.ts` + `routes/entries.ts`, `server/src/app.ts` (mount + keep guarded); client `client/src/hooks/useRealtime.ts`, `client/src/components/Toast.tsx`, `<Alert />` banner + disabled states in `SchemasPage.tsx`, `ContentPage.tsx`, `SchemaEditorPage.tsx`, `ContentEditorPage.tsx`.
- **Depends on:** M6 (editors to modify), M3 (emit from content mutations).
- **Steps:**
  1. Server event emitter (in-memory, per schema) + `GET /api/events` (Bearer) streaming `schema.created|updated|deleted`, `entry.created|updated|deleted` with `changes` payloads per §4.
  2. Emit from every schema create/update/delete and entry create/update/delete mutation.
  3. Client `useRealtime` hook per SPEC §6: fetch-based SSE reader (Bearer header), subscribes to the schema(s) on screen, invalidates affected queries.
  4. `<Toast />` on events affecting the current view (R26).
  5. Transient states: schema deleted → open schema/entry editors disabled + `<Alert />` banner, listing rows disabled (R24); incompatible `typeChanged` → old field disabled with new field below (R25), pre-filled when the old value coerces losslessly (`number`→`text`).
- **Verify:** `pnpm --filter server test` and `pnpm --filter client build` pass; two-browser manual: A creates a schema → B sees toast + list update; A deletes the schema → B's open editor disabled + `<Alert />` banner; A changes a field type → B's open entry shows the dual-field editor.
- **Out of scope:** OT/collision merging, presence indicators, offline queueing.

## Resolved decisions

Logged 2026-08-06 by the spec owner; each is now explicit in SPEC v0.8 (§2/§5/§6) but retained here as the binding reading baked into the steps above.

1. **Deleting a referenced schema** — block with 409 naming the referencing schema (SPEC §5 invariant). Enforced in M1 `schemaService`.
2. **SSE Bearer auth transport** — fetch-based SSE reader keeps the `Authorization` header; no token in the URL. M7 step 3.
3. **Required `text` field** — must be non-empty; `""` violates required. M3 `contentService` validation.
4. **Type-changed value on save** — auto-coerce when lossless (`number`→`text`); otherwise the new field starts empty and the editor must re-enter. M3 validation, M6 step 5, M7 step 5.

Logged 2026-08-10 by the spec owner, resolving the v0.2 open questions against SPEC v0.9; retained here as the binding reading baked into the steps above. The v0.2 `## Open questions` were resolved and closed.

5. **Clearing an optional schema-ref on save (was OQ1)** — editor `POST`/`PATCH` writes are patch-like per SPEC §2 R16: an omitted key leaves the stored value unchanged (the editor client always sends a full payload in practice, but the contract permits partial writes); an explicit `null` for an *optional* field clears its stored value (for a schema-ref field, the stored `content_ref` is removed); `null` for a *required* field is a validation error (422). The "never `null`" invariant applies to reads/serialization only, so the write-side `null` clear signal does not contradict it. The server already implements this behavior, so no server change is required. Client affordance: the schema-ref `<select>` in the entry editor gains a special `[empty]` entry that submits `null`. Enforced in M3 `contentService` (step 2); the `[empty]` entry lands in M6 step 4 (the schema-ref `<select>`, per R32).
6. **R34 referencer count source (was OQ2)** — the count rides on the editor list: each row of `GET /api/schemas/:name/entries` carries `referencer_count` (count of distinct entries referencing the row via schema-ref; cheap via `idx_content_refs_target`). M3's editor list query returns it (step 3); M6's delete confirmation (step 1) and M7's realtime disable consume it.
7. **Pre-existing work against pre-v0.7 shapes (was OQ3)** — verified: nothing in the repo predates the v0.7 envelope / `content_refs` / `field_id`-keyed shapes; M1 and M3 are greenfield against v0.9.
8. **M4 route-table ownership (was OQ4)** — M4 registers the full R29 route table with placeholder pages; M5 (`/schemas/new`) and M6 (`/content/:schema`) replace the placeholders with real pages.
