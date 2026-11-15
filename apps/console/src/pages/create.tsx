import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowUp, Bot, Check, ChevronDown, ExternalLink, GitBranch, History, Loader2, MessageSquarePlus, Pencil, Play, Plus, Rocket, Sparkles, Split, Flag, Users, Workflow as WorkflowIcon,
} from "lucide-react";
import type { BuilderChat, BuilderPlan, BuilderWorkflowNode, WorkflowEdge, WorkflowRun } from "@agentos/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { StepEditor } from "@/components/step-editor";
import { StepLegend, WorkflowCanvas, type CanvasStep } from "@/components/workflow-canvas";
import { useModels } from "@/components/model-picker";
import { api, ApiRequestError, timeAgo } from "@/lib/api";
import { newStep, pruneEdges, removeStep, upstreamOf } from "@/lib/workflow-edit";
import { cn } from "@/lib/utils";

const EXAMPLES = [
  "Triage new support tickets: classify severity, draft a page for P1s and a friendly reply for everything else",
  "A research assistant that reads a few sources on a topic and writes a one-page brief with citations",
  "Every week, review competitor pricing pages and summarise what changed for the sales team",
  "Review a pull request diff: check for bugs, then security issues, then write one combined review",
];

const PHASES = ["Reading your request", "Deciding: one agent, a team or a workflow", "Writing each agent's instructions", "Wiring the steps together", "Checking the plan"];

const errText = (e: unknown) => (e instanceof ApiRequestError ? e.message : "Something went wrong. Try again.");

const KIND_INFO: Record<BuilderPlan["kind"], { label: string; icon: typeof Bot }> = {
  agent: { label: "Single agent", icon: Bot },
  team: { label: "Agent team", icon: Users },
  workflow: { label: "Workflow", icon: WorkflowIcon },
};

