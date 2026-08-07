import { NavLink } from "react-router";
import { FileText, SignOut, TreeStructure, UsersThree } from "@phosphor-icons/react";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const navItems = {
  admin: [{ to: "/admin", label: "Users", icon: UsersThree }],
  editor: [
    { to: "/schemas", label: "Schemas", icon: TreeStructure },
    { to: "/content", label: "Content", icon: FileText },
  ],
} as const;

export function Nav() {
  const { user, logout } = useAuth();
  if (!user) {
    return null;
  }

  const items = navItems[user.role] ?? [];

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r bg-muted/30 p-3">
      <div className="mb-4 px-2 font-heading text-sm font-semibold">Headless Monkey</div>
      <ul className="flex flex-col gap-1">
        {items.map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <NavLink
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                  isActive && "bg-accent text-accent-foreground",
                )
              }
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="flex-1" />
      <div className="mb-2 px-2 text-xs text-muted-foreground">
        {user.login} · {user.role}
      </div>
      <Button variant="ghost" size="sm" type="button" onClick={logout} className="justify-start">
        <SignOut className="size-4" aria-hidden="true" />
        Sign out
      </Button>
    </nav>
  );
}
