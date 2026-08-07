# PLAN-08: M7 — SSE realtime + conflict UX (server + client)

**Originating milestone:** M7
**Depends on:** PLAN-04 (emit from content mutations; public/content routes present), PLAN-07 (editors/pages to modify; confirm client build passes). This plan intentionally touches both packages.

## Goal

Two logged-in editors observe each other's changes live: toasts on affected views, disabled rows/banners on deletion, and dual-field render on incompatible type change — streamed over an authenticated SSE endpoint.

## Spec refs (verbatim from milestone M7)

SPEC §2 R23–R26; §4 SSE contract; §5 useRealtime/optimistic.

## Files involved

- Server: `server/src/services/events.ts` (in-memory emitter), `server/src/routes/events.ts` (SSE endpoint), emit calls in `server/src/routes/schemas.ts` + `server/src/routes/entries.ts` (or their services), `server/src/app.ts` (mount, guarded).
- Client: `client/src/hooks/useRealtime.ts`, `client/src/components/Toast.tsx`, `<Alert />` banner + disabled states in `client/src/routes/SchemasPage.tsx`, `client/src/routes/ContentPage.tsx`, `client/src/routes/SchemaEditorPage.tsx`, `client/src/routes/ContentEditorPage.tsx`.

## Approach

1. **Emitter:** `events.ts` — an in-memory emitter keyed by schema name, holding per-client subscriptions. Emits event objects per SPEC §4: `{ type, schema, entryId?, version?, compatVersion?, by, changes? }` where `changes` items are `{ kind: 'renamed'|'added'|'deleted'|'typeChanged'|'requiredChanged'|'reordered', fieldId?, label?, type?, required? }`.
2. **SSE endpoint:** `GET /api/events`, guarded by bearer auth. Since `EventSource` cannot set headers, the client reads this via `fetch` (Response body stream reader); the endpoint is a plain text/event-stream response. (Resolved decision #2.)
3. **Emits:** every schema create/update/delete and entry create/update/delete mutation emits the corresponding event with the mutating user as `by`. For schema updates, compute the `changes` list here — there is no precomputed diff; build it by comparing old vs. new id-stable fields (per-kind: renamed, added, deleted, typeChanged, requiredChanged, reordered).
4. **Client hook:** `useRealtime` opens the stream with the Bearer header, filters events to the schema(s) currently on screen, invalidates the affected TanStack queries, and exposes the events to the view layer. Handle reconnection and treat a mid-stream 401 as "logged out".
5. **Toasts (R26):** a change by another user that affects the current view produces a toast (`Toast` component over the shadcn toast primitive; SPEC §5 roles — notification = `<Toast />`, banner = `<Alert />`, confirmation = `<AlertDialog />`).
6. **Transient states:**
   - `schema.deleted` → open schema editor and entry editor render disabled with an `<Alert />` banner; the row in schema/content listings is disabled and non-interactable (R24).
   - `schema.updated` with a `typeChanged` to an incompatible type while an entry of that schema is open → old field disabled with the new field below it (R25), pre-filled when the old value coerces losslessly (`number`→`text`, resolved decision #4).

## Edge cases

- The SSE stream is authenticated: only valid bearer tokens get events; token expiry mid-stream closes it (client drops to login).
- Events for schemas NOT on screen must not toast — filter server-side by subscription or client-side by visible schema.
- A change must not toast the user who made it — drop events where `by` equals the current user (R26 is only about *other* users' changes).
- The fetch-based SSE stream is the one sanctioned exception to the "raw `fetch` inside `useEffect` is forbidden" rule (SPEC §6 prescribes `useRealtime` doing exactly this); note it in a comment at the hook.
- Reconnect after a dropped connection must re-sync (re-fetch current data) rather than trusting missed events.
- Deleting a schema emits once; all views open on it (list, editor) react with disabled states — including views that had not toggled yet.
- Emitting must happen after the DB write succeeds, not before, so the event payload always reflects persisted state.

## Acceptance criteria

1. `pnpm --filter server test` passes and `pnpm --filter client build` passes.
2. Server test: calling `GET /api/events` without a token → 401 (R4 applies to it).
3. Two-browser manual: A creates a schema → B sees a toast and the list updates without a manual refresh (R26, R23).
4. Two-browser manual: A deletes the schema → B's open schema/entry editor is disabled with an `<Alert />` banner and the listing rows are disabled (R24).
5. Two-browser manual: A changes a field to an incompatible type → B's open entry for that schema shows the old field disabled and the new field below, pre-filled when the value coerces losslessly (R25).

Milestone M7 verify gate (preserved): `pnpm --filter server test` and `pnpm --filter client build` pass; two-browser manual: A creates a schema → B sees toast + list update; A deletes the schema → B's open editor disabled + `<Alert />` banner; A changes a field type → B's open entry shows the dual-field editor.
