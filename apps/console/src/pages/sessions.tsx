import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { Page, Session } from "@agentos/types";
import { PageHeader } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiRequestError, timeAgo } from "@/lib/api";
import { useAgents } from "./agents";
import { useEnvironments } from "./environments";
import { formatBytes, useFiles } from "./files";
import { useVaults } from "./vaults";
import { StatusBadge, formatTokens, formatUsd } from "./session-parts";

export function useSessions(agentId?: string) {
  return useQuery({
    queryKey: ["sessions", agentId ?? "all"],
    queryFn: () => api<Page<Session>>(`/v1/sessions?limit=100${agentId ? `&agent_id=${agentId}` : ""}`),
    refetchInterval: 5000,
  });
}

export function SessionsTable({ agentId }: { agentId?: string }) {
  const sessions = useSessions(agentId);
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Tokens in / out</TableHead>
            <TableHead>Runs on</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.isLoading && <TableRow><TableCell colSpan={8} className="text-muted-foreground">Loading…</TableCell></TableRow>}
          {sessions.data?.data.length === 0 && (
            <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No sessions yet.</TableCell></TableRow>
          )}
          {sessions.data?.data.map((s) => {
            const inTok = s.usage.input_tokens + s.usage.cache_read_input_tokens + s.usage.cache_creation_input_tokens;
            return (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs"><Link to={`/sessions/${s.id}`} className="hover:underline">{s.id}</Link></TableCell>
                <TableCell className="max-w-48 truncate">{s.title ?? <span className="text-muted-foreground">Untitled</span>}</TableCell>
                <TableCell><StatusBadge session={s} /></TableCell>
                <TableCell className="max-w-40 truncate text-sm">{s.agent.name}</TableCell>
                <TableCell className="text-sm">
                  {formatUsd(s.usage.cost_usd)}
                  {s.budget && <span className="text-muted-foreground"> / {formatUsd(Number(s.budget.max_list_cost.amount) / 100)}</span>}
                </TableCell>
                <TableCell
                  className="text-sm"
                  title={`cache read ${s.usage.cache_read_input_tokens}, cache write ${s.usage.cache_creation_input_tokens}, uncached ${s.usage.input_tokens}, output ${s.usage.output_tokens}`}
                >
                  {formatTokens(inTok)} / {formatTokens(s.usage.output_tokens)}
                </TableCell>
                <TableCell className="text-sm capitalize">{s.runs_on}</TableCell>
                <TableCell className="text-muted-foreground">{timeAgo(s.created_at)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function SessionsPage() {
  return (
    <>
      <PageHeader title="Sessions" description="Trace and debug agent sessions." actions={<CreateSessionDialog />} />
      <SessionsTable />
    </>
  );
}

export function CreateSessionDialog({ agentId }: { agentId?: string }) {
  const agents = useAgents();
  const envs = useEnvironments();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState(agentId ?? "");
  const [env, setEnv] = useState("");
  const [title, setTitle] = useState("");
  const [budget, setBudget] = useState("");
  const [message, setMessage] = useState("");
  const [attached, setAttached] = useState<string[]>([]);
  const [vaultIds, setVaultIds] = useState<string[]>([]);
  const vaults = useVaults();
  const chosenAgent = agents.data?.data.find((a) => a.id === agent);
  const needsVault = (chosenAgent?.mcp_servers.length ?? 0) > 0;
  const [error, setError] = useState<string | null>(null);
  const files = useFiles();
  const uploads = (files.data?.data ?? []).filter((f) => !f.scope && f.downloadable);

  // Mount at /mnt/session/uploads/<filename>; fall back to the file id when two names clash.
  const resources = () => {
    const chosen = uploads.filter((f) => attached.includes(f.id));
    return chosen.map((f) => ({
      type: "file" as const,
      file_id: f.id,
      mount_path: chosen.filter((o) => o.filename === f.filename).length > 1 ? `/mnt/session/uploads/${f.id}` : `/mnt/session/uploads/${f.filename}`,
    }));
  };

  const create = useMutation({
    mutationFn: () =>
      api<Session>("/v1/sessions", {
        method: "POST",
        json: {
          agent,
          environment_id: env,
          title: title || undefined,
          budget: budget ? { type: "limit", max_list_cost: { amount: String(Math.round(Number(budget) * 100)), currency: "USD" } } : undefined,
          initial_events: message.trim() ? [{ type: "user.message", content: [{ type: "text", text: message }] }] : undefined,
          resources: attached.length ? resources() : undefined,
          vault_ids: vaultIds.length ? vaultIds : undefined,
        },
      }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      setOpen(false);
      navigate(`/sessions/${s.id}`);
    },
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : "Could not create the session."),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!agent) return setError("Choose an agent.");
    if (!env) return setError("Choose an environment.");
    if (budget && !(Number(budget) > 0)) return setError("Budget must be a positive dollar amount.");
    setError(null);
    create.mutate();
  }

  // Pick the first environment by default.
  const envList = envs.data?.data ?? [];
  useEffect(() => {
    if (!env && envList[0]) setEnv(envList[0].id);
  }, [env, envList]);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild><Button><Plus /> Create session</Button></DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create session</DialogTitle>
            <DialogDescription>Starts an instance of the agent in its own sandbox.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>Agent</Label>
            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select an agent" /></SelectTrigger>
              <SelectContent>
                {agents.data?.data.map((a) => <SelectItem key={a.id} value={a.id}>{a.name} <span className="text-muted-foreground">· {a.model.id}</span></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Environment</Label>
            <Select value={env} onValueChange={setEnv}>
              <SelectTrigger className="w-full"><SelectValue placeholder={envList.length ? "Select an environment" : "Create an environment first"} /></SelectTrigger>
              <SelectContent>
                {envList.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="s-title">Title (optional)</Label>
              <Input id="s-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name this run" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="s-budget">Budget in $ (optional)</Label>
              <Input id="s-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="1.00" />
            </div>
          </div>
          {(vaults.data?.data.length ?? 0) > 0 && (
            <div className="grid gap-2">
              <Label>Credential vaults {needsVault ? "" : "(optional)"}</Label>
              <div className="grid max-h-28 gap-1 overflow-y-auto rounded-md border p-2">
                {vaults.data!.data.map((v) => (
                  <label key={v.id} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={vaultIds.includes(v.id)}
                      onChange={(e) => setVaultIds((ids) => (e.target.checked ? [...ids, v.id] : ids.filter((x) => x !== v.id)))}
                    />
                    <span className="truncate">{v.display_name}</span>
                  </label>
                ))}
              </div>
              {needsVault && vaultIds.length === 0 && (
                <p className="text-xs text-amber-600">This agent uses MCP servers; pick the vault that holds their tokens.</p>
              )}
            </div>
          )}
          {uploads.length > 0 && (
            <div className="grid gap-2">
              <Label>Attach files (optional)</Label>
              <div className="grid max-h-32 gap-1 overflow-y-auto rounded-md border p-2">
                {uploads.map((f) => (
                  <label key={f.id} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={attached.includes(f.id)}
                      onChange={(e) => setAttached((a) => (e.target.checked ? [...a, f.id] : a.filter((x) => x !== f.id)))}
                    />
                    <span className="truncate">{f.filename}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{formatBytes(f.size_bytes)}</span>
                  </label>
                ))}
              </div>
              {attached.length > 0 && <p className="text-xs text-muted-foreground">Copied into the sandbox under /mnt/session/uploads/.</p>}
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="s-msg">First message (optional)</Label>
            <Textarea id="s-msg" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What should the agent do?" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending ? "Starting…" : "Create session"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
