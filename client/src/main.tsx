import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { AuthProvider } from "@/auth/AuthProvider";
import { RequireRole } from "@/auth/RequireRole";
import { isUnauthorizedError, notifyUnauthorized } from "@/lib/api";
import AppLayout from "@/layouts/AppLayout";
import LoginPage from "@/routes/LoginPage";
import AdminUsersPage from "@/routes/AdminUsersPage";
import SchemaEditorPage from "@/routes/SchemaEditorPage";
import SchemasPage from "@/routes/SchemasPage";
import PlaceholderPage from "@/routes/PlaceholderPage";
import "@/index.css";

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <AppLayout />,
    children: [
      { path: "/", element: <Navigate to="/schemas" replace /> },
      {
        path: "/admin",
        element: (
          <RequireRole role="admin">
            <AdminUsersPage />
          </RequireRole>
        ),
      },
      {
        path: "/schemas",
        element: (
          <RequireRole role="editor">
            <SchemasPage />
          </RequireRole>
        ),
      },
      {
        path: "/schemas/:name",
        element: (
          <RequireRole role="editor">
            <SchemaEditorPage />
          </RequireRole>
        ),
      },
      {
        path: "/content",
        element: (
          <RequireRole role="editor">
            <PlaceholderPage title="Content" />
          </RequireRole>
        ),
      },
      {
        path: "/content/new",
        element: (
          <RequireRole role="editor">
            <PlaceholderPage title="New content" />
          </RequireRole>
        ),
      },
      {
        path: "/content/:schema/:id",
        element: (
          <RequireRole role="editor">
            <PlaceholderPage title="Content editor" />
          </RequireRole>
        ),
      },
    ],
  },
  { path: "*", element: <Navigate to="/login" replace /> },
]);

function handleUnauthorized(error: unknown, skip = false): void {
  if (skip) return;
  if (isUnauthorizedError(error)) {
    notifyUnauthorized();
    if (router.state.location.pathname !== "/login") {
      void router.navigate("/login", { replace: true });
    }
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => handleUnauthorized(error),
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => handleUnauthorized(error, Boolean(mutation.meta?.skipAuthRedirect)),
  }),
});

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
