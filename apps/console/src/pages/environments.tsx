import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, Plus } from "lucide-react";
import type { Environment, Page } from "@agentos/types";
import { PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiRequestError, timeAgo } from "@/lib/api";

export function useEnvironments() {
  return useQuery({ queryKey: ["environments"], queryFn: () => api<Page<Environment>>("/v1/environments?limit=100") });
}

export function EnvironmentsPage() {
  const envs = useEnvironments();
  return (
    <>
      <PageHeader
        title="Environments"
        description="Sandbox templates for sessions. Locally every session gets its own Docker container."
        actions={<CreateEnvironmentDialog />}
      />
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Hosting</TableHead>
              <TableHead>Networking</TableHead>
              <TableHead>Packages</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {envs.data?.data.length === 0 && (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No environments yet.</TableCell></TableRow>
            )}
            {envs.data?.data.map((e) => {
              const pk = Object.entries(e.config.packages ?? {}).flatMap(([k, v]) => (v ?? []).map((p) => `${k}:${p}`));
              const net = e.config.networking;
              return (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs">{e.id}</TableCell>
                  <TableCell className="font-medium">{e.name}</TableCell>
                  <TableCell><Badge variant="secondary">{e.config.type === "local" ? "Local Docker" : "Cloud (runs locally)"}</Badge></TableCell>
                  <TableCell className="text-sm">
                    {net?.type === "limited" ? (
                      <span className="inline-flex items-center gap-1"><Lock className="size-3.5" /> Limited{net.allowed_hosts?.length ? ` · ${net.allowed_hosts.length} hosts` : ""}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1"><Globe className="size-3.5" /> Unrestricted</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-56 truncate font-mono text-xs text-muted-foreground">{pk.join(", ") || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{timeAgo(e.updated_at)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function CreateEnvironmentDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [limited, setLimited] = useState(false);
  const [pkgMgrs, setPkgMgrs] = useState(true);
  const [hosts, setHosts] = useState("");
  const [pip, setPip] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<Environment>("/v1/environments", {
        method: "POST",
        json: {
          name,
          config: {
            type: "local",
            networking: limited
              ? { type: "limited", allow_package_managers: pkgMgrs, allowed_hosts: hosts.split("\n").map((h) => h.trim()).filter(Boolean) }
              : { type: "unrestricted" },
            packages: pip.trim() ? { pip: pip.split(/[\s,]+/).filter(Boolean) } : undefined,
          },
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["environments"] });
      setOpen(false);
      setName("");
    },
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : "Could not create the environment."),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the environment a name.");
    if (hosts.split("\n").filter((h) => h.trim()).length > 16) return setError("At most 16 allowed hosts.");
    setError(null);
    create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus /> Create environment</Button></DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create environment</DialogTitle>
            <DialogDescription>A reusable sandbox template. Each session gets its own container from it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="env-name">Name</Label>
            <Input id="env-name" placeholder="data-analysis" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">Limited networking</div>
              <div className="text-xs text-muted-foreground">Off: the sandbox can reach the internet. On: only the hosts you list.</div>
            </div>
            <Switch checked={limited} onCheckedChange={setLimited} />
          </div>
          {limited && (
            <div className="grid gap-3 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="pkg">Allow package managers</Label>
                <Switch id="pkg" checked={pkgMgrs} onCheckedChange={setPkgMgrs} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="hosts">Allowed hosts (one per line, max 16)</Label>
                <Textarea id="hosts" rows={3} placeholder={"api.example.com\n*.internal.example.com"} value={hosts} onChange={(e) => setHosts(e.target.value)} />
                <p className="text-xs text-muted-foreground">
                  All traffic goes through the AgentOS egress proxy: only these hosts (and package registries, if allowed) are reachable;
                  everything else is blocked. With no hosts and no package managers the sandbox has no network.
                </p>
              </div>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="pip">Python packages (optional)</Label>
            <Input id="pip" placeholder="pandas requests" value={pip} onChange={(e) => setPip(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create environment"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
