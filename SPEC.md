# SPEC: headless-monkey CMS (v0.12 — 2026-08-16)

v0.12 — public-data-API pagination/sorting blessed and documented in §4; §3's non-goal scoped to search only; R32 records conflicted-entry exclusion from schema-ref select (§3, §4, §2 R32).
v0.11 — `schema_version` propagation becomes validation-based instead of blanket: on every schema update, each entry's stored data is validated against the new field definitions, and a compatible entry is bumped to the new version only when it would otherwise read as conflicted (`schema_version` below the new `compat_version`) (§2 R38). For breaking changes this bumps every compatible entry (as before); for non-breaking changes already-non-conflicted entries keep their version. This replaces R21's blanket bump and makes deconfliction automatic — an entry whose conflict is resolved by a change (a required field becoming optional, the conflicted field being deleted, a type-changed field being deleted) is bumped without per-change special-casing. The R35 retarget gate is unchanged (a mixed delete+retarget PATCH skips the bump). §2 R21, R38; §7 delete-field example updated.
v0.10 — schema updates get a dry-run preview plus a confirmation gate: `PATCH /api/schemas/:name?preview=true` returns the would-be `{breaking, version, compatVersion, affectedEntries}` without writing or emitting SSE, with per-change-kind affected-entry rules and the R32 label convention (R36); the schema editor confirms breaking saves through an `<AlertDialog />` showing the affected entries, applies non-breaking saves immediately, and lands on the new `?conflicted=1` content filter after a confirmed breaking save (R29, R37)
v0.9 — resolved OQ1/OQ2 from the v0.8 reconciliation: editor `POST`/`PATCH` writes are patch-like — an omitted key leaves the stored value unchanged, and an explicit `null` for an *optional* field clears its stored value (for a schema-ref field, the stored `content_ref` is removed); `null` for a *required* field is a validation error (422); the "never `null`" invariant applies to reads/serialization only, so the write-side `null` clear signal does not contradict it (§2 R16); editor list rows add `referencer_count`, the count of distinct entries referencing the row via schema-ref, so the delete confirmation can warn before the attempt (§4)
v0.8 — clarified the R21/R35 mixed PATCH: a single update that both deletes a field and retargets a schema-ref field skips the schema-wide `schema_version` bump (the retarget purge runs, entries stay conflicted) (§2 R21); R29 adds the `/content/:schema` filtered content route with the "All schemas" merged view and the `/schemas/new` create-route (resolved via `/schemas/:name`); R30 adopts the `type | label | required` column order plus a trailing actions column (§2 R29, R30)
v0.7 — BREAKING: the public content API returns a {schema, entries} wrapper with values keyed by String(field_id) (not label) and a schema.fields id→label map; public entries carry no redundant per-entry schema field; schema-ref storage moves to a normalized content_refs table; deleting a referenced entry clears the incoming refs in the same transaction (R34); ref_schema retargeting purges refs and leaves affected entries conflicted until re-edited (R35); §2 R15/R18/R19/R21, §4, §5, §7
v0.6 — BREAKING: the public content API `values` responses are keyed by field label (not numeric `field_id`) and schema-ref values serialize as `{id, schema}` instead of the raw target id; the editor content routes keep `field_id`-keyed `values` with raw schema-ref numbers (§2 R15, §4, §7)
v0.5 — schema fields must have non-empty labels and every schema needs at least one required field (§2 R8, R30)
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
- R8. `POST /api/schemas` with zero fields, with an empty/whitespace-only field label, with no required fields, or with duplicate field labels returns 422; with a `name` that already exists returns 409. `PATCH /api/schemas/:name` returns 422 with zero fields, with an empty/whitespace-only field label, with no required fields, or with duplicate field labels.
- R9. Field `type` is limited to `text|number|boolean|date|schema-ref`; anything else returns 422. A `schema-ref` field requires a valid existing `ref_schema` name.
- R10. Circular `schema-ref` references (direct or transitive) return 422 on create/update of the schema that would close the cycle.
- R11. On schema create, `version=1` and `compat_version=1`; `creation_date`/`last_modified_date`/`created_by`/`last_modified_by` are set.
- R12. Every schema update increments `version` by exactly 1.
- R13. Non-breaking changes keep `compat_version` unchanged: adding an *optional* field; changing `number→text`; changing `required→optional`; renaming a field label; reordering fields.
- R14. Every other change sets `compat_version = version`: adding a *required* field; deleting a field; `text→number`; `optional→required`; any change into/out of `boolean`, `date`, or `schema-ref`; changing a `schema-ref`'s `ref_schema`.
- R15. Fields are referenced by stable numeric `field_id` in content rows, write payloads, editor `values` responses, public API `values`, and SSE events — never by label; renaming a label changes no stored data and does not invalidate content. The public API is self-describing through `schema.fields` (a `String(field_id)` → current label map), so consumers can render labels and detect shape drift by comparing `schema.version` against the version they were built for.

