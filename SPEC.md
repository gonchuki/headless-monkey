# SPEC: headless-monkey CMS (v0.4 — 2026-08-06)

v0.4 — corrected UI component mapping: user confirmations use `<AlertDialog />`; `<Alert />` is the passive banner; `<Toast />` is the notification toast (§2 R22, R24, R26; §5)
v0.3 — resolved build-plan decisions: required text must be non-empty; lossless value coercion on type change; referenced-schema delete blocked (409); SSE via fetch reader (§2 R16–R17, §5, §6)
v0.2 — layout changed to a pnpm workspaces monorepo (`client/` and `server/` packages), §5 §8

## 1. Intent (binding)

A minimal CMS: a public, stateless, read-only data API backed by SQLite, plus an authenticated control panel for schema and content management. Two roles: `admin` (a fixed `admin`/env-password login that exists only to administer editors) and `editor` (DB-backed users who manage schemas and content). Schema versioning with a `compat_version` boundary determines which content is still readable vs. in conflict. A live multi-user layer (SSE) keeps concurrent editors' screens and toasts in sync. This exists as a frontend-challenge deliverable; polish and feature breadth are secondary to a correct, testable core.

## 2. Requirements (binding)

Auth & users
- R1. `POST /api/auth/login` with `login=admin` + `ADMIN_PASSWORD` from `.env` returns a JWT with `role=admin`. `admin` is never a row in `users`.
- R2. Login with an editor's `login`+`password` where `disabled=0` returns a JWT with `role=editor`. A `disabled=1` editor's login returns 401.
- R3. Unknown login or wrong password returns 401. The response body does not distinguish which was wrong.
- R4. Every control-panel route (all routes in §4 except the public API and `/api/auth/login`) returns 401 when `Authorization: Bearer <token>` is missing/invalid.
- R5. A token with `role=admin` gets 403 on all CMS (schema/content) routes. A token with `role=editor` gets 403 on all `/api/users` routes.
- R6. `POST /api/users` with a duplicate `login` returns 409. Editors are created with a `hashed_password`; the plaintext is never returned or logged.
- R7. `PATCH /api/users/:id` can change `password` and/or flip `disabled`. `DELETE /api/users/:id` removes the editor. (No admin row exists to be modified/deleted.)

Schema model & versioning
- R8. `POST /api/schemas` with zero fields returns 422; with duplicate field labels returns 422; with a `name` that already exists returns 409.
- R9. Field `type` is limited to `text|number|boolean|date|schema-ref`; anything else returns 422. A `schema-ref` field requires a valid existing `ref_schema` name.
- R10. Circular `schema-ref` references (direct or transitive) return 422 on create/update of the schema that would close the cycle.
- R11. On schema create, `version=1` and `compat_version=1`; `creation_date`/`last_modified_date`/`created_by`/`last_modified_by` are set.
- R12. Every schema update increments `version` by exactly 1.
- R13. Non-breaking changes keep `compat_version` unchanged: adding an *optional* field; changing `number→text`; changing `required→optional`; renaming a field label; reordering fields.
- R14. Every other change sets `compat_version = version`: adding a *required* field; deleting a field; `text→number`; `optional→required`; any change into/out of `boolean`, `date`, or `schema-ref`; changing a `schema-ref`'s `ref_schema`.
- R15. Fields are referenced by stable numeric `field_id` everywhere (content rows, API payloads, SSE events), never by label. Renaming a label changes no stored data and does not invalidate content.

Content & public API
- R16. Creating an entry requires every required field to have a value valid for its type; a required `text` field must be non-empty. Violation returns 422. Unknown `field_id` returns 422. A `schema-ref` value must reference an existing entry id of the target schema; violation returns 422.
- R17. Saving an entry sets its `schema_version` to the schema's current `version` (conflict is resolved by the edit itself). On save, values that coerce losslessly into a changed field type (only `number`→`text`) are carried over; values invalid for the new type must be re-entered.
- R18. `GET /api/content/:schema` returns 200 with only valid entries (`schema_version >= compat_version`). Unknown schema returns 404.
- R19. `GET /api/content/:schema/:id` returns 200 for a valid entry, 404 if the id does not exist, and 422 if the entry exists but is conflicted (`schema_version < compat_version`). Neither is ever returned together.
- R20. The public data API is unauthenticated and stateless: R4's auth guard does not apply to it.
- R21. Deleting a field propagates: that field's `content_rows` are removed from every entry of the schema, and each surviving entry's `schema_version` is set to the schema's current `version`.
- R22. Deleting a schema cascades: its fields and all its content (rows included) are deleted. No content can exist without its schema. The delete confirmation (`<AlertDialog />`) warns with the affected content count before the cascade.

Multi-user (SSE)
- R23. `GET /api/events` (Bearer auth) streams SSE. Events: `schema.created`, `schema.updated` (with a `changes` list), `schema.deleted`, `entry.created`, `entry.updated`, `entry.deleted`.
- R24. When a `schema.deleted` arrives for the schema currently on screen: schema editor and entry editor render disabled with an `<Alert />` banner; the row in schema/content listings is disabled and not interactable.
- R25. When a `schema.updated` changes a field's type to an incompatible type (a `typeChanged` change) while an entry of that schema is open in the editor, the old field renders disabled with the newly-typed empty field right below it.
- R26. A change by another user that affects the current view produces a `<Toast />` on screen.

