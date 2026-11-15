import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { api } from "./api";

export interface Workspace {
  id: string;
  name: string;
  role: "admin" | "developer" | "viewer";
}

export interface Me {
  mode: "local" | "supabase";
  username: string;
  actor: { type: string; id: string; role: Workspace["role"]; workspace_id: string | null; email?: string };
  workspace: Workspace | null;
  workspaces: Workspace[];
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/v1/x/auth/me"),
    retry: false,
    staleTime: 60_000,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return async () => {
    await api("/v1/x/auth/logout", { method: "POST" });
    qc.clear();
    window.location.href = "/login";
  };
}

/** Route guard: every Console page except /login needs the admin session. */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isLoading) return <div className="grid h-screen place-items-center text-sm text-muted-foreground">Loading…</div>;
  if (me.isError) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