function Thinking() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => Math.min(x + 1, PHASES.length - 1)), 2500);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="rounded-lg border bg-card p-3 text-sm">
      <div className="mb-2 flex items-center gap-2 font-medium"><Loader2 className="size-4 animate-spin" /> Building the plan…</div>
      <ol className="grid gap-1">
        {PHASES.map((p, j) => (
          <li key={p} className={cn("flex items-center gap-2 text-xs", j > i ? "text-muted-foreground/50" : "text-muted-foreground")}>
            {j < i ? <Check className="size-3 text-emerald-600" /> : j === i ? <Loader2 className="size-3 animate-spin" /> : <span className="size-3" />}
            {p}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Message({ m }: { m: BuilderChat["messages"][number] }) {
  if (m.role === "user") {
    return <div className="ml-8 self-end whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">{m.content}</div>;
  }
  return (
    <div className="mr-4 grid gap-2 text-sm">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-violet-600" />
        <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
      </div>
      {m.changes && m.changes.length > 0 && (
        <ul className="ml-6 grid gap-0.5 text-xs text-muted-foreground">
          {m.changes.map((c) => <li key={c} className="flex gap-1.5"><Pencil className="mt-0.5 size-3 shrink-0" />{c}</li>)}
        </ul>
      )}
    </div>
  );
}

function PlanTab({ plan, onAsk }: { plan: BuilderPlan; onAsk: (q: string) => void }) {
  const K = KIND_INFO[plan.kind];
  return (
    <div className="grid gap-5 p-4 text-sm">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <Badge variant="secondary" className="gap-1"><K.icon className="size-3" />{K.label}</Badge>
          <h2 className="font-semibold">{plan.title}</h2>
        </div>
        <p className="text-muted-foreground">{plan.summary}</p>
      </div>
      <section>
        <h3 className="mb-2 font-medium">How it was planned</h3>
        <ol className="grid gap-2">
          {plan.steps.map((s, i) => (
            <li key={i} className="grid grid-cols-[24px_1fr] gap-2">
              <span className="flex size-6 items-center justify-center rounded-full border text-xs">{i + 1}</span>
              <div><div className="font-medium">{s.title}</div><div className="text-muted-foreground">{s.detail}</div></div>
            </li>
          ))}
        </ol>
      </section>
      {plan.open_questions.length > 0 && (
        <section>
          <h3 className="mb-2 font-medium">Open questions</h3>
          <ul className="grid gap-1.5">
            {plan.open_questions.map((q) => (
              <li key={q} className="flex items-start justify-between gap-2 rounded-md border px-3 py-2">
                <span>{q}</span>
                <Button size="sm" variant="ghost" onClick={() => onAsk(`${q} → `)}>Answer</Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan.assumptions.length > 0 && (
        <section>
          <h3 className="mb-2 font-medium">Assumptions</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">{plan.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </section>
      )}
      <section>
        <h3 className="mb-2 font-medium">Environment</h3>
        <div className="rounded-md border px-3 py-2 text-muted-foreground">
          <div><span className="text-foreground">{plan.environment.name}</span> · network {plan.environment.networking}
            {plan.environment.networking === "limited" && plan.environment.allowed_hosts.length > 0 && ` (${plan.environment.allowed_hosts.join(", ")})`}</div>
          {(plan.environment.pip.length > 0 || plan.environment.npm.length > 0) && (
            <div className="mt-1 font-mono text-xs">{[...plan.environment.pip.map((p) => `pip ${p}`), ...plan.environment.npm.map((p) => `npm ${p}`)].join(" · ")}</div>
          )}
        </div>
      </section>
      {plan.test_input && (
        <section>
          <h3 className="mb-2 font-medium">Test input</h3>
          <pre className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-xs">{plan.test_input}</pre>
        </section>
      )}
    </div>
  );
}

function AgentsTab({ plan, applied, onEdit }: { plan: BuilderPlan; applied: BuilderChat["applied"]; onEdit: (key: string) => void }) {
  const usedBy = (key: string) => plan.workflow?.nodes.filter((n) => n.type === "agent" && n.agent_key === key).map((n) => n.label) ?? [];
  return (
    <div className="grid gap-3 p-4">
      {plan.agents.map((a) => (
        <div key={a.key} className="rounded-lg border bg-card p-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-medium"><Bot className="size-4 text-violet-600" />{a.name}</div>
              <div className="mt-0.5 text-muted-foreground">{a.description}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {applied?.agents[a.key] && (
                <Button asChild size="sm" variant="ghost"><Link to={`/agents/${applied.agents[a.key]}`}><ExternalLink /> Open</Link></Button>
              )}
              <Button size="sm" variant="outline" onClick={() => onEdit(a.key)}><Pencil /> Edit</Button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline" className="font-mono">{a.model}</Badge>
            {a.toolset && <Badge variant="outline">bash, files, web_fetch</Badge>}
            {a.subagents && <Badge variant="outline">sub-agents</Badge>}
            {a.mcp_servers.map((s) => <Badge key={s.name} variant="outline">MCP {s.name}</Badge>)}
            {usedBy(a.key).map((l) => <Badge key={l} variant="secondary">step: {l}</Badge>)}
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">Instructions</summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{a.system}</pre>
          </details>
        </div>
      ))}
    </div>
  );
}

function AgentSheet({ plan, agentKey, onClose, onSave }: { plan: BuilderPlan; agentKey: string | null; onClose: () => void; onSave: (a: BuilderPlan["agents"][number]) => void }) {
  const current = plan.agents.find((a) => a.key === agentKey) ?? null;
  const [a, setA] = useState(current);
  useEffect(() => { setA(current); }, [agentKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const models = useModels();
  if (!a) return null;
  return (
    <Sheet open={Boolean(agentKey)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader><SheetTitle>{a.name}</SheetTitle><SheetDescription>Agent key <code className="text-xs">{a.key}</code></SheetDescription></SheetHeader>
        <div className="grid gap-4 px-4">
          <div className="grid gap-1.5"><Label htmlFor="ag-name">Name</Label><Input id="ag-name" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} /></div>
          <div className="grid gap-1.5">
            <Label htmlFor="ag-model">Model</Label>
            <Input id="ag-model" list="ag-models" className="font-mono text-xs" value={a.model} onChange={(e) => setA({ ...a, model: e.target.value })} />
            <datalist id="ag-models">{(models.data ?? []).filter((m) => m.supports_tools).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="ag-system">Instructions</Label>
            <Textarea id="ag-system" rows={12} className="text-xs" value={a.system} onChange={(e) => setA({ ...a, system: e.target.value })} /></div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div><div className="text-sm">Tools</div><div className="text-xs text-muted-foreground">bash, file tools and web_fetch in a sandbox</div></div>
            <Switch checked={a.toolset} onCheckedChange={(v) => setA({ ...a, toolset: v })} />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div><div className="text-sm">Sub-agents</div><div className="text-xs text-muted-foreground">Can hand parts of a task to helpers</div></div>
            <Switch checked={a.subagents} onCheckedChange={(v) => setA({ ...a, subagents: v })} />
          </div>
        </div>
        <SheetFooter><Button onClick={() => onSave(a)}>Save agent</Button></SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function RunBanner({ run }: { run: WorkflowRun }) {
  const done = run.status !== "running";
  return (
    <div className={cn("flex items-center gap-3 border-b px-4 py-2 text-sm", run.status === "failed" && "bg-red-50 dark:bg-red-950/40", run.status === "succeeded" && "bg-emerald-50 dark:bg-emerald-950/40")}>
      {done ? (run.status === "succeeded" ? <Check className="size-4 text-emerald-600" /> : <span className="size-2 rounded-full bg-red-500" />) : <Loader2 className="size-4 animate-spin" />}
      <span className="font-medium">Test run {run.status}</span>
      {run.error && <span className="truncate text-muted-foreground">{run.error.message}</span>}
      {Number(run.cost_usd) > 0 && <span className="text-muted-foreground">${Number(run.cost_usd).toFixed(4)}</span>}
      <Button asChild size="sm" variant="ghost" className="ml-auto"><Link to={`/workflows/${run.workflow_id}?run=${run.id}`}>Open run <ExternalLink /></Link></Button>
    </div>
  );
}

export function CreatePage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const chatId = params.get("chat");
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [tab, setTab] = useState("workflow");
  const [selected, setSelected] = useState<string | null>(null);
  const [editAgent, setEditAgent] = useState<string | null>(null);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const models = useModels();

  const chats = useQuery({ queryKey: ["builder-chats"], queryFn: () => api<{ data: BuilderChat[] }>("/v1/x/builder/chats").then((r) => r.data) });
  const chat = useQuery({ queryKey: ["builder-chat", chatId], queryFn: () => api<BuilderChat>(`/v1/x/builder/chats/${chatId}`), enabled: Boolean(chatId) });
  const plan = chat.data?.plan ?? null;
  const run = useQuery({
    queryKey: ["workflow-run", testRunId],
    queryFn: () => api<WorkflowRun>(`/v1/x/workflow_runs/${testRunId}`),
    enabled: Boolean(testRunId),
    refetchInterval: (q) => (q.state.data && q.state.data.status !== "running" ? false : 1000),
  });

  useEffect(() => { if (chat.data) setModel(chat.data.model); }, [chat.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTestRunId(null); setSelected(null); }, [chatId]);
  useEffect(() => { if (plan) setTab(plan.kind === "workflow" ? "workflow" : "agents"); }, [plan?.kind, chatId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [chat.data?.messages.length, pending]);

  const put = (c: BuilderChat) => {
    qc.setQueryData(["builder-chat", c.id], c);
    qc.invalidateQueries({ queryKey: ["builder-chats"] });
  };

  const send = useMutation({
    mutationFn: async (message: string) => {
      const body = { message, ...(model ? { model } : {}) };
      return chatId
        ? api<BuilderChat>(`/v1/x/builder/chats/${chatId}/messages`, { method: "POST", json: body })
        : api<BuilderChat>("/v1/x/builder/chats", { method: "POST", json: body });
    },
    onMutate: (m) => setPending(m),
    onSuccess: (c) => {
      put(c);
      if (c.id !== chatId) setParams({ chat: c.id });
      setText("");
    },
    onError: (e) => toast.error(errText(e)),
    onSettled: () => setPending(null),
  });

  const savePlan = useMutation({
    mutationFn: (p: BuilderPlan) => api<BuilderChat>(`/v1/x/builder/chats/${chatId}/plan`, { method: "POST", json: { plan: p } }),
    onMutate: (p) => { if (chat.data) qc.setQueryData(["builder-chat", chatId], { ...chat.data, plan: p }); },
    onSuccess: put,
    onError: (e) => { toast.error(errText(e)); qc.invalidateQueries({ queryKey: ["builder-chat", chatId] }); },
  });

  const apply = useMutation({
    mutationFn: () => api<BuilderChat>(`/v1/x/builder/chats/${chatId}/apply`, { method: "POST", json: {} }),
    onSuccess: (c) => {
      put(c);
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["workflows"] });
      toast.success(chat.data?.applied ? "Updated" : c.applied?.workflow_id ? "Agents and workflow created" : "Agent created");
    },
    onError: (e) => toast.error(errText(e)),
  });

  const test = useMutation({
    mutationFn: () => api<{ type: "workflow_run" | "session"; id: string }>(`/v1/x/builder/chats/${chatId}/test`, { method: "POST", json: {} }),
    onSuccess: (r) => {
      if (r.type === "workflow_run") { setTestRunId(r.id); setTab("workflow"); }
      else navigate(`/sessions/${r.id}`);
    },
    onError: (e) => toast.error(errText(e)),
  });

  const submit = () => {
    const m = text.trim();
    if (!m || send.isPending) return;
    send.mutate(m);
  };

  const wf = plan?.workflow ?? null;
  const steps = (wf?.nodes ?? []) as CanvasStep[];
  const agentOptions = (plan?.agents ?? []).map((a) => ({ value: a.key, label: a.name }));
  const agentName = useMemo(() => {
    const m = new Map((plan?.agents ?? []).map((a) => [a.key, a.name]));
    return (s: CanvasStep) => (s.type === "agent" && "agent_key" in s ? m.get(s.agent_key) ?? s.agent_key : null);
  }, [plan?.agents]);
  const updateGraph = (nodes: CanvasStep[], edges: WorkflowEdge[]) => {
    if (!plan || !wf) return;
    savePlan.mutate({ ...plan, workflow: { ...wf, nodes: nodes as BuilderWorkflowNode[], edges: pruneEdges(nodes, edges) } });
  };
  const selectedStep = steps.find((s) => s.id === selected) ?? null;
  const toolModels = (models.data ?? []).filter((m) => m.supports_tools);

  /* ------------------------------------------------------------- empty state */
  if (!chatId) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6 pt-10">
        <div className="text-center">
          <Sparkles className="mx-auto mb-3 size-8 text-violet-600" />
          <h1 className="text-2xl font-semibold tracking-tight">What should your agents do?</h1>
          <p className="mt-1 text-sm text-muted-foreground">Describe it in a sentence. The builder plans one agent, a team, or a step-by-step workflow, and you review it before anything is created.</p>
        </div>
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <Textarea
            ref={input}
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder="Triage new support tickets and page on-call for outages"
            className="resize-none border-0 shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="builder-model" className="text-xs text-muted-foreground">Builder model</Label>
              <Input id="builder-model" list="builder-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" className="h-8 w-64 font-mono text-xs" />
              <datalist id="builder-models">{toolModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
            </div>
            <Button onClick={submit} disabled={send.isPending || !text.trim()}>
              {send.isPending ? <Loader2 className="animate-spin" /> : <ArrowUp />} Build
            </Button>
          </div>
        </div>
        {send.isPending && <Thinking />}
        <div className="grid gap-2 sm:grid-cols-2">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" className="rounded-lg border p-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onClick={() => { setText(e); input.current?.focus(); }}>
              {e}
            </button>
          ))}
        </div>
        {(chats.data?.length ?? 0) > 0 && (
          <div>
            <h2 className="mb-2 text-sm font-medium">Recent</h2>
            <div className="divide-y rounded-lg border">
              {chats.data!.slice(0, 6).map((c) => (
                <button key={c.id} type="button" onClick={() => setParams({ chat: c.id })} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent">
                  <span className="truncate">{c.title}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {c.applied && <Badge variant="secondary">created</Badge>}{timeAgo(c.updated_at)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ------------------------------------------------------------- chat + panel */
  const K = plan ? KIND_INFO[plan.kind] : null;
  return (
    <div className="-m-6 grid h-[calc(100svh-3rem)] grid-cols-1 lg:grid-cols-[400px_minmax(0,1fr)]">
      {/* Chat */}
      <div className="flex min-h-0 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="min-w-0 max-w-[260px] justify-start">
                <History /><span className="truncate">{chat.data?.title ?? "Loading…"}</span><ChevronDown className="opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel>Recent builds</DropdownMenuLabel>
              {(chats.data ?? []).slice(0, 15).map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => setParams({ chat: c.id })} className="justify-between">
                  <span className="truncate">{c.title}</span><span className="text-xs text-muted-foreground">{timeAgo(c.updated_at)}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setParams({})}><MessageSquarePlus /> New build</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" className="ml-auto" aria-label="New build" onClick={() => setParams({})}><Plus /></Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {(chat.data?.messages ?? []).map((m, i) => <Message key={i} m={m} />)}
          {pending && <><Message m={{ role: "user", content: pending, created_at: "" }} /><Thinking /></>}
          <div ref={bottom} />
        </div>
        <div className="border-t p-3">
          <div className="rounded-lg border bg-card p-2 focus-within:ring-1 focus-within:ring-ring">
            <Textarea
              ref={input}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
              placeholder={plan ? "Ask for a change: add a step, use a different model, split an agent…" : "Describe what you want"}
              className="min-h-0 resize-none border-0 p-1 shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-2">
              <Input aria-label="Builder model" list="builder-models-2" value={model} onChange={(e) => setModel(e.target.value)} className="h-7 w-52 font-mono text-[11px]" />
              <datalist id="builder-models-2">{toolModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
              <Button size="icon" className="size-7" aria-label="Send" onClick={submit} disabled={send.isPending || !text.trim()}>
                {send.isPending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Result panel */}
      <div className="flex min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          {plan && K ? (
            <>
              <Badge variant="secondary" className="gap-1"><K.icon className="size-3" />{K.label}</Badge>
              <span className="truncate font-medium">{plan.title}</span>
              {chat.data?.applied ? <Badge variant="outline" className="text-emerald-700 dark:text-emerald-400">Created</Badge> : <Badge variant="outline">Draft</Badge>}
              <div className="ml-auto flex items-center gap-2">
                {chat.data?.applied?.workflow_id && (
                  <Button asChild size="sm" variant="ghost"><Link to={`/workflows/${chat.data.applied.workflow_id}`}>Open workflow <ExternalLink /></Link></Button>
                )}
                {chat.data?.applied && (
                  <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
                    {test.isPending ? <Loader2 className="animate-spin" /> : <Play />} Test run
                  </Button>
                )}
                <Button size="sm" onClick={() => apply.mutate()} disabled={apply.isPending || send.isPending}>
                  {apply.isPending ? <Loader2 className="animate-spin" /> : <Rocket />} {chat.data?.applied ? "Update" : "Create"}
                </Button>
              </div>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">{chat.isLoading || send.isPending ? "Planning…" : "No plan yet"}</span>
          )}
        </div>
        {plan ? (
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="flex items-center justify-between border-b px-4 py-1.5">
              <TabsList>
                {wf && <TabsTrigger value="workflow"><WorkflowIcon /> Workflow</TabsTrigger>}
                <TabsTrigger value="agents"><Bot /> Agents ({plan.agents.length})</TabsTrigger>
                <TabsTrigger value="plan"><Sparkles /> Plan</TabsTrigger>
              </TabsList>
              {tab === "workflow" && wf && <StepLegend />}
            </div>
            {wf && (
              <TabsContent value="workflow" className="flex min-h-0 flex-1 flex-col">
                {run.data && <RunBanner run={run.data} />}
                <div className="flex items-center gap-1 border-b px-4 py-1.5">
                  <span className="mr-2 text-xs text-muted-foreground">Add step</span>
                  {([["agent", Bot], ["condition", GitBranch], ["router", Split], ["output", Flag]] as const).map(([t, Icon]) => (
                    <Button key={t} size="sm" variant="ghost" className="h-7 capitalize" onClick={() => {
                      const s = newStep(t, steps, { key: plan.agents[0]?.key ?? "" });
                      updateGraph([...steps, s], wf.edges);
                      setSelected(s.id);
                    }}><Icon /> {t}</Button>
                  ))}
                  <span className="ml-auto text-xs text-muted-foreground">Drag to connect · click a step to edit · Delete removes</span>
                </div>
                <div className="min-h-0 flex-1 p-3">
                  <WorkflowCanvas
                    className="h-full"
                    steps={steps}
                    edges={wf.edges}
                    agentName={agentName}
                    states={run.data?.steps}
                    editable
                    selectedId={selected}
                    onSelect={setSelected}
                    onChange={updateGraph}
                  />
                </div>
              </TabsContent>
            )}
            <TabsContent value="agents" className="min-h-0 flex-1 overflow-y-auto">
              <AgentsTab plan={plan} applied={chat.data?.applied ?? null} onEdit={setEditAgent} />
            </TabsContent>
            <TabsContent value="plan" className="min-h-0 flex-1 overflow-y-auto">
              <PlanTab plan={plan} onAsk={(q) => { setText(q); input.current?.focus(); }} />
            </TabsContent>
          </Tabs>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
            {send.isPending || chat.isLoading ? <Loader2 className="size-5 animate-spin" /> : "Describe what you want in the chat; the plan and its workflow appear here."}
          </div>
        )}
      </div>

      {plan && wf && (
        <StepEditor
          step={selectedStep && selected ? selectedStep : null}
          agents={agentOptions}
          upstream={selected ? upstreamOf(selected, wf.edges) : []}
          onClose={() => setSelected(null)}
          onSave={(s) => { updateGraph(steps.map((x) => (x.id === s.id ? s : x)), wf.edges); setSelected(null); }}
          onDelete={(id) => { const r = removeStep(id, steps, wf.edges); updateGraph(r.steps, r.edges); setSelected(null); }}
        />
      )}
      {plan && (
        <AgentSheet
          plan={plan}
          agentKey={editAgent}
          onClose={() => setEditAgent(null)}
          onSave={(a) => { savePlan.mutate({ ...plan, agents: plan.agents.map((x) => (x.key === a.key ? a : x)) }); setEditAgent(null); }}
        />
      )}
    </div>
  );
}
