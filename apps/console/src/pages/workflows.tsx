import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, Check, ExternalLink, Flag, GitBranch, Loader2, Play, Save, Sparkles, Split, Square, Workflow as WorkflowIcon, XCircle } from "lucide-react";
import type { Agent, Page, Workflow, WorkflowEdge, WorkflowNode, WorkflowRun } from "@agentos/types";
import { PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { StepEditor } from "@/components/step-editor";
import { StepLegend, WorkflowCanvas, type CanvasStep } from "@/components/workflow-canvas";
import { api, ApiRequestError, timeAgo } from "@/lib/api";
import { newStep, pruneEdges, removeStep, stableJson, upstreamOf } from "@/lib/workflow-edit";
import { cn } from "@/lib/utils";

const errText = (e: unknown) => (e instanceof ApiRequestError ? e.message : "Something went wrong. Try again.");

function RunStatus({ status }: { status: WorkflowRun["status"] }) {
  const tone = {
    running: "text-blue-700 dark:text-blue-300",
    succeeded: "text-emerald-700 dark:text-emerald-400",
    failed: "text-red-700 dark:text-red-400",
    cancelled: "text-muted-foreground",
  }[status];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", tone)}>
      {status === "running" ? <Loader2 className="size-3 animate-spin" /> : status === "succeeded" ? <Check className="size-3" /> : status === "failed" ? <XCircle className="size-3" /> : <Square className="size-3" />}
      {status}
    </span>
  );
}

function useAgents() {
  return useQuery({ queryKey: ["agents"], queryFn: () => api<Page<Agent>>("/v1/agents?limit=100") });
}

/* ------------------------------------------------------------------ list */