Client
- R27. All data access uses `@tanstack/react-query`. Raw `fetch` inside `useEffect` is forbidden.
- R28. Pure loading states render skeletons (when no data has arrived); data mutations use optimistic updates.
- R29. Routes: `/login`, `/admin` (users), `/schemas`, `/schemas/:name`, `/content`, `/content/new`, `/content/:schema/:id`. `admin` tokens can only reach `/admin`; editor tokens cannot reach `/admin`.
- R30. The schema editor is a 3-column sortable grid: `field_label | field_type | required`.
- R31. The content editor is a dynamic 2-column form (`label | type-input`); required fields show a red `*` next to the label.
- R32. A `schema-ref` field renders a `<select>` of the target schema's entries, labeled by the value of the target's first required field by `sort_order` (fallback: first field by `sort_order`; empty value → the entry id).
- R33. When editing a conflicted entry, the stored (old) version of each affected field renders disabled with the new enabled field below it.

## 3. Non-goals (binding)

No pagination or search in the data API. No content writes through the public API (it is read-only). No registration/signup UI — only `admin` creates editors. No self-service password change. No refresh-token rotation, password reset, rate limiting, or account lockout. No content/history versioning (only schema versioning). No asset/file upload. No i18n, theming, or dark mode. No roles beyond `admin`/`editor`. No per-field permissions. No email/notification system beyond in-app toasts.

## 4. Contracts (frozen)

Changes here require a spec revision, not a judgment call.

DB (SQLite via better-sqlite3):
```sql
users(id INTEGER PK AUTOINCREMENT, login TEXT NOT NULL UNIQUE,
      hashed_password TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);

schemas(name TEXT PK, creation_date TEXT, created_by TEXT,
        last_modified_date TEXT, last_modified_by TEXT,
        version INTEGER NOT NULL, compat_version INTEGER NOT NULL);

schema_fields(id INTEGER PK AUTOINCREMENT, schema TEXT NOT NULL REFERENCES schemas(name),
      label TEXT NOT NULL, type TEXT NOT NULL
        CHECK(type IN ('text','number','boolean','date','schema-ref')),
      required INTEGER NOT NULL, ref_schema TEXT, sort_order INTEGER NOT NULL);

content(id INTEGER PK AUTOINCREMENT, schema TEXT NOT NULL REFERENCES schemas(name),
      schema_version INTEGER NOT NULL, creation_date TEXT, created_by TEXT,
      last_modified_date TEXT, last_modified_by TEXT);

content_rows(content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
      field_id INTEGER NOT NULL REFERENCES schema_fields(id),
      value TEXT, PRIMARY KEY(content_id, field_id));
```

JWT: HS256, secret `JWT_SECRET` (`.env`), payload `{ sub: <login>, role: 'admin'|'editor', iat, exp }`, expiry 8h. Sent as `Authorization: Bearer <token>`.

Public API (no auth):
- `GET /api/content/:schema` → 200 `[{ id, schema, schema_version, creation_date, created_by, last_modified_date, last_modified_by, values: { <fieldId>: <value> } }]` (valid entries only); 404 unknown schema.
- `GET /api/content/:schema/:id` → same single-object shape; 404 unknown id; 422 conflicted.

Auth & control panel (Bearer auth unless noted):
- `POST /api/auth/login` `{login,password}` → `{token}` (no auth). `POST /api/auth/logout` → 204. `GET /api/auth/me` → `{login, role}`.
- Users (admin only): `GET /api/users`; `POST /api/users` `{login,password}`; `PATCH /api/users/:id` `{password?, disabled?}`; `DELETE /api/users/:id`.
- Schemas (editor): `GET /api/schemas`; `POST /api/schemas` `{name, fields:[{label,type,required,ref_schema?}]}`; `GET /api/schemas/:name`; `PATCH /api/schemas/:name` (same `fields` shape; existing fields carry their `id`, new fields omit it, absent ids are deleted); `DELETE /api/schemas/:name`.
- Content (editor): `GET /api/schemas/:name/entries` (all entries incl. conflicted, each with `conflict: boolean`); `POST /api/schemas/:name/entries`; `PATCH /api/entries/:id`; `DELETE /api/entries/:id`.
- SSE: `GET /api/events` (Bearer). Event JSON: `{ type, schema, entryId?, version?, compatVersion?, by, changes? }`; `changes: [{ kind: 'renamed'|'added'|'deleted'|'typeChanged'|'requiredChanged'|'reordered', fieldId?, label?, type?, required? }]`.

Value serialization in `content_rows.value` (JSON-encoded TEXT): text→string; number→number; boolean→boolean; date→`"YYYY-MM-DD"`; schema-ref→target content id (number).

## 5. Constraints & invariants (binding)

