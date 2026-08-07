# PLAN-14 — SQLite persistence: open the real DATABASE_PATH file at boot

## Goal

The production server currently runs against an in-memory SQLite database that is discarded on shutdown. `server/src/index.ts` calls `createApp()` with no database; `createApp`'s fallback (`server/src/app.ts`, `const database = db ?? openDatabase();`) calls `openDatabase()` with no path, and `openDatabase` (`server/src/db/database.ts`) coerces a missing or empty `dbPath` to `":memory:"`. Meanwhile `loadAppEnv` (`server/src/config/env.ts`) correctly loads `DATABASE_PATH` from the root `.env` (default `./data/headless-monkey.db`) but nothing ever passes it through.

Fix the production bootstrap so the app opens and persists to the configured SQLite file. In-memory databases for tests must keep working untouched.

## Files involved

- `server/src/index.ts` — bootstrap; currently `const app = createApp();`. This is where the file DB must be opened and passed in.
- `server/src/config/env.ts` — `loadAppEnv` produces `databasePath`. Decide where path normalization lives (see edge cases).
- `server/src/db/database.ts` — `openDatabase(dbPath?)`. Do **not** change its `dbPath || ":memory:"` fallback; tests depend on the no-arg in-memory behavior.
- `server/src/app.ts` — `createApp(db?)`. Do **not** change its signature or default; `health.test.ts` relies on the no-arg in-memory path.
- `server/test/database.test.ts` (new) — file-persistence regression test.
- `.gitignore` — `data/` is already ignored; no change needed.

## Implementation approach

1. Resolve `env.databasePath` to a stable absolute path. The resolved path must be anchored at the **repo root**, not `process.cwd()`: `pnpm -r dev` runs each package's script with the package dir as cwd (`server/`), so a raw `./data/headless-monkey.db` would otherwise resolve to `server/data/...`. Anchor with `path.resolve` against the repo root using the same `../../../` convention the dotenv load already uses in `env.ts` (the file sits at `src/config` or `dist/config`, both the same depth). Centralizing this in `loadAppEnv` keeps the bootstrap thin, but the implementer may resolve in `index.ts` instead — the requirement is that the final value passed to `openDatabase` is absolute and cwd-independent.
2. Ensure the database file's parent directory exists before opening. `better-sqlite3` will not create missing directories. `fs.mkdirSync(path.dirname(dbPath), { recursive: true })` before `openDatabase`.
3. In `index.ts`, open the DB (`openDatabase(dbPath)`) and pass it to `createApp(db)`. `createApp`'s `db ?? openDatabase()` fallback then only ever fires for tests that call `createApp()` with no argument.
4. Add a file-persistence regression test in `server/test/database.test.ts`:
   - Create a unique temp file path under `os.tmpdir()` (e.g. `fs.mkdtempSync`), `openDatabase(file)` it, perform a write that survives a reopen (a `SchemaService.create`, or a direct repository/SQL insert of a schema), `db.close()`, reopen `openDatabase(file)`, and assert the written data is still present.
   - This also exercises that `applyMigrations` is idempotent against an already-migrated file (it must skip applied migration names).
   - Clean up the temp directory in a `finally`/`afterAll`.
   - Use the same helper style as existing tests (`openDatabase` from `../src/db/database`).
   - Close the reopened handle before removing the temp directory: on Windows, an open SQLite connection holds its `-wal`/`-shm` siblings locked, and `fs.rmSync` on the temp dir then fails. `db.close()` on the reopened handle first, then clean up.

## Edge cases

- **cwd is `server/` during dev**: the path must not depend on `process.cwd()` (see step 1). The `.env` value is `./data/headless-monkey.db` and is relative; the fallback default in `loadAppEnv` is also relative — both must be normalized.
- **Missing parent directory**: `data/` exists in the repo but is empty and gitignored; the `mkdirSync(recursive)` guard makes boot robust regardless.
- **WAL mode**: `openDatabase` sets `journal_mode = WAL`, which produces sibling `-wal`/`-shm` files next to the db file. They live under `data/` and are covered by the existing ignore rule; nothing to change.
- **Do not break the in-memory test path**: every existing `openDatabase()` no-arg call (8 direct calls across the server test files) and `createApp()` no-arg calls (`server/test/health.test.ts`) must keep working untouched. The fix must live in the bootstrap, not in the default behaviors.

## Acceptance criteria

1. A file-persistence test exists in `server/test/database.test.ts` that writes data to a temp file DB, closes it, reopens the same path, and asserts the data survived. `pnpm --filter server test` passes (the full server suite, including this new test).
2. `server/src/index.ts` opens a database from the configured path and passes it to `createApp` — verifiable by inspecting that `index.ts` constructs the database from the env-derived path and passes it as `createApp`'s argument. The final value passed to `openDatabase` must be absolute and repo-root-anchored (not `process.cwd()`), wherever the implementer chose to place the path resolution (`env.ts` or `index.ts`), with a `mkdirSync(recursive)` guard on the parent directory.
3. The in-memory test path is preserved: the `openDatabase` no-arg fallback (`dbPath || ":memory:"`) and `createApp`'s `db ?? openDatabase()` default are unchanged. This is a distinct invariant from criterion 1's suite pass — it can fail independently (e.g. an implementer who tightened the `||` to `??`, or threaded the path through `createApp`'s default, would break the documented behavior while the suite stays green).
4. **Manual (cannot be verified by tests):** start the dev server (`pnpm dev`), log in as `admin`, create a schema, stop the server, restart it, and confirm the schema still exists. The file `data/headless-monkey.db` should exist on disk after the first run. The implementer satisfies this by reasoning through the code path and describing what to check by hand; a browser run is not required to mark the plan successful.
