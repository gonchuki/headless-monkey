# PLAN-63 — Stand up the client test harness with first suites

## Goal

`client/` has zero tests and no test script (`package.json` scripts are only `dev`/`build`/`typecheck`), while `server/` already runs vitest. Stand up the same harness in `client/` and write first suites covering the pure/logic units where the all-schemas pagination bug lived:

- cursor decode/compare: `client/src/lib/cursor.ts` (`decodeCursor`, `compareCursors`, `compareRawCursors`)
- entry value derivation / conflict coercion: `client/src/lib/entries.ts` (`isValidDateString`, `isValueValidForField`, `isStoredValueAffected`, `coerceStoredValue`, `deriveInitialValues`, `schemaLabelField`, `entryLabel`)
- cross-schema cursor merging: currently inlined inside the `useAllEntries` hook (`client/src/hooks/useAllEntries.ts`) — extract it as a pure function, then test that.

This harness is a prerequisite for PLAN-64's rewrite of `useAllEntries`.

## Files

- `client/package.json` — add devDependency `vitest` (match the server's version, `^4.1.10`); add script `"test": "vitest run"`.
- `client/vitest.config.mts` — new; modeled on `server/vitest.config.mts` (`test.environment: "node"`, `test.include: ["test/**/*.test.ts"]`). It must **also** define the `@` → `./src` resolve alias: vitest prefers `vitest.config.mts` over `vite.config.ts`, so the alias in `vite.config.ts` is not inherited, and src modules import each other via `@/…`. Do not load `vite.config.ts` in tests (it pulls in the react/tailwind plugins and reads the root `.env` for the dev proxy — neither is needed for pure units).
- `client/test/cursor.test.ts`, `client/test/entries.test.ts`, `client/test/allEntriesMerge.test.ts` — new suites (test file names may vary; one file per unit above, under `client/test/`).
- A new pure module under `client/src/lib/` (e.g. `allEntriesMerge.ts`) holding the extracted merge.
- `client/src/hooks/useAllEntries.ts` — delegate to the extracted function.

## Approach (ordered)

1. **Harness.** Add the devDependency, script, and config. Verify discovery with a trivially-passing probe test, then replace the probe with the real suites. Tests live in `client/test/` (not `src/`), following the server's convention (`server/test/`). Note `client/tsconfig.json` keeps `include: ["src"]`, so tests are not type-checked by `pnpm --filter client typecheck` — same as the server; vitest transpiles them. Do not widen the tsconfig include for this.
2. **Extract the merge (behavior-preserving).** Move the merge currently inlined in `useAllEntries` into a pure exported function, e.g. `mergeAllEntriesPages(pages, paginated) → { data, pagination }`, where `pages` is the per-schema query data (entries plus optional pagination block). Move the logic verbatim: flat-map entries, sort by `last_modified_date` descending; `nextCursor` = the minimum across schemas under `compareRawCursors` with the current null-reset rule; `prevCursor` = the maximum with the same rule. The hook maps its `useQueries` results onto the function. **Do not change any behavior in this step.** The null-reset rule (any schema with `nextCursor == null` resets the merged cursor to `null`) is a known bug that PLAN-64 fixes; pin it as-is here so PLAN-64's diff is auditable. Do not "fix" it in this plan.
3. **cursor.ts suite.** Cover at minimum:
   - `decodeCursor`: a valid base64url-encoded `{v, i}` JSON cursor (string `v`, number `v`, and `null` `v`); the legacy bare-positive-integer path (`"42"` → `{value: 42, id: 42}`); `null`/`undefined`/`""` → `null`; garbage strings → `null`; JSON that parses to an array or non-object → `null`; `i` that is not a safe integer or is `< 1` → `null`; a cursor whose `v` is of an unexpected type (e.g. boolean) → `null`.
   - `compareCursors`: both values null → id decides; one null → the non-null side is smaller (NULLs sort last); numbers vs numbers, strings vs strings; number vs string → the number side is smaller; equal values → id ascending.
   - `compareRawCursors`: returns `null` when either side is undecodable; otherwise delegates to the decoded comparison.
4. **entries.ts suite.** Cover at minimum:
   - `isValidDateString`: well-formed dates; rejects malformed shapes; rejects impossible calendar dates (e.g. `2024-02-30`) — the function round-trips through `Date`, so a regex-only intuition is wrong.
   - `isValueValidForField`: each field type (`text` with the required-non-empty rule, `number` finite, `boolean`, `date`, `schema-ref` positive integer), plus unknown-type default.
   - `isStoredValueAffected`: `null` stored → affected iff `field.required`; non-null → affected iff invalid for the field.
   - `coerceStoredValue`: `text` field + number → stringified; every other case → `null`. Note it is called at runtime with `null` for a missing stored value on a conflicted required field and safely returns `null` — pin that.
   - `deriveInitialValues`: non-conflict entry passes stored values through untouched (including values that are invalid for the field — the editor surfaces those, derivation does not fix them); conflict entry coerces exactly the affected fields and leaves the rest; missing stored value under conflict+required → `null`. Keys are `String(field.id)`.
   - `schemaLabelField` (first required field id, else first field, else `null`) and `entryLabel` (label-field value, `Entry #<id>` fallback, empty-string value falls through).
5. **Merge suite.** Pin the current contract of the extracted function: concatenation + `last_modified_date`-descending order across schemas; `nextCursor` = min under `compareRawCursors` when all schemas have one, and **`null` when any schema's is `null`** (the known flaw — pin it, label it as such in a test name); `prevCursor` symmetric; the non-paginated mode (`paginated = false`) returns flat entries and an all-null pagination.

## Edge cases (found while exploring)

- `vitest.config.mts` outranks `vite.config.ts`: without the alias defined in the vitest config, every `@/…` import in tests fails to resolve. This is the most likely first failure.
- `cursor.ts` relies on `atob` and `TextDecoder`, which are Node globals — the `node` test environment suffices. No jsdom, no testing-library: all units here are pure. Do not add either.
- `decodeCursor`'s legacy path accepts only bare positive integers: `"0"`, `"1.5"`, `"-3"` all → `null`.
- `compareCursors` places NULL sort values **last** in both directions and numbers before strings — this ordering is what the merge's min/max relies on.
- The extraction must keep `useAllEntries`'s public shape (`data`, `isPending`, `isError`, `isSuccess`, `error`, `refetch`, `pagination`) intact; `ContentPage` consumes it and PLAN-64 builds on it.

## Acceptance criteria

1. `pnpm --filter client test` exits 0, and the vitest output shows at least one passing test from each of the three new test files (cursor, entries, merge).
2. `pnpm --filter client typecheck` exits 0.
3. `pnpm -r test` exits 0 (the server suites remain green; the root script fans out to both packages).
4. The hook delegates rather than duplicates: `grep -n "compareRawCursors" client/src/hooks/useAllEntries.ts` returns no matches (the comparison now lives only in the extracted module and `cursor.ts`).
