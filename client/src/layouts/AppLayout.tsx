import { Navigate, Outlet } from "react-router";
import { useAuth } from "@/auth/AuthProvider";
import { Nav } from "@/components/Nav";
import { PageSkeleton } from "@/components/shared/PageSkeleton";
import { Toaster } from "@/components/ui/toast";

export default function AppLayout() {
  const { user, status } = useAuth();

  if (status === "loading") {
    return <PageSkeleton />;
  }

  if (status === "unauthenticated" || !user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex min-h-svh">
      <Nav />
      <main className="flex-1 p-6">
        <Outlet />
      </main>
      <Toaster />
    </div>
  );
}