export function WorkflowsPage() {
  const list = useQuery({ queryKey: ["workflows"], queryFn: () => api<Page<Workflow>>("/v1/x/workflows?limit=100") });
  const runs = useQuery({ queryKey: ["workflow-runs"], queryFn: () => api<Page<WorkflowRun>>("/v1/x/workflow_runs?limit=100") });
  const lastRun = (id: string) => runs.data?.data.find((r) => r.workflow_id === id);
  return (
    <div>
      <PageHeader
        title="Workflows"
        description="Agents connected step by step, with conditions and routes. Each agent step runs as its own session."
        actions={<Button asChild><Link to="/create"><Sparkles /> Build with chat</Link></Button>}
      />
      {list.data && list.data.data.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <WorkflowIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
          <h2 className="font-medium">Build your first workflow</h2>
          <p className="mt-1 text-sm text-muted-foreground">Describe the process in a sentence and the builder lays out the steps for you.</p>
          <Button asChild className="mt-4"><Link to="/create"><Sparkles /> Build with chat</Link></Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Name</TableHead><TableHead>Steps</TableHead><TableHead>Version</TableHead><TableHead>Last run</TableHead><TableHead>Updated</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {(list.data?.data ?? []).map((w) => {
                const r = lastRun(w.id);
                return (
                  <TableRow key={w.id}>
                    <TableCell>
                      <Link to={`/workflows/${w.id}`} className="font-medium hover:underline">{w.name}</Link>
                      {w.description && <div className="max-w-md truncate text-xs text-muted-foreground">{w.description}</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{w.nodes.filter((n) => n.type === "agent").length} agents · {w.nodes.length} steps</TableCell>
                    <TableCell>v{w.version}</TableCell>
                    <TableCell>{r ? <span className="flex items-center gap-2"><RunStatus status={r.status} /><span className="text-xs text-muted-foreground">{timeAgo(r.created_at)}</span></span> : <span className="text-xs text-muted-foreground">Never</span>}</TableCell>
                    <TableCell className="text-muted-foreground">{timeAgo(w.updated_at)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- detail */

function RunDialog({ wf, open, onOpenChange, onStarted }: { wf: Workflow; open: boolean; onOpenChange: (o: boolean) => void; onStarted: (r: WorkflowRun) => void }) {
  const [input, setInput] = useState("");
  const start = wf.nodes.find((n) => n.type === "start");
  const run = useMutation({
    mutationFn: () => api<WorkflowRun>(`/v1/x/workflows/${wf.id}/runs`, { method: "POST", json: { input } }),
    onSuccess: (r) => { onStarted(r); onOpenChange(false); },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run {wf.name}</DialogTitle>
          <DialogDescription>{start?.type === "start" && start.input_description ? start.input_description : "The text each step can read as {{input}}."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="run-input">Input</Label>
          <Textarea id="run-input" rows={6} value={input} onChange={(e) => setInput(e.target.value)} />
        </div>
        <DialogFooter>
          <Button onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? <Loader2 className="animate-spin" /> : <Play />} Run</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunPanel({ run, wf, onCancel }: { run: WorkflowRun; wf: Workflow; onCancel: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const order = wf.nodes.map((n) => n.id).filter((id) => run.steps[id]);
  return (
    <div className="grid gap-3 text-sm">
      <div className="flex items-center justify-between">
        <RunStatus status={run.status} />
        <span className="text-xs text-muted-foreground">{timeAgo(run.created_at)} · ${Number(run.cost_usd).toFixed(4)}</span>
      </div>
      {run.status === "running" && <Button size="sm" variant="outline" onClick={onCancel}><Square /> Cancel run</Button>}
      {run.error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{run.error.message}</div>}
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">Input</div>
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{run.input || "(empty)"}</pre>
      </div>
      {run.output !== null && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Result</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{run.output || "(empty)"}</pre>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">Steps</div>
        <ul className="divide-y rounded-md border">
          {order.map((id) => {
            const s = run.steps[id]!;
            const n = wf.nodes.find((x) => x.id === id)!;
            return (
              <li key={id} className="px-2 py-1.5">
                <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpen(open === id ? null : id)}>
                  <span className="truncate">{n.label}</span>
                  <span className={cn("text-xs", s.status === "failed" ? "text-red-600" : s.status === "succeeded" ? "text-emerald-600" : "text-muted-foreground")}>
                    {s.branch ? `${s.status} → ${s.branch}` : s.status}
                  </span>
                </button>
                {open === id && (
                  <div className="mt-1.5 grid gap-1.5">
                    {s.error && <div className="text-xs text-red-600">{s.error}</div>}
                    {s.output && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{s.output}</pre>}
                    {s.session_id && <Link className="inline-flex items-center gap-1 text-xs text-primary hover:underline" to={`/sessions/${s.session_id}`}>Open session <ExternalLink className="size-3" /></Link>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export function WorkflowDetailPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const runId = params.get("run");
  const qc = useQueryClient();
  const wfq = useQuery({ queryKey: ["workflow", id], queryFn: () => api<Workflow>(`/v1/x/workflows/${id}`) });
  const runs = useQuery({
    queryKey: ["workflow-runs", id],
    queryFn: () => api<Page<WorkflowRun>>(`/v1/x/workflows/${id}/runs?limit=50`),
    refetchInterval: (q) => (q.state.data?.data.some((r) => r.status === "running") ? 1500 : false),
  });
  const run = useQuery({
    queryKey: ["workflow-run", runId],
    queryFn: () => api<WorkflowRun>(`/v1/x/workflow_runs/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: (q) => (q.state.data && q.state.data.status !== "running" ? false : 1000),
  });
  const agents = useAgents();
  const [draft, setDraft] = useState<{ steps: CanvasStep[]; edges: WorkflowEdge[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const wf = wfq.data;
  useEffect(() => { if (wf) setDraft({ steps: wf.nodes, edges: wf.edges }); }, [wf?.id, wf?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const agentNames = useMemo(() => new Map((agents.data?.data ?? []).map((a) => [a.id, a.name])), [agents.data]);
  const agentName = useMemo(() => (s: CanvasStep) => (s.type === "agent" && "agent" in s ? agentNames.get(s.agent.id) ?? s.agent.id : null), [agentNames]);

  const save = useMutation({
    mutationFn: (d: { steps: CanvasStep[]; edges: WorkflowEdge[] }) =>
      api<Workflow>(`/v1/x/workflows/${id}`, { method: "POST", json: { version: wf!.version, nodes: d.steps, edges: d.edges } }),
    onSuccess: (w) => {
      qc.setQueryData(["workflow", id], w);
      qc.invalidateQueries({ queryKey: ["workflows"] });
      if (w.version !== wf?.version) toast.success(`Saved as version ${w.version}`);
    },
    onError: (e) => toast.error(errText(e)),
  });
  const cancel = useMutation({
    mutationFn: () => api<WorkflowRun>(`/v1/x/workflow_runs/${runId}/cancel`, { method: "POST", json: {} }),
    onSuccess: (r) => { qc.setQueryData(["workflow-run", runId], r); qc.invalidateQueries({ queryKey: ["workflow-runs", id] }); },
    onError: (e) => toast.error(errText(e)),
  });

  if (!wf || !draft) return <div className="flex justify-center p-10"><Loader2 className="animate-spin" /></div>;

  const noPos = (ss: CanvasStep[]) => stableJson(ss.map((s) => ({ ...s, position: null })));
  const edgesOf = (es: WorkflowEdge[]) => stableJson(es.map((e) => ({ ...e, branch: e.branch ?? null })));
  const dirty = stableJson(draft.steps) !== stableJson(wf.nodes) || edgesOf(draft.edges) !== edgesOf(wf.edges);
  const onlyLayout = dirty && noPos(draft.steps) === noPos(wf.nodes) && edgesOf(draft.edges) === edgesOf(wf.edges);
  const update = (steps: CanvasStep[], edges: WorkflowEdge[]) => {
    const next = { steps, edges: pruneEdges(steps, edges) };
    setDraft(next);
    // Moving steps around saves right away (it doesn't make a new version).
    const sameShape = noPos(steps) === noPos(draft.steps) && edgesOf(next.edges) === edgesOf(draft.edges);
    if (sameShape && !dirty) save.mutate(next);
  };
  const selectedStep = draft.steps.find((s) => s.id === selected) ?? null;
  const builderChat = wf.metadata["agentos.builder_chat"];

  return (
    <div className="-m-6 grid h-[calc(100svh-3rem)] grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Link to="/workflows" className="text-sm text-muted-foreground hover:underline">Workflows</Link>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">{wf.name}</span>
        <Badge variant="outline">v{wf.version}</Badge>
        <div className="ml-auto flex items-center gap-2">
          {builderChat && <Button asChild size="sm" variant="ghost"><Link to={`/create?chat=${builderChat}`}><Sparkles /> Edit with chat</Link></Button>}
          {dirty && !onlyLayout && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setDraft({ steps: wf.nodes, edges: wf.edges })}>Discard</Button>
              <Button size="sm" variant="outline" onClick={() => save.mutate(draft)} disabled={save.isPending}>{save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save as v{wf.version + 1}</Button>
            </>
          )}
          <Button size="sm" onClick={() => setRunOpen(true)} disabled={dirty && !onlyLayout}><Play /> Run</Button>
        </div>
      </div>
      <div className="grid min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center gap-1 border-b px-4 py-1.5">
            <span className="mr-2 text-xs text-muted-foreground">Add step</span>
            {([["agent", Bot], ["condition", GitBranch], ["router", Split], ["output", Flag]] as const).map(([t, Icon]) => (
              <Button key={t} size="sm" variant="ghost" className="h-7 capitalize" onClick={() => {
                const s = newStep(t, draft.steps, { id: agents.data?.data[0]?.id ?? "" });
                update([...draft.steps, s], draft.edges);
                setSelected(s.id);
              }}><Icon /> {t}</Button>
            ))}
            <div className="ml-auto"><StepLegend /></div>
          </div>
          <div className="min-h-0 flex-1 p-3">
            <WorkflowCanvas
              className="h-full"
              steps={draft.steps}
              edges={draft.edges}
              agentName={agentName}
              states={run.data?.workflow_id === wf.id ? run.data.steps : undefined}
              editable
              selectedId={selected}
              onSelect={setSelected}
              onChange={update}
            />
          </div>
        </div>
        <aside className="min-h-0 overflow-y-auto border-l p-4">
          {run.data ? (
            <div className="grid gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Run</h2>
                <Button size="sm" variant="ghost" onClick={() => setParams({})}>All runs</Button>
              </div>
              <RunPanel run={run.data} wf={wf} onCancel={() => cancel.mutate()} />
            </div>
          ) : (
            <div className="grid gap-2">
              <h2 className="text-sm font-medium">Runs</h2>
              {(runs.data?.data ?? []).length === 0 && <p className="text-sm text-muted-foreground">No runs yet. Use Run to try it.</p>}
              <ul className="divide-y rounded-md border">
                {(runs.data?.data ?? []).map((r) => (
                  <li key={r.id}>
                    <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => setParams({ run: r.id })}>
                      <RunStatus status={r.status} />
                      <span className="truncate text-xs text-muted-foreground">{r.trigger.type === "builder_test" ? "test · " : ""}v{r.workflow_version} · {timeAgo(r.created_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {wf.description && <p className="mt-2 text-xs text-muted-foreground">{wf.description}</p>}
            </div>
          )}
        </aside>
      </div>
      <RunDialog wf={wf} open={runOpen} onOpenChange={setRunOpen} onStarted={(r) => { setParams({ run: r.id }); qc.invalidateQueries({ queryKey: ["workflow-runs", id] }); }} />
      <StepEditor
        step={selectedStep}
        agents={(agents.data?.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
        upstream={selected ? upstreamOf(selected, draft.edges) : []}
        onClose={() => setSelected(null)}
        onSave={(s) => { update(draft.steps.map((x) => (x.id === s.id ? s : x)) as WorkflowNode[], draft.edges); setSelected(null); }}
        onDelete={(sid) => { const r = removeStep(sid, draft.steps, draft.edges); update(r.steps, r.edges); setSelected(null); }}
      />
    </div>
  );
}
