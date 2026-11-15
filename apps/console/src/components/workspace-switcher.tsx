import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, ApiRequestError } from "@/lib/api";
import { useMe } from "@/lib/auth";

/** Header workspace name; in Supabase mode a switcher (every query refetches for the new workspace). */
export function WorkspaceSwitcher() {
  const me = useMe();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const current = me.data?.workspace;
  if (!me.data || me.data.mode === "local") return <span className="text-sm text-muted-foreground">Default workspace</span>;

  async function select(id: string) {
    setBusy(true);
    try {
      await api(`/v1/x/workspaces/${id}/select`, { method: "POST", json: {} });
      await qc.resetQueries();
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const name = window.prompt("Name the new workspace");
    if (!name?.trim()) return;
    try {
      await api("/v1/x/workspaces", { method: "POST", json: { name: name.trim() } });
      await qc.resetQueries();
      toast.success(`Created ${name.trim()}`);
    } catch (e) {
      toast.error(e instanceof ApiRequestError ? e.message : "Could not create the workspace.");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-2" disabled={busy}>
          <span className="max-w-48 truncate">{current?.name ?? "No workspace"}</span>
          {current && <Badge variant="outline" className="capitalize">{current.role}</Badge>}
          <ChevronsUpDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {me.data.workspaces.map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => w.id !== current?.id && void select(w.id)}>
            <span className="truncate">{w.name}</span>
            <span className="ml-auto flex items-center gap-2 text-xs capitalize text-muted-foreground">
              {w.role}
              {w.id === current?.id && <Check className="size-3.5" />}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void create()}><Plus /> New workspace</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