Content & public API
- R16. Creating an entry requires every required field to have a value valid for its type; a required `text` field must be non-empty. Violation returns 422. Unknown `field_id` returns 422. A `schema-ref` value must reference an existing entry id of the target schema; violation returns 422. An *optional* schema-ref field with no target is omitted from `values` (absent key), never serialized as `null` — this "never `null`" invariant applies to reads/serialization only. Editor `POST`/`PATCH` writes are patch-like: an omitted key leaves the stored value unchanged (the editor client always sends a full payload in practice, but the contract permits partial writes), and an explicit `null` for an optional field clears its stored value (for a schema-ref field, the stored `content_ref` is removed); `null` for a required field is a validation error (422).
- R17. Saving an entry sets its `schema_version` to the schema's current `version` (conflict is resolved by the edit itself). On save, values that coerce losslessly into a changed field type (only `number`→`text`) are carried over; values invalid for the new type must be re-entered.
- R18. `GET /api/content/:schema` returns 200 with a `{schema, entries}` response containing only valid entries (`schema_version >= compat_version`); unknown schema returns 404.
- R19. `GET /api/content/:schema/:id` returns 200 with the same `{schema, entries}` shape and a one-element `entries` array for a valid entry, 404 if the id does not exist, 422 if the entry exists but is conflicted (`schema_version < compat_version`).
- R20. The public data API is unauthenticated and stateless: R4's auth guard does not apply to it.
- R21. Deleting a field propagates: that field's `content_rows` and `content_refs` are removed from every entry of the schema. The `schema_version` bump follows R38 (validation-based): an entry whose remaining data is compatible with the new schema shape is bumped to the new `version`; an entry with incompatible data keeps its `schema_version`. Exception (mixed PATCH): when a single schema update both deletes a field and retargets a `schema-ref` field (R35), the `schema_version` bump is skipped entirely — the retargeted field's `content_refs` are still purged, but entries keep their `schema_version` and remain conflicted (the retarget already set `compat_version = version`, so no entry is un-conflicted while it still lacks a valid target for the retargeted field).
- R22. Deleting a schema cascades: its fields and all its content (rows included) are deleted. No content can exist without its schema. The delete confirmation (`<AlertDialog />`) warns with the affected content count before the cascade.
- R34. Deleting an entry clears every other entry's schema-ref value pointing at it: the `content_refs` rows targeting the entry are removed in the same transaction as the entry itself, and the delete returns 204 (never 409). The referencing entries keep their other values but lose that field — per the never-`null` read invariant it is omitted from their `values` until re-edited. The editor list rows expose `referencer_count` (the count of distinct entries referencing the entry via schema-ref), and the delete confirmation warns against that count before the attempt. This is the entry-level mirror of R22.
- R35. Changing a schema-ref field's `ref_schema` propagates: that field's `content_refs` are removed from every entry of the schema, and the affected entries stay conflicted until re-edited — `schema_version` is **not** bumped (the entry is incomplete without a target for the still-existing field; the `compat_version` bump already carries the conflict). This is the R21-style propagation applied to a ref-target change, minus the version bump.
- R36. `PATCH /api/schemas/:name?preview=true` is a dry-run of the same update: it returns 200 with the would-be `{ breaking: boolean, version: number, compatVersion: number, affectedEntries: [{ id: number, label: string, affectedFieldIds: number[] }] }`, performs no write, and emits no SSE event; validation and 404/422 outcomes are identical to a real PATCH (R8–R10). `version`/`compatVersion` are the values the update would produce (R12–R14). An entry is *affected* when the update disturbs its stored data or leaves it invalid: a deleted field flags every entry that stores a `content_rows` row or `content_refs` ref for it (R21); a new *required* field flags every entry; a kept field whose type changes (other than `number→text`, R17) flags every entry with a stored value for that field; a schema-ref retarget flags every entry holding a ref for that field (R35); `optional→required` flags entries with no stored value or a stored text `""`; `number→text`, renames, reordering, `required→optional`, and new optional fields flag nothing. Each entry's `label` is the stored value of the schema's first required field by `sort_order` (R32's convention), or `Entry #<id>` when that field has no stored value.
- R38. On every schema update, each entry's stored data is validated against the new field definitions, simulating the post-update state (deleted fields are ignored — their data is removed; retargeted schema-ref values are treated as purged). A compatible entry has its `schema_version` set to the new `version` **only when it would otherwise read as conflicted** — i.e. its `schema_version` is below the new `compat_version`. For a breaking change `compat_version = version` (R14), so every compatible entry is bumped (preventing a false conflict); for a non-breaking change `compat_version` is unchanged (R13), so already-non-conflicted entries keep their `schema_version` (their data was not touched) and only entries whose conflict the change resolved are bumped. An incompatible entry keeps its `schema_version` and is conflicted when `schema_version < compat_version`. Validation per field: a required field must have a valid value; a scalar value must be type-valid (with lossless `number`→`text` coercion, R17); a schema-ref value must reference an entry that exists in the declared `ref_schema`; a stored ref on a scalar field, or a stored scalar row on a schema-ref field, is invalid. This validation is the single mechanism that deconflicts entries when a constraint is removed — a required field becoming optional, the conflicted field being deleted, a type-changed field being deleted — with no per-change special-casing. The bump is skipped when the update retargets a schema-ref (R35's gate, including the R21 mixed-PATCH exception). Note the preview's `affectedEntries` (R36) reports data-disturbed entries independently of this bump classification.

