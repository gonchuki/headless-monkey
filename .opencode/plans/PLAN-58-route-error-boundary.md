# PLAN-58 — Add error boundaries for route-level crashes

**Goal:** Prevent a render crash in any route from taking down the entire application. Add a React error boundary that catches route-level errors and shows a recovery UI.

**Depends on:** none.

## Files

- `client/src/components/ErrorBoundary.tsx` — new component
- `client/src/main.tsx` — add `errorElement` to route config

## Steps

1. Create `client/src/components/ErrorBoundary.tsx` as a class component implementing `getDerivedStateFromError` + `componentDidCatch`. The component:
   - Renders a recovery UI with the error message, a "Try again" button (calls `this.setState` to reset error state + `window.location.reload()`), and a "Go home" link (`<a href="/schemas">`).
   - Uses Tailwind classes consistent with the existing design system (`text-foreground`, `bg-background`, `border`, `rounded-lg`, `p-6`).
   - Follows the one-component-per-file convention.

2. In `client/src/main.tsx`, add `errorElement: <ErrorBoundary />` to the layout route (the one with `element: <AppLayout />`). This catches errors from all child routes. Optionally add `errorElement` to individual routes for more granular recovery, but the layout-level boundary is sufficient.

3. The `ErrorBoundary` should be a simple class component (React error boundaries require class components or a wrapper). Do not add a third-party library.

## Edge cases

- Error in `AppLayout` itself (e.g. `useAuth` throws) — the layout-level `errorElement` catches this since React Router renders `errorElement` as a sibling to the layout, not inside it.
- Error in `LoginPage` (outside the layout) — not caught by the layout-level boundary. Add `errorElement` to the `/login` route as well for completeness.
- Error boundary must not catch errors in event handlers or async code — only render-phase errors. This is inherent to `componentDidCatch` and requires no special handling.

## Acceptance criteria

1. `pnpm --filter client build` succeeds.
2. `grep -r "ErrorBoundary" client/src/` shows the component is used in route config.
3. Manually trigger a render error (e.g. temporarily throw in a component) — the app shows the recovery UI instead of a white screen, and the "Try again" button reloads the page.
