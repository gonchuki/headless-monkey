import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Key, Plus, Trash } from "@phosphor-icons/react";
import { apiFetch, type UserListItem } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { Skeleton } from "@/components/shared/Skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const usersQuery = useQuery({
    queryKey: queryKeys.users(),
    queryFn: () => apiFetch<UserListItem[]>("/api/users"),
  });

  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [passwordTarget, setPasswordTarget] = useState<{ id: number; login: string } | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [userToDelete, setUserToDelete] = useState<UserListItem | null>(null);

  const createMutation = useMutation({
    mutationFn: (vars: { login: string; password: string }) =>
      apiFetch<{ id: number; login: string }>("/api/users", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.users() });
      const previous = queryClient.getQueryData<UserListItem[]>(queryKeys.users());
      queryClient.setQueryData<UserListItem[]>(queryKeys.users(), (old) => [
        ...(old ?? []),
        { id: -Date.now(), login: vars.login, disabled: false },
      ]);
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.users(), context.previous);
      }
      toast.add({ type: "error", title: "Failed to create editor", description: errorMessage(error) });
    },
    onSuccess: () => {
      toast.add({ type: "success", title: "Editor created" });
      setLogin("");
      setPassword("");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.users() }),
  });

  const toggleMutation = useMutation({
    mutationFn: (vars: { id: number; disabled: boolean }) =>
      apiFetch<{ id: number; login: string; disabled: boolean }>(`/api/users/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: vars.disabled }),
      }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.users() });
      const previous = queryClient.getQueryData<UserListItem[]>(queryKeys.users());
      queryClient.setQueryData<UserListItem[]>(queryKeys.users(), (old) =>
        (old ?? []).map((item) => (item.id === vars.id ? { ...item, disabled: vars.disabled } : item)),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.users(), context.previous);
      }
      toast.add({ type: "error", title: "Failed to update editor", description: errorMessage(error) });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.users() }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch<void>(`/api/users/${id}`, { method: "DELETE" }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.users() });
      const previous = queryClient.getQueryData<UserListItem[]>(queryKeys.users());
      queryClient.setQueryData<UserListItem[]>(queryKeys.users(), (old) =>
        (old ?? []).filter((item) => item.id !== id),
      );
      return { previous };
    },
    onError: (error, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.users(), context.previous);
      }
      toast.add({ type: "error", title: "Failed to delete editor", description: errorMessage(error) });
    },
    onSuccess: () => toast.add({ type: "success", title: "Editor deleted" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.users() }),
  });

  const passwordMutation = useMutation({
    mutationFn: (vars: { id: number; password: string }) =>
      apiFetch<{ id: number; login: string; disabled: boolean }>(`/api/users/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ password: vars.password }),
      }),
    onSuccess: () => {
      toast.add({ type: "success", title: "Password updated" });
      setPasswordTarget(null);
      setNewPassword("");
    },
    onError: (error) => {
      toast.add({ type: "error", title: "Failed to update password", description: errorMessage(error) });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.users() }),
  });

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    createMutation.mutate({ login, password });
  }

  function handlePasswordChange(event: FormEvent) {
    event.preventDefault();
    if (passwordTarget && newPassword) {
      passwordMutation.mutate({ id: passwordTarget.id, password: newPassword });
    }
  }

  function openPasswordEditor(user: { id: number; login: string }) {
    setNewPassword("");
    setPasswordTarget(user);
  }

  function closePasswordEditor() {
    setNewPassword("");
    setPasswordTarget(null);
  }

  const users = usersQuery.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-heading text-xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">Manage editors. Admin login is configured via the server environment.</p>
      </div>

      <form onSubmit={handleCreate} className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="new-login">Login</Label>
          <Input id="new-login" autoComplete="off" value={login} onChange={(event) => setLogin(event.target.value)} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-password">Password</Label>
          <Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </div>
        <Button type="submit" disabled={createMutation.isPending}>
          <Plus className="size-4" aria-hidden="true" />
          Create editor
        </Button>
      </form>

      {usersQuery.isPending && (
        <ul className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index}>
              <Skeleton className="h-10 w-full" />
            </li>
          ))}
        </ul>
      )}

      {usersQuery.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load users</AlertTitle>
          <AlertDescription>{errorMessage(usersQuery.error) ?? "Unknown error"}</AlertDescription>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => usersQuery.refetch()}>
            Retry
          </Button>
        </Alert>
      )}

      {usersQuery.isSuccess && users.length === 0 && (
        <Alert>
          <AlertTitle>No editors yet</AlertTitle>
          <AlertDescription>Create the first editor above.</AlertDescription>
        </Alert>
      )}

      {usersQuery.isSuccess && users.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {users.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{item.login}</p>
                <p className="text-xs text-muted-foreground">{item.disabled ? "Disabled" : "Active"}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={toggleMutation.isPending}
                  onClick={() => toggleMutation.mutate({ id: item.id, disabled: !item.disabled })}
                >
                  {item.disabled ? "Enable" : "Disable"}
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Change password for ${item.login}`} onClick={() => openPasswordEditor(item)}>
                  <Key className="size-4" aria-hidden="true" />
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${item.login}`} onClick={() => setUserToDelete(item)}>
                  <Trash className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={userToDelete != null} onOpenChange={(open) => !open && setUserToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete editor?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <span className="font-medium text-foreground">{userToDelete?.login}</span>? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (userToDelete) {
                  deleteMutation.mutate(userToDelete.id);
                }
                setUserToDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={passwordTarget != null} onOpenChange={(open) => !open && closePasswordEditor()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              Set a new password for <span className="font-medium text-foreground">{passwordTarget?.login}</span>.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handlePasswordChange} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-password">New password</Label>
              <Input
                id="edit-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closePasswordEditor}>
                Cancel
              </Button>
              <Button type="submit" disabled={passwordMutation.isPending || newPassword.length === 0}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
