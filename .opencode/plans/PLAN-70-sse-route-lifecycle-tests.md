# Test the SSE Route Connection-Lifecycle Wiring

## Goal

The `EventsEmitter`'s `unsubscribe` is unit-tested in isolation, but the **route's** wiring of it is untested. In `createEventsRouter` (the `GET /` handler), two pieces of lifecycle logic have no test coverage:

1. `req.on("close", ...)` → `unsubscribe()` + `clearTimeout(expiryTimer)` + `res.end()`. If a regression drops the `unsubscribe()` call, every disconnected SSE client leaves a **zombie listener** in the emitter's all-listener set — unbounded growth, one per leaked client, each invoked on every subsequent `emit`.
2. The token-expiry timer (`setTimeout` keyed off `req.user.exp`) that ends the stream so the client reconnects and gets bounced to login. If it is never cleared, an 8-hour timer keeps a dead socket's response alive.

Add tests that pin this route-level wiring: destroying the socket unsubscribes the route's listener (so delivery stops), and no event reaches a destroyed stream. Optionally cover the expiry timer.

**This is a test-only plan. No production source file should be modified.**

## Files Involved

- `server/test/events.test.ts` — add a new describe block for route-level lifecycle. Reuse the existing `withServer(app, fn)` and `openStream(port, token, events)` helpers already in this file.

## Implementation Approach

The obstacle: the emitter is constructed **inside** `createApp` and not exposed, so the full-app tests in this file cannot observe whether a disconnected client's listener was actually removed. To test the route wiring directly, build a minimal app around **your own** `EventsEmitter` instance so the test holds a handle to it.

1. **New describe block** (e.g. `GET /api/events — connection lifecycle`). In each test:
   - `const emitter = new EventsEmitter()`.
   - **Wrap `subscribe` on that instance** (do **not** change the `EventsEmitter` class or add a public count API). The wrapper must do two things so the test can observe what the route does with the emitter:
     - **Count real deliveries.** Wrap the listener the route registers so the test increments a counter *each time the emitter actually invokes it* (increment before delegating to the original listener). This is the key observable: it counts invocations regardless of the route's internal `res.writableEnded` guard, which would otherwise mask a zombie listener (see Edge Case 4).
     - **Flag the unsubscribe.** Capture the function `subscribe` returns and set a flag when it is invoked.
   - Build a minimal express app mirroring `app.ts`'s wiring for this route: `app.use(express.json())`, then `app.use("/api/events", requireAuth, createEventsRouter(emitter))`.
   - Sign a valid editor JWT (reuse the file's `editorToken()` pattern).

2. **Test A — disconnect unsubscribes (the zombie-listener guard).** Open the stream via `openStream` (inside `withServer`); wait for the response. Emit one event directly on the emitter (`emitter.emit(...)`) and poll until the delivery counter reaches 1 — this proves the route's listener is registered and delivery works. Then destroy the client request (`req.destroy()`) to simulate a client disconnect. Poll until the unsubscribe flag is set, and assert it — this confirms the route's `req` "close" handler actually called `unsubscribe()`.

3. **Test B — no event reaches a destroyed stream.** Continuing from A's state (after destroy + confirmed unsubscribe), emit a second event on the emitter and assert the delivery counter is **unchanged** (still 1). If the listener had not been unsubscribed, the emitter would invoke it again (counter → 2) and the test fails. This is what makes the test catch the real regression rather than merely asserting `emit` doesn't throw.

   (A and B share setup; they may be one test or two. The two assertions — "unsubscribe was called" and "no further delivery" — must both be present.)

4. **Test C (optional) — expiry timer ends the stream.** Sign a token that is valid now but expires in a few seconds (the route computes the delay as `Math.max(0, exp * 1000 - Date.now())`). Open the stream and assert the server ends the response when the timer fires (the client observes the stream end). This is inherently timing-based — keep the expiry short and the assertion tolerant. Include only if it proves stable; it is explicitly optional.

## Edge Cases

1. **`requireAuth` must precede `createEventsRouter`** in the minimal app. The route reads `(req as AuthRequest).user.exp`; without `requireAuth` running first, `req.user` is undefined and reading `.exp` throws.
2. **The client must be a raw `http.get` with an `Authorization` header** (EventSource cannot set headers) — the existing `openStream` helper already does this; reuse it. `openStream` resolves before the response arrives, so wait for the response (as existing tests do) before interacting.
3. **`req.destroy()` triggers the server-side `req` "close" asynchronously.** Poll for the unsubscribe flag / counter change rather than asserting synchronously in the same tick; give it a bounded timeout so a broken build fails the test instead of hanging.
4. **Why count invocations instead of asserting "emit doesn't throw":** the route's `send` closure guards with `if (res.writableEnded) return;`. After a disconnect the response is ended, so even a *zombie* listener would be a silent no-op — an "emit doesn't throw" assertion passes even when the listener was never removed. Counting how many times the emitter actually invokes the route's listener is the only observable that distinguishes "unsubscribed" from "zombie."
5. **Keep the existing tests green and unmodified.** This plan adds coverage; it does not change emitter or route behavior.

## Acceptance Criteria

1. **Route lifecycle is tested and green.** `cd server && npx vitest run` exits 0 with a new describe block in `events.test.ts` that wires `requireAuth` + `createEventsRouter(ownEmitter)` on a minimal app and confirms: (a) destroying the client request causes the route's close handler to invoke the emitter's unsubscribe (observed by wrapping `subscribe` on the instance); and (b) after destroy, a further `emitter.emit(...)` does **not** increase the route-listener invocation count (no delivery to the destroyed stream). All pre-existing tests pass unmodified. (An optional, timing-tolerant short-expiry test may also be present.)
2. **Test-only change.** `git diff --name-only` shows only `server/test/events.test.ts` changed (no production source file).