- pnpm workspaces monorepo. `pnpm-workspace.yaml` lists `server/` (Express + better-sqlite3 + vitest) and `client/` (Vite + React + TypeScript strict), each with its own `package.json`; the root `package.json` is private and only fans out dev/test/build across the packages. Dev: Vite proxies `/api` to the server. `.env` at repo root (loaded explicitly by the server package): `ADMIN_PASSWORD`, `JWT_SECRET`, `PORT`, `DATABASE_PATH`.
- React 19; `react-router@7` in SPA mode; shadcn/ui for UI components (`@base-ui/react` is shadcn's underlying primitive set by default — use shadcn components; reach for raw base-ui primitives only when shadcn has no implementation; never Radix); `@phosphor-icons/react` for icons (never lucide-react); `@tanstack/react-query` for all data.
- shadcn/ui component roles (binding): user confirmations (e.g. delete warnings, R22) use `<AlertDialog />`; passive banner states (e.g. disabled-on-delete, R24) use `<Alert />`; transient notifications (R26) use `<Toast />`.
- Server: TypeScript strict, no ORM — a sequential SQL migration runner plus thin repositories. Password hashing with bcrypt, cost 10.
- Tests: vitest + supertest against an Express app factory (no listening server in tests). The DB is per-test and in-memory/file-temp.
- One component per `.tsx` file. State via `useReducer`/query state; no `useEffect`+`useRef` indirection for data.
- Circular `schema-ref` detection must hold across the full schema graph, not just direct neighbors.
- Deleting a schema that is referenced by another schema's `schema-ref` field is blocked with 409 naming the referencing schema (prevents dangling refs).

## 6. Suggested approach (negotiable)

If you have a better approach that satisfies §2–§5, propose it before coding. Otherwise: a `createApp()` factory composing routers over a shared sqlite connection; a migration runner; a small `SchemaService` (version/compat rules, cycle detection, propagation) and `ContentService`; JWT middleware; SSE fan-out via an in-memory `EventEmitter` keyed by schema name; client: react-router routes, query hooks per screen, a `useRealtime` hook that opens the SSE stream via fetch (Bearer header — `EventSource` cannot set headers), invalidates the current schema's queries, and drives the transient disabled/banner/dual-field states + toasts.

## 7. Examples (binding where present)

compat transitions (single field change, `version` always +1):
| change | compat_version |
|---|---|
| add optional field | unchanged |
| `number`→`text` | unchanged |
| required→optional | unchanged |
| rename label / reorder | unchanged |
| add required field | = new version |
| delete field | = new version |
| `text`→`number` | = new version |
| optional→required | = new version |
| into/out of `boolean`, `date`, `schema-ref`; ref target change | = new version |

API status codes: `GET /api/content/car` → 200 (valid only) / 404 (unknown schema). `GET /api/content/car/7` → 200 / 404 (no entry 7) / 422 (entry 7 exists, conflicted). Editing a conflicted entry → it becomes valid (R17). Deleting field `f3` of schema `car` → every `car` entry loses row `(entryId, f3)` and gets `schema_version = car.version`.

Serialization: `values: { "12": "Civic", "13": 2019, "14": true, "15": "2021-05-04", "16": 42 }` for one row referencing field ids 12–16.

## 8. Plan

- M1 — Scaffold: pnpm workspaces monorepo (`server/` + `client/`), Vite proxy, `.env`, vitest harness, `GET /api/health`. Verify: `pnpm dev` serves the client and `/api/health` 200s; `pnpm test` runs.
- M2 — DB + schema management: migrations, repositories, `SchemaService` (create/update/delete, version/compat rules R8–R15, R21–R22, cycle detection R10). Verify: vitest covers R8–R15, R21–R22 incl. every row of §7's compat table.
- M3 — Auth + users: login/logout/me, JWT middleware, users CRUD (R1–R7). Verify: vitest covers R1–R7.
- M4 — Content + public API: entry create/edit/delete, validation R16–R17, propagation R21, public routes R18–R20. Verify: vitest covers R16–R20 and serialization examples in §7.
- M5 — Client shell + auth: routes R29, login screen, `/admin` users screen, route guards, nav. Verify: admin reaches only `/admin`; editor reaches only CMS; login/logout work against M3.
- M6 — Schemas UI: listing, 3-column sortable editor R30, delete confirmations via `<AlertDialog />` with affected counts (R22), schema selector for new content (disabled with zero schemas). Verify: R29–R30 and R22's confirmation flows work end-to-end.
- M7 — Content UI: listing with edit buttons + conflict highlighting, dynamic 2-column editor R31–R32, conflicted-entry dual rendering R33, skeletons/optimistic updates R27–R28. Verify: create/edit/delete content against a schema by hand.
- M8 — SSE realtime: `GET /api/events`, client `useRealtime`, disabled rows/`<Alert />` banners/dual-fields R24–R25, `<Toast />` notifications R26. Verify: two browser sessions against one server reproduce R23–R26.

## 9. Review protocol

Before presenting any milestone, walk §2–§7 line by line and produce a table mapping each requirement to the file+line that satisfies it, or `UNMET`. Do not present a milestone with `UNMET` rows unless you state exactly what is missing and why.
