import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "@/auth/AuthProvider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const { user, status, login, isLoggingIn, loginError } = useAuth();
  const navigate = useNavigate();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");

  if (status === "authenticated" && user) {
    return <Navigate to={user.role === "admin" ? "/admin" : "/schemas"} replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      const nextUser = await login(loginId, password);
      navigate(nextUser.role === "admin" ? "/admin" : "/schemas", { replace: true });
    } catch {
      // The failure is already surfaced via the loginError alert.
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6">
        <div>
          <h1 className="font-heading text-lg font-semibold">Sign in</h1>
          <p className="text-sm text-muted-foreground">Headless Monkey control panel</p>
        </div>

        {loginError && (
          <Alert variant="destructive">
            <AlertTitle>Sign in failed</AlertTitle>
            <AlertDescription>{loginError.message}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-2">
          <Label htmlFor="login">Login</Label>
          <Input id="login" autoComplete="username" value={loginId} onChange={(event) => setLoginId(event.target.value)} required />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </div>

        <Button type="submit" disabled={isLoggingIn} className="w-full">
          {isLoggingIn ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
