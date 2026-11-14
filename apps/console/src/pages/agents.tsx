import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import type { Agent, Page } from "@agentos/types";
import { PageHeader } from "@/components/layout";
import { ModelPicker } from "@/components/model-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiRequestError, timeAgo } from "@/lib/api";

export function useAgents() {
  return useQuery({ queryKey: ["agents"], queryFn: () => api<Page<Agent>>("/v1/agents?limit=100") });
}

export function AgentsPage() {
  const agents = useAgents();
  return (
    <>
      <PageHeader title="Agents" description="Create and manage autonomous agents." actions={<CreateAgentDialog />} />
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.isLoading && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {agents.data?.data.length === 0 && (
              <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">No agents yet. Create your first agent.</TableCell></TableRow>
            )}
            {agents.data?.data.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-mono text-xs">
                  <Link to={`/agents/${a.id}`} className="hover:underline">{a.id}</Link>
                </TableCell>
                <TableCell className="font-medium">{a.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{a.model.id}</TableCell>
                <TableCell>v{a.version}</TableCell>
                <TableCell className="text-muted-foreground">{timeAgo(a.updated_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function CreateAgentDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("You are a helpful agent. Complete the user's task end to end.");
  const [mcp, setMcp] = useState<Array<{ name: string; url: string }>>([]);
  const [subagents, setSubagents] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: () =>
      api<Agent>("/v1/agents", {
        method: "POST",
        json: {
          name,
          model,
          system,
          tools: [
            { type: "agent_toolset_20260401", default_config: { permission_policy: { type: "auto" } } },
            // MCP tools ask before running, as in CMA; change per tool later in the agent's config.
            ...mcp.map((m) => ({ type: "mcp_toolset", mcp_server_name: m.name.trim(), default_config: { permission_policy: { type: "always_ask" } } })),
          ],
          mcp_servers: mcp.length ? mcp.map((m) => ({ type: "url", name: m.name.trim(), url: m.url.trim() })) : undefined,
          multiagent: subagents ? { type: "multiagent_20261001", subagents: { type: "enabled" } } : undefined,
        },
      }),
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      setOpen(false);
      navigate(`/agents/${agent.id}`);
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : "Could not create the agent."),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the agent a name.");
    if (!model) return setError("Choose a model.");
    for (const m of mcp) {
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(m.name.trim())) return setError("MCP server names use letters, numbers, - and _ (max 32).");
      if (!/^https?:\/\/\S+$/.test(m.url.trim())) return setError(`Enter a full URL for MCP server "${m.name}".`);
    }
    if (new Set(mcp.map((m) => m.name.trim())).size !== mcp.length) return setError("MCP server names must be unique.");
    setError(null);
    create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus /> Create agent</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create agent</DialogTitle>
            <DialogDescription>Saved as version 1. Any OpenRouter model can power it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input id="agent-name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="Research assistant" />
          </div>
          <div className="grid gap-2">
            <Label>Model {model && <span className="font-mono text-xs text-muted-foreground">· {model}</span>}</Label>
            <ModelPicker value={model} onChange={(id) => { setModel(id); setError(null); }} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-system">System prompt</Label>
            <Textarea id="agent-system" rows={3} value={system} onChange={(e) => setSystem(e.target.value)} />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">Allow sub-agents</div>
              <div className="text-xs text-muted-foreground">The agent can delegate parts of a task to helpers that run as their own threads.</div>
            </div>
            <Switch checked={subagents} onCheckedChange={setSubagents} aria-label="Allow sub-agents" />
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>MCP servers (optional)</Label>
              <Button type="button" size="sm" variant="ghost" onClick={() => setMcp([...mcp, { name: "", url: "" }])}><Plus /> Add server</Button>
            </div>
            {mcp.map((m, i) => (
              <div key={i} className="grid grid-cols-[10rem_1fr_auto] gap-2">
                <Input aria-label="MCP server name" placeholder="linear" value={m.name}
                  onChange={(e) => setMcp(mcp.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Input aria-label="MCP server URL" placeholder="https://mcp.linear.app/mcp" value={m.url}
                  onChange={(e) => setMcp(mcp.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
                <Button type="button" size="icon" variant="ghost" aria-label="Remove server" onClick={() => setMcp(mcp.filter((_, j) => j !== i))}><X /></Button>
              </div>
            ))}
            {mcp.length > 0 && (
              <p className="text-xs text-muted-foreground">Add each server's token to a credential vault, then pick that vault when you start a session.</p>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create agent"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