Multi-user (SSE)
- R23. `GET /api/events` (Bearer auth) streams SSE. Events: `schema.created`, `schema.updated` (with a `changes` list), `schema.deleted`, `entry.created`, `entry.updated`, `entry.deleted`.
- R24. When a `schema.deleted` arrives for the schema currently on screen: schema editor and entry editor render disabled with an `<Alert />` banner; the row in schema/content listings is disabled and not interactable.
- R25. When a `schema.updated` changes a field's type to an incompatible type (a `typeChanged` change) while an entry of that schema is open in the editor, the old field renders disabled with the newly-typed empty field right below it.
- R26. A change by another user that affects the current view produces a `<Toast />` on screen.

Client
- R27. All data access uses `@tanstack/react-query`. Raw `fetch` inside `useEffect` is forbidden.
- R28. Pure loading states render skeletons (when no data has arrived); data mutations use optimistic updates.
- R29. Routes: `/login`, `/admin` (users), `/schemas`, `/schemas/:name`, `/content`, `/content/:schema` (the same content list page filtered to one schema, with an "All schemas" selector that merges one entries query per schema into a single list), `/content/new`, `/content/:schema/:id`. The content routes accept `?conflicted=1` to filter the listing to conflicted entries only, with a "Show conflicted only" toggle. The schema create-route is `/schemas/new`, resolved through `/schemas/:name` (the editor treats `name === "new"` as create mode). `admin` tokens can only reach `/admin`; editor tokens cannot reach `/admin`.
- R30. The schema editor is a sortable field grid with columns `type | label | required` in that order, plus a trailing actions column (reorder up/down, delete).
- R31. The content editor is a dynamic 2-column form (`label | type-input`); required fields show a red `*` next to the label.
- R32. A `schema-ref` field renders a `<select>` of the target schema's entries, labeled by the value of the target's first required field by `sort_order`. The fallback to first field by `sort_order` (then entry id) exists only for legacy schemas that predate the ≥1-required-field rule. Conflicted entries (`schema_version` below the target schema's `compat_version`) are excluded from the select's options.
- R33. When editing a conflicted entry, the stored (old) version of each affected field renders disabled with the new enabled field below it.
- R37. A breaking schema update (R14) requires confirmation before it is applied. The schema editor requests the R36 preview on save and, when `breaking` is true, shows an `<AlertDialog />` (R22/§5 role) naming the affected entries (count plus an inline list of `label #id`) before sending the PATCH; the dialog never navigates — canceling returns to the editor with the draft untouched, and confirming lands on `/content/:schema?conflicted=1` (R29) after the save succeeds. A non-breaking update (R13) applies immediately without a confirmation dialog.

## 3. Non-goals (binding)

No search in the data API. No content writes through the public API (it is read-only). No registration/signup UI — only `admin` creates editors. No self-service password change. No refresh-token rotation, password reset, rate limiting, or account lockout. No content/history versioning (only schema versioning). No asset/file upload. No i18n, theming, or dark mode. No roles beyond `admin`/`editor`. No per-field permissions. No email/notification system beyond in-app toasts.

## 4. Contracts (frozen)

Changes here require a spec revision, not a judgment call.

DB (SQLite via better-sqlite3):
```sql
users(id INTEGER PK AUTOINCREMENT, login TEXT NOT NULL UNIQUE,
      hashed_password TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);

schemas(name TEXT PK, creation_date TEXT NOT NULL, created_by TEXT NOT NULL,
        last_modified_date TEXT NOT NULL, last_modified_by TEXT NOT NULL,
        version INTEGER NOT NULL, compat_version INTEGER NOT NULL);

schema_fields(id INTEGER PK AUTOINCREMENT,
      schema TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
      label TEXT NOT NULL, type TEXT NOT NULL
        CHECK(type IN ('text','number','boolean','date','schema-ref')),
      required INTEGER NOT NULL, ref_schema TEXT, sort_order INTEGER NOT NULL,
      UNIQUE (schema, label),
      CHECK (type != 'schema-ref' OR ref_schema IS NOT NULL));

content(id INTEGER PK AUTOINCREMENT,
      schema TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL, creation_date TEXT NOT NULL,
      created_by TEXT NOT NULL, last_modified_date TEXT NOT NULL,
      last_modified_by TEXT NOT NULL);

content_rows(content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
      field_id INTEGER NOT NULL REFERENCES schema_fields(id) ON DELETE CASCADE,
      value TEXT, PRIMARY KEY(content_id, field_id));

content_refs(content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
      field_id INTEGER NOT NULL REFERENCES schema_fields(id) ON DELETE CASCADE,
      target_content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE RESTRICT,
      PRIMARY KEY(content_id, field_id));

CREATE INDEX idx_content_refs_target ON content_refs(target_content_id);
```

JWT: HS256, secret `JWT_SECRET` (`.env`), payload `{ sub: <login>, role: 'admin'|'editor', iat, exp }`, expiry 8h. Sent as `Authorization: Bearer <token>`.

Public API (no auth):
- `GET /api/content/:schema` → 200 `{ schema: { name, version, fields: { "<field_id>": "<label>", ... } }, entries: [ { id, schema_version, values: { "<field_id>": <value>, ... } } ], pagination: { nextCursor, prevCursor } }` (valid entries only); 404 unknown schema.
- `GET /api/content/:schema/:id` → the same `{schema, entries}` shape with a one-element `entries` array; 404 unknown id; 422 conflicted.
- `values` keys are `String(field_id)` (the stable id, unique across versions by R13's id-stable contract); labels are provided by `schema.fields` for display and for detecting renames; schema-ref values serialize as `{id: <target_entry_id>, schema: <ref_schema_name>}`. Public entries do **not** carry a `schema` field — the envelope's `schema.name` names the schema. There is no version header — `schema.version` is authoritative.
- Query params: `limit`, `cursor`, `direction`, `sort_field`, `sort_order`. Any of `limit`/`cursor`/`direction` present → paginated path; none present → all valid entries, no pagination. Sorting without pagination params (`sort_field`/`sort_order` alone) returns all valid entries in that order.
- `limit`: integer, clamped to [1, 200]; absent or non-numeric on the paginated path → 50.
- `cursor`: opaque string; undecodable → first page (lenient).
- `direction`: `forward` | `backward`; any other value is ignored (treated as forward).
- `sort_field`: `id` | `date` | `modified` | a positive integer field_id. `sort_order`: `asc` | `desc`; with `sort_order` but no `sort_field`, the sort is by `modified` in that order.
- 422 rules: non-integer/non-literal `sort_field` → 422; integer `sort_field` not a field of the schema → 422; sorting by `boolean` or `schema-ref` field → 422; invalid `sort_order` → 422.
- Default ordering (no sort params): `modified desc` (last-modified date descending, ties broken by entry id descending).
- NULLS LAST: for a custom-field sort, rows with a NULL value sort last in display order, in both directions.
- Envelope: both public routes respond with `pagination: { nextCursor, prevCursor }` (`string | null`); cursors are null exactly when no entries remain in that direction (keyset on the sort column with entry-id tiebreak).

Auth & control panel (Bearer auth unless noted):
- `POST /api/auth/login` `{login,password}` → `{token}` (no auth). `POST /api/auth/logout` → 204. `GET /api/auth/me` → `{login, role}`.
- Users (admin only): `GET /api/users`; `POST /api/users` `{login,password}`; `PATCH /api/users/:id` `{password?, disabled?}`; `DELETE /api/users/:id`.
- Schemas (editor): `GET /api/schemas`; `POST /api/schemas` `{name, fields:[{label,type,required,ref_schema?}]}`; `GET /api/schemas/:name`; `PATCH /api/schemas/:name` (same `fields` shape; existing fields carry their `id`, new fields omit it, absent ids are deleted; appending `?preview=true` returns the R36 dry-run payload instead of applying); `DELETE /api/schemas/:name`.
- Content (editor): `GET /api/schemas/:name/entries` (all entries incl. conflicted, each with `conflict: boolean` and `referencer_count` — the count of distinct entries referencing this one via schema-ref, so the delete confirmation can warn before the attempt (R34); `values` keyed by `String(field_id)` with schema-ref values as raw target content-id numbers — the editor shape, distinctly field_id-keyed from the public API's `{schema, entries}` wrapper; append `?conflicted=1` to filter server-side to conflicted entries only (`schema_version < compat_version`), applied before pagination); `GET /api/entries/:id` (single entry in the same editor shape — `conflict` and `referencer_count` present; 404 for unknown id; no 422 for conflicted entries); `POST /api/schemas/:name/entries`; `PATCH /api/entries/:id`; `DELETE /api/entries/:id`. Editor `POST`/`PATCH` responses carry the same field_id-keyed `values` shape.
- SSE: `GET /api/events` (Bearer). Event JSON: `{ type, schema, entryId?, version?, compatVersion?, by, changes? }`; `changes: [{ kind: 'renamed'|'added'|'deleted'|'typeChanged'|'requiredChanged'|'reordered', fieldId?, label?, type?, required? }]`.

Value serialization: `content_rows.value` (DB storage, JSON-encoded TEXT) holds `text|number|boolean|date` scalars only — text→string; number→number; boolean→boolean; date→`"YYYY-MM-DD"`. Schema-ref targets are stored as INTEGER in `content_refs.target_content_id`, never as a JSON number in `content_rows.value`. Public `values` use the same per-type encoding, with schema-ref values enriched to `{id: <target_entry_id>, schema: <ref_schema_name>}`. An optional schema-ref field with no target is omitted (absent key).

## 5. Constraints & invariants (binding)

- pnpm workspaces monorepo. `pnpm-workspace.yaml` lists `server/` (Express + better-sqlite3 + vitest) and `client/` (Vite + React + TypeScript strict), each with its own `package.json`; the root `package.json` is private and only fans out dev/test/build across the packages. Dev: Vite proxies `/api` to the server. `.env` at repo root (loaded explicitly by the server package): `ADMIN_PASSWORD`, `JWT_SECRET`, `PORT`, `DATABASE_PATH`.
- React 19; `react-router@7` in SPA mode; shadcn/ui for UI components (`@base-ui/react` is shadcn's underlying primitive set by default — use shadcn components; reach for raw base-ui primitives only when shadcn has no implementation; never Radix); `@phosphor-icons/react` for icons (never lucide-react); `@tanstack/react-query` for all data.
- shadcn/ui component roles (binding): user confirmations (e.g. delete warnings, R22; breaking schema saves, R37) use `<AlertDialog />`; passive banner states (e.g. disabled-on-delete, R24) use `<Alert />`; transient notifications (R26) use `<Toast />`.
- Server: TypeScript strict, no ORM — a sequential SQL migration runner plus thin repositories. Password hashing with bcrypt, cost 10.
- Tests: vitest + supertest against an Express app factory (no listening server in tests). The DB is per-test and in-memory/file-temp.
- One component per `.tsx` file. State via `useReducer`/query state; no `useEffect`+`useRef` indirection for data.
- Circular `schema-ref` detection must hold across the full schema graph, not just direct neighbors.
- Deleting a schema that is referenced by another schema's `schema-ref` field is blocked with 409 naming the referencing schema (prevents dangling refs).
- Conflict is version-only (`schema_version < compat_version`); referential integrity is guaranteed by construction because referenced-entry deletion clears the incoming refs in the same transaction (R34) and `ref_schema` retargeting purges refs (R35).
- Deleting an entry that is referenced by another entry's schema-ref value clears those refs in the same transaction — the delete succeeds (204) and the referencers' field becomes an absent key until re-edited (R34); deleting a schema that is referenced by another schema's `schema-ref` field is blocked with 409 naming the referencing schema (existing invariant, unchanged).

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

API status codes: `GET /api/content/car` → 200 (valid only) / 404 (unknown schema). `GET /api/content/car/7` → 200 / 404 (no entry 7) / 422 (entry 7 exists, conflicted). Editing a conflicted entry → it becomes valid (R17). Deleting field `f3` of schema `car` → every `car` entry loses row `(entryId, f3)`; each entry whose remaining data satisfies the new shape gets `schema_version = car.version` (R38), entries with incompatible data keep their `schema_version`.

Preview: `PATCH /api/schemas/car?preview=true` deleting field `f3` (3 of 5 `car` entries still store a value under `f3`) → `{ "breaking": true, "version": 5, "compatVersion": 5, "affectedEntries": [{ "id": 2, "label": "W123", "affectedFieldIds": [3] }, ...] }`, with no write applied and no SSE event.

Serialization: `GET /api/content/person` → `{ "schema": { "name": "person", "version": 3, "fields": { "5": "name", "6": "age" } }, "entries": [ { "id": 10, "schema_version": 2, "values": { "5": "Ada", "6": 36 } } ] }`. A schema-ref value serializes as `{ "id": 42, "schema": "person" }` under a `String(field_id)` key.

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
