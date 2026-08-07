import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  apiFetch,
  AUTH_UNAUTHORIZED_EVENT,
  clearStoredToken,
  getStoredToken,
  setStoredToken,
  type AuthUser,
} from "@/lib/api";
import { queryKeys } from "@/lib/query";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  token: string | null;
  login: (login: string, password: string) => Promise<AuthUser>;
  isLoggingIn: boolean;
  loginError: Error | null;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(() => getStoredToken());

  useEffect(() => {
    const handleUnauthorized = () => setToken(null);
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
  }, []);

  const meQuery = useQuery({
    queryKey: queryKeys.me(token),
    queryFn: () => apiFetch<AuthUser>("/api/auth/me"),
    enabled: token != null,
    retry: false,
    staleTime: Infinity,
  });

  const loginMutation = useMutation({
    mutationFn: async (credentials: { login: string; password: string }) => {
      const { token: nextToken } = await apiFetch<{ token: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(credentials),
      });
      setStoredToken(nextToken);
      setToken(nextToken);
      return apiFetch<AuthUser>("/api/auth/me");
    },
    meta: { skipAuthRedirect: true },
  });

  const logoutMutation = useMutation({
    mutationFn: () => apiFetch<void>("/api/auth/logout", { method: "POST" }),
  });

  const login = useCallback(
    (loginId: string, password: string) => loginMutation.mutateAsync({ login: loginId, password }),
    [loginMutation],
  );

  const logout = useCallback(() => {
    logoutMutation.mutate(undefined, {
      onSettled: () => {
        clearStoredToken();
        setToken(null);
        queryClient.clear();
      },
    });
  }, [logoutMutation, queryClient]);

  const user = meQuery.data ?? null;

  const status: AuthStatus = useMemo(() => {
    if (token == null) return "unauthenticated";
    if (meQuery.isPending) return "loading";
    if (meQuery.isSuccess) return "authenticated";
    return "unauthenticated";
  }, [token, meQuery.isPending, meQuery.isSuccess]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      token,
      login,
      isLoggingIn: loginMutation.isPending,
      loginError: loginMutation.error,
      logout,
    }),
    [user, status, token, login, loginMutation.isPending, loginMutation.error, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
