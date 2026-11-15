import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronLeft, Copy, Pause, Play, Plus, Rocket, Webhook } from "lucide-react";
import { toast } from "sonner";
import type { Agent, Deployment, DeploymentRun, Page, Session } from "@agentos/types";
import { PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiRequestError, timeAgo } from "@/lib/api";
import { useAgents } from "./agents";
import { useEnvironments } from "./environments";
import { StatusBadge, formatUsd } from "./session-parts";

const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

/** Readable schedule for common cron shapes; falls back to the expression. */
export function describeSchedule(s: Deployment["schedule"]): string {
  if (!s) return "On demand";
  const [min, hour, dom, mon, dow] = s.expression.split(/\s+/);
  const at = /^\d+$/.test(hour ?? "") && /^\d+$/.test(min ?? "") ? `${hour!.padStart(2, "0")}:${min!.padStart(2, "0")}` : null;
  let text = s.expression;
  if (s.expression === "* * * * *") text = "Every minute";
  else if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*") text = "Every hour";
  else if (at && dom === "*" && mon === "*" && dow === "*") text = `Daily at ${at}`;
  else if (at && dom === "*" && mon === "*" && dow === "1-5") text = `Weekdays at ${at}`;
  else if (at && dom === "*" && mon === "*" && /^\d$/.test(dow ?? "")) text = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][Number(dow)]}s at ${at}`;
  return `${text} (${s.timezone})`;
}

function DeploymentStatus({ d }: { d: Deployment }) {
  if (d.archived_at) return <Badge variant="outline">Archived</Badge>;
  if (d.status === "paused") {
    return <Badge variant={d.paused_reason?.type === "error" ? "destructive" : "secondary"}>{d.paused_reason?.type === "error" ? "Paused: error" : "Paused"}</Badge>;
  }
  return <Badge className="bg-emerald-600 text-white">Active</Badge>;
}

export function DeploymentsPage() {
  const deployments = useQuery({ queryKey: ["deployments"], queryFn: () => api<Page<Deployment>>("/v1/deployments?limit=100"), refetchInterval: 10_000 });
  const agents = useAgents();
  const agentName = (id: string) => agents.data?.data.find((a) => a.id === id)?.name ?? id;
  return (
    <>
      <PageHeader title="Deployments" description="Run a pinned agent version on demand, on a schedule or from a webhook." actions={<CreateDeploymentDialog />} />
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Next run</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deployments.data?.data.length === 0 && (
              <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">No deployments yet. Deploy an agent to run it without opening a session yourself.</TableCell></TableRow>
            )}
            {deployments.data?.data.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="font-medium"><Link to={`/deployments/${d.id}`} className="hover:underline">{d.name}</Link></TableCell>
                <TableCell className="text-sm">{agentName(d.agent.id)} <Badge variant="outline" className="ml-1">v{d.agent.version}</Badge></TableCell>
                <TableCell className="text-sm">
                  {describeSchedule(d.schedule)}
                  {d.x_webhook.enabled && <Badge variant="secondary" className="ml-2"><Webhook className="size-3" /> Webhook</Badge>}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {d.status === "active" && d.schedule?.upcoming_runs_at?.[0] ? new Date(d.schedule.upcoming_runs_at[0]).toLocaleString() : "—"}
                </TableCell>
                <TableCell><DeploymentStatus d={d} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

const PRESETS = [
  { label: "On demand only", value: "" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Daily at 09:00", value: "0 9 * * *" },
  { label: "Weekdays at 09:00", value: "0 9 * * 1-5" },
  { label: "Mondays at 08:00", value: "0 8 * * 1" },
  { label: "Custom cron…", value: "custom" },
];

function CreateDeploymentDialog() {
  const agents = useAgents();
  const envs = useEnvironments();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("");
  const [env, setEnv] = useState("");
  const [message, setMessage] = useState("");
  const [preset, setPreset] = useState("");
  const [cron, setCron] = useState("");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [budget, setBudget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const expression = preset === "custom" ? cron.trim() : preset;

  const create = useMutation({
    mutationFn: () =>
      api<Deployment>("/v1/deployments", {
        method: "POST",
        json: {
          name: name.trim(),
          agent,
          environment_id: env,
          initial_events: [{ type: "user.message", content: [{ type: "text", text: message.trim() }] }],
          schedule: expression ? { type: "cron", expression, timezone: tz } : undefined,
          budget: budget ? { type: "limit", max_list_cost: { amount: String(Math.round(Number(budget) * 100)), currency: "USD" } } : undefined,
        },
      }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["deployments"] });
      setOpen(false);
      navigate(`/deployments/${d.id}`);
    },
    onError: (e) => setError(errText(e, "Could not create the deployment.")),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Name the deployment.");
    if (!agent) return setError("Choose an agent.");
    if (!env) return setError("Choose an environment.");
    if (!message.trim()) return setError("Write the task the agent should do on each run.");
    if (preset === "custom" && cron.trim().split(/\s+/).length !== 5) return setError("A cron expression has 5 fields, e.g. 0 9 * * 1-5.");
    if (budget && !(Number(budget) > 0)) return setError("Budget must be a positive dollar amount.");
    setError(null);
    create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild><Button><Rocket /> Deploy an agent</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Deploy an agent</DialogTitle>
            <DialogDescription>Pins the agent's current version. Each run starts a session with this task.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="d-name">Name</Label>
            <Input id="d-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily sales report" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Agent</Label>
              <Select value={agent} onValueChange={setAgent}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select an agent" /></SelectTrigger>
                <SelectContent>
                  {agents.data?.data.map((a) => <SelectItem key={a.id} value={a.id}>{a.name} · v{a.version}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Environment</Label>
              <Select value={env} onValueChange={setEnv}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {envs.data?.data.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="d-msg">Task for each run</Label>
            <Textarea id="d-msg" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Summarise yesterday's sales and save a report to /mnt/session/outputs." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Schedule</Label>
              <Select value={preset || "none"} onValueChange={(v) => setPreset(v === "none" ? "" : v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => <SelectItem key={p.label} value={p.value || "none"}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="d-budget">Budget per run in $ (optional)</Label>
              <Input id="d-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="1.00" />
            </div>
          </div>
          {preset !== "" && (
            <div className="grid grid-cols-2 gap-3">
              {preset === "custom" ? (
                <div className="grid gap-2">
                  <Label htmlFor="d-cron">Cron (5 fields)</Label>
                  <Input id="d-cron" className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1-5" />
                </div>
              ) : <div />}
              <div className="grid gap-2">
                <Label htmlFor="d-tz">Time zone</Label>
                <Input id="d-tz" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Europe/London" />
              </div>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending ? "Deploying…" : "Deploy"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ detail */

export function DeploymentDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ["deployment", id], queryFn: () => api<Deployment>(`/v1/deployments/${id}`), refetchInterval: 10_000 });
  const runs = useQuery({
    queryKey: ["deployment", id, "runs"],
    queryFn: () => api<Page<DeploymentRun>>(`/v1/deployment_runs?deployment_id=${id}&limit=50`),
    refetchInterval: 5_000,
  });
  const versions = useQuery({
    queryKey: ["agent", d.data?.agent.id, "versions"],
    queryFn: () => api<Page<Agent>>(`/v1/agents/${d.data!.agent.id}/versions`),
    enabled: Boolean(d.data),
  });
  const [hook, setHook] = useState<{ url: string; token: string; header: string } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["deployment", id] });
    void qc.invalidateQueries({ queryKey: ["deployments"] });
  };
  const act = (path: string, label: string, method = "POST", json: unknown = {}) =>
    api(`/v1/deployments/${id}${path}`, { method, json: method === "DELETE" ? undefined : json })
      .then(() => { refresh(); toast.success(label); }, (e) => toast.error(errText(e, "Something went wrong.")));

  if (d.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!d.data) return <p className="text-sm text-destructive">Deployment not found.</p>;
  const dep = d.data;
  const live = !dep.archived_at;

  async function runNow() {
    try {
      const run = await api<DeploymentRun>(`/v1/deployments/${id}/run`, { method: "POST", json: {} });
      void qc.invalidateQueries({ queryKey: ["deployment", id, "runs"] });
      if (run.error) toast.error(`Run failed: ${run.error.message}`);
      else toast.success("Run started");
      refresh();
    } catch (e) {
      toast.error(errText(e, "Could not start the run."));
    }
  }

  async function enableWebhook() {
    try {
      setHook(await api(`/v1/deployments/${id}/webhook`, { method: "POST", json: {} }));
      refresh();
    } catch (e) {
      toast.error(errText(e, "Could not create the webhook."));
    }
  }

  return (
    <>
      <Link to="/deployments" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> Deployments
      </Link>
      <PageHeader
        title={dep.name}
        description={dep.description ?? undefined}
        actions={live && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={runNow}><Play /> Run now</Button>
            {dep.status === "active"
              ? <Button variant="outline" onClick={() => act("/pause", "Paused")}><Pause /> Pause</Button>
              : <Button variant="outline" onClick={() => act("/unpause", "Resumed")}><Play /> Resume</Button>}
            <Button variant="ghost" onClick={() => window.confirm(`Archive "${dep.name}"? It stops running and can't be resumed.`) && act("/archive", "Archived")}>Archive</Button>
          </div>
        )}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{dep.id}</span>
        <DeploymentStatus d={dep} />
        {dep.paused_reason?.type === "error" && <span className="text-destructive">{dep.paused_reason.error.message ?? dep.paused_reason.error.type}</span>}
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-base">Agent version</CardTitle><CardDescription>Runs always use this version.</CardDescription></CardHeader>
          <CardContent className="grid gap-2">
            <Link to={`/agents/${dep.agent.id}`} className="text-sm hover:underline">{versions.data?.data[0]?.name ?? dep.agent.id}</Link>
            <Select
              value={String(dep.agent.version)}
              disabled={!live}
              onValueChange={(v) => act("", `Now running v${v}`, "POST", { agent: { type: "agent", id: dep.agent.id, version: Number(v) } })}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(versions.data?.data ?? [{ version: dep.agent.version } as Agent]).map((v, i) => (
                  <SelectItem key={v.version} value={String(v.version)}>v{v.version}{i === 0 ? " (latest)" : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><CalendarClock className="size-4" /> Schedule</CardTitle></CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <span>{describeSchedule(dep.schedule)}</span>
            {dep.schedule?.upcoming_runs_at?.length ? (
              <span className="text-muted-foreground">Next: {new Date(dep.schedule.upcoming_runs_at[0]!).toLocaleString()}{dep.status === "paused" ? " (paused)" : ""}</span>
            ) : null}
            {dep.schedule?.last_run_at && <span className="text-muted-foreground">Last scheduled run {timeAgo(dep.schedule.last_run_at)}</span>}
            {dep.budget && <span className="text-muted-foreground">Budget per run: {formatUsd(Number(dep.budget.max_list_cost.amount) / 100)}</span>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Webhook className="size-4" /> Webhook</CardTitle></CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {hook ? (
              <>
                <p className="text-xs text-muted-foreground">Copy the token now; it isn't shown again. POST any JSON to run the deployment with it.</p>
                <code className="break-all rounded bg-muted px-2 py-1 text-xs">{window.location.origin}{hook.url}</code>
                <div className="flex gap-2">
                  <Input readOnly value={hook.token} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                  <Button size="icon" variant="outline" aria-label="Copy token" onClick={() => navigator.clipboard.writeText(hook.token).then(() => toast.success("Copied"))}><Copy /></Button>
                </div>
                <p className="text-xs text-muted-foreground">Header: <span className="font-mono">{hook.header}: &lt;token&gt;</span></p>
              </>
            ) : dep.x_webhook.enabled ? (
              <>
                <span>Enabled</span>
                {live && <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={enableWebhook}>Rotate token</Button>
                  <Button size="sm" variant="ghost" onClick={() => act("/webhook", "Webhook disabled", "DELETE")}>Disable</Button>
                </div>}
              </>
            ) : (
              live ? <Button size="sm" variant="outline" onClick={enableWebhook}><Plus /> Enable webhook</Button> : <span className="text-muted-foreground">Off</span>
            )}
          </CardContent>
        </Card>
      </div>

      <h2 className="mb-2 text-sm font-medium">Runs</h2>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Session</TableHead>
              <TableHead>Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.data?.data.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No runs yet.</TableCell></TableRow>}
            {runs.data?.data.map((r) => <RunRow key={r.id} run={r} />)}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function RunRow({ run }: { run: DeploymentRun }) {
  const session = useQuery({
    queryKey: ["session", run.session_id],
    queryFn: () => api<Session>(`/v1/sessions/${run.session_id}`),
    enabled: Boolean(run.session_id),
    // A run's session starts idle before its first turn; keep polling until a turn has finished.
    refetchInterval: (q) => (q.state.data?.status === "running" || !q.state.data?.stop_reason ? 3000 : false),
  });
  const trigger = run.trigger_context.type === "schedule" ? "Schedule" : run.trigger_context.type === "webhook" ? "Webhook" : "Manual";
  return (
    <TableRow>
      <TableCell className="text-sm" title={run.created_at}>{timeAgo(run.created_at)}</TableCell>
      <TableCell><Badge variant="outline">{trigger}</Badge></TableCell>
      <TableCell className="text-sm">v{run.agent.version}</TableCell>
      <TableCell className="text-sm">
        {run.error ? (
          <span className="text-destructive">{run.error.message}</span>
        ) : run.session_id ? (
          <Link to={`/sessions/${run.session_id}`} className="inline-flex items-center gap-2 hover:underline">
            {session.data ? <StatusBadge session={session.data} /> : null}
            <span className="font-mono text-xs">{run.session_id}</span>
          </Link>
        ) : "—"}
      </TableCell>
      <TableCell className="text-sm">{session.data ? formatUsd(session.data.usage.cost_usd) : "—"}</TableCell>
    </TableRow>
  );
}
