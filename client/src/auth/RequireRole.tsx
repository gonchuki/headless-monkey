import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAuth } from "@/auth/AuthProvider";
import { PageSkeleton } from "@/components/PageSkeleton";

export function RequireRole({ role, children }: { role: "admin" | "editor"; children: ReactNode }) {
  const { user, status } = useAuth();

  if (status === "loading") {
    return <PageSkeleton />;
  }

  if (status === "unauthenticated" || !user) {
    return <Navigate to="/login" replace />;
  }

  if (user.role !== role) {
    return <Navigate to={user.role === "admin" ? "/admin" : "/schemas"} replace />;
  }

  return children;
}
