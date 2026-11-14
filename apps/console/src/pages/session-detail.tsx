import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Archive, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Copy, Download, FileText,
  CornerDownLeft, Loader2, Send, Square, Terminal, User, Users, Wallet, Wrench, X,
} from "lucide-react";
import type { Page, Session, SessionEvent, SessionThread } from "@agentos/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiRequestError, timeAgo } from "@/lib/api";
import { subscribeToSession } from "@/lib/sse";
import { cn } from "@/lib/utils";
import { StatusBadge, formatTokens, formatUsd } from "./session-parts";

type Ev = SessionEvent & Record<string, any>;

const textOf = (e: Ev) => (Array.isArray(e.content) ? e.content.map((b: { text?: string }) => b.text ?? "").join("\n") : "");
const time = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString() : "");

/** All past events, then live ones over SSE. */
function useSessionEvents(sessionId: string) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [loaded, setLoaded] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    setEvents([]);
    setLoaded(false);
    (async () => {
      const all: Ev[] = [];
      let page: string | null = null;
      do {
        const res: Page<Ev> = await api<Page<Ev>>(`/v1/sessions/${sessionId}/events?limit=100${page ? `&page=${page}` : ""}`);
        all.push(...res.data);
        page = res.next_page;
      } while (page && !cancelled);
      if (cancelled) return;
      setEvents(all);
      setLoaded(true);
      unsub = subscribeToSession(sessionId, all.length, (_seq, ev) => {
        setEvents((prev) => (prev.some((p) => p.id === ev.id) ? prev : [...prev, ev as Ev]));
        if (ev.type.startsWith("session.status") || ev.type === "session.usage") {
          void qc.invalidateQueries({ queryKey: ["session", sessionId] });
        }
      });
    })();
    return () => {
      cancelled = true;
      unsub();
    };
  }, [sessionId, qc]);
  return { events, loaded };
}

export function SessionDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ["session", id], queryFn: () => api<Session>(`/v1/sessions/${id}`) });
  const { events, loaded } = useSessionEvents(id);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  const send = async (evs: unknown[]) => {
    setError(null);
    try {
      await api(`/v1/sessions/${id}/events`, { method: "POST", json: { events: evs } });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not send.");
    }
  };

  const archive = async () => {
    try {
      await api(`/v1/sessions/${id}/archive`, { method: "POST" });
      void qc.invalidateQueries({ queryKey: ["session", id] });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not archive.");
    }
  };

  // Sub-agent threads: names from session.thread_created; the main transcript shows the
  // primary thread plus any sub-agent tool call waiting for approval (so it can't be missed).
  const threadNames = useMemo(
    () => new Map(events.filter((e) => e.type === "session.thread_created").map((e) => [String(e.session_thread_id), String(e.agent_name)])),
    [events],
  );
  const primaryEvents = useMemo(
    () =>
      events.filter(
        (e) =>
          !e.session_thread_id ||
          e.type === "session.thread_created" ||
          (["agent.tool_use", "agent.mcp_tool_use"].includes(e.type) && e.evaluated_permission === "ask"),
      ),
    [events],
  );
  const openThreadId = params.get("thread");
  const openThread = (tid: string | null) => {
    const next = new URLSearchParams(params);
    if (tid) next.set("thread", tid);
    else next.delete("thread");
    setParams(next, { replace: true });
  };

  if (session.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!session.data) return <p className="text-sm text-destructive">Session not found.</p>;
  const s = session.data;
  const inTok = s.usage.input_tokens + s.usage.cache_read_input_tokens + s.usage.cache_creation_input_tokens;
  const inspector = params.get("inspector") ?? "session";

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col">
      <ThreadSheet
        sessionId={s.id}
        threadId={openThreadId}
        name={openThreadId ? (threadNames.get(openThreadId) ?? "Sub-agent") : ""}
        events={events}
        onClose={() => openThread(null)}
        onConfirm={(toolUseId, result) => send([{ type: "user.tool_confirmation", tool_use_id: toolUseId, result }])}
      />
      <Link to="/sessions" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> Sessions
      </Link>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{s.title ?? "Untitled session"}</h1>
        <StatusBadge session={s} />
        <Link to={`/agents/${s.agent.id}`} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:bg-accent">
          <Bot className="size-3.5" /> {s.agent.name} · v{s.agent.version}
        </Link>
        <span className="font-mono text-xs text-muted-foreground">{s.agent.model.id}</span>
        <span className="text-xs text-muted-foreground">{formatTokens(inTok)} / {formatTokens(s.usage.output_tokens)} tokens</span>
        <span className="text-xs">
          {formatUsd(s.usage.cost_usd)}
          {s.budget && <span className="text-muted-foreground"> / {formatUsd(Number(s.budget.max_list_cost.amount) / 100)}</span>}
        </span>
        <div className="ml-auto flex gap-2">
          {s.status === "running" && (
            <Button size="sm" variant="outline" onClick={() => send([{ type: "user.interrupt" }])}><Square /> Interrupt</Button>
          )}
          {!s.archived_at && <BudgetDialog session={s} />}
          {!s.archived_at && s.status !== "running" && (
            <Button size="sm" variant="outline" onClick={archive}><Archive /> Archive</Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-h-0 flex-col rounded-lg border bg-card">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto grid max-w-3xl gap-3 p-4">
              {!loaded && <p className="text-sm text-muted-foreground">Loading events…</p>}
              {loaded && events.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No events yet. Send the first message below.</p>}
              <Transcript
                events={primaryEvents}
                lookup={events}
                threadNames={threadNames}
                onOpenThread={openThread}
                onConfirm={(toolUseId, result) => send([{ type: "user.tool_confirmation", tool_use_id: toolUseId, result }])}
              />
              {s.status === "running" && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Working…</div>
              )}
              <div ref={bottom} />
            </div>
          </div>
          <Composer session={s} onSend={(text) => send([{ type: "user.message", content: [{ type: "text", text }] }])} />
          {error && <p className="border-t px-4 py-2 text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex min-h-0 flex-col rounded-lg border bg-card">
          <Tabs value={inspector} onValueChange={(v) => setParams({ inspector: v }, { replace: true })} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="m-2">
              <TabsTrigger value="session">Session</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
              <TabsTrigger value="tools">Tools</TabsTrigger>
              <TabsTrigger value="outputs">Outputs</TabsTrigger>
              {threadNames.size > 0 && <TabsTrigger value="threads">Threads <Badge variant="secondary" className="ml-1 h-4 px-1">{threadNames.size}</Badge></TabsTrigger>}
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TabsContent value="session" className="px-4 pb-4"><SessionTab session={s} events={events} /></TabsContent>
              <TabsContent value="events" className="px-2 pb-4"><EventsTab events={events} /></TabsContent>
              <TabsContent value="tools" className="px-4 pb-4"><ToolsTab session={s} events={events} /></TabsContent>
              <TabsContent value="outputs" className="px-4 pb-4"><OutputsTab sessionId={s.id} events={events} /></TabsContent>
              <TabsContent value="threads" className="px-4 pb-4"><ThreadsTab sessionId={s.id} running={s.status === "running"} onOpen={openThread} /></TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- transcript */

function Transcript({ events, lookup, threadNames, onOpenThread, onConfirm }: {
  events: Ev[];
  /** All session events, for finding results of tool calls shown here. */
  lookup?: Ev[];
  threadNames?: Map<string, string>;
  onOpenThread?: (threadId: string) => void;
  onConfirm: (toolUseId: string, result: "allow" | "deny") => void;
}) {
  const all = lookup ?? events;
  const results = useMemo(() => {
    const m = new Map<string, Ev>();
    for (const e of all) {
      if (e.type === "agent.tool_result") m.set(String(e.tool_use_id), e);
      if (e.type === "user.custom_tool_result") m.set(String(e.custom_tool_use_id), e);
      if (e.type === "agent.mcp_tool_result") m.set(String(e.mcp_tool_use_id), e);
    }
    return m;
  }, [all]);
  const confirmed = useMemo(() => new Map(all.filter((e) => e.type === "user.tool_confirmation").map((e) => [String(e.tool_use_id), String(e.result)])), [all]);
  const lastIdleId = useMemo(() => events.filter((e) => e.type === "session.status_idle").at(-1)?.id, [events]);

  return (
    <>
      {events.map((e) => {
        switch (e.type) {
          case "user.message":
            return (
              <div key={e.id} className="ml-auto max-w-[85%] break-words rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                <div className="mb-1 flex items-center gap-1 text-xs opacity-70"><User className="size-3" /> You · {time(e.processed_at)}</div>
                <div className="whitespace-pre-wrap">{textOf(e)}</div>
              </div>
            );
          case "agent.message":
            return (
              <div key={e.id} className="max-w-[90%] rounded-lg border bg-background px-3 py-2 text-sm">
                <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground"><Bot className="size-3" /> Agent · {time(e.processed_at)}</div>
                <div className="whitespace-pre-wrap">{textOf(e)}</div>
              </div>
            );
          case "agent.thinking":
            return <Collapsible key={e.id} label="Thinking" body={String(e.thinking ?? "")} muted />;
          case "agent.tool_use":
          case "agent.custom_tool_use":
          case "agent.mcp_tool_use":
            return (
              <ToolCard key={e.id} use={e} result={results.get(e.id)} confirmation={confirmed.get(e.id)} onConfirm={onConfirm}
                threadName={e.session_thread_id ? threadNames?.get(String(e.session_thread_id)) ?? "Sub-agent" : undefined} />
            );
          case "agent.thread_message_sent":
            return (
              <div key={e.id} className="max-w-[90%] rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm">
                <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <Users className="size-3" /> Delegated to <b className="text-foreground">{String(e.to_agent_name ?? "sub-agent")}</b> · {time(e.processed_at)}
                  {onOpenThread && (
                    <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={() => onOpenThread(String(e.to_session_thread_id))}>
                      View thread
                    </Button>
                  )}
                </div>
                <div className="whitespace-pre-wrap">{textOf(e)}</div>
              </div>
            );
          case "agent.thread_message_received":
            return (
              <div key={e.id} className="max-w-[90%] rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm">
                <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <CornerDownLeft className="size-3" /> <b className="text-foreground">{String(e.from_agent_name ?? "Sub-agent")}</b> replied · {time(e.processed_at)}
                </div>
                <div className="max-h-48 overflow-y-auto whitespace-pre-wrap">{textOf(e)}</div>
              </div>
            );
          case "agent.thread_context_compacted":
            return <Divider key={e.id} text="Context compacted" />;
          case "session.error":
            return (
              <div key={e.id} className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span><b>{String(e.error?.type ?? "error")}</b>: {String(e.error?.message ?? "")}</span>
              </div>
            );
          case "session.status_idle": {
            const t = e.stop_reason?.type;
            if (t === "budget_reached") return <Divider key={e.id} text="Budget reached. Raise the budget to continue." tone="warn" />;
            if (t === "requires_action") return e.id === lastIdleId ? <Divider key={e.id} text="Waiting for you" tone="warn" /> : null;
            if (t === "retries_exhausted") return <Divider key={e.id} text="Stopped after an error" tone="warn" />;
            return null;
          }
          case "user.interrupt":
            return <Divider key={e.id} text="Interrupted" />;
          default:
            return null;
        }
      })}
    </>
  );
}

function Divider({ text, tone }: { text: string; tone?: "warn" }) {
  return (
    <div className={cn("flex items-center gap-2 text-xs", tone === "warn" ? "text-amber-600" : "text-muted-foreground")}>
      <div className="h-px flex-1 bg-border" /> {text} <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function Collapsible({ label, body, muted }: { label: string; body: string; muted?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("rounded-md border text-sm", muted && "text-muted-foreground")}>
      <button className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} {label}
      </button>
      {open && <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t px-3 py-2 font-mono text-xs">{body}</pre>}
    </div>
  );
}

function summarize(name: string, input: Record<string, unknown>): string {
  if (name === "bash") return String(input.command ?? "");
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern);
  if (input.url) return String(input.url);
  return JSON.stringify(input);
}

function ToolCard({ use, result, confirmation, onConfirm, threadName }: {
  use: Ev; result?: Ev; confirmation?: string; onConfirm: (id: string, r: "allow" | "deny") => void; threadName?: string;
}) {
  const [open, setOpen] = useState(false);
  const custom = use.type === "agent.custom_tool_use";
  const mcpServer = use.type === "agent.mcp_tool_use" ? String(use.mcp_server_name) : null;
  const name = String(use.name);
  const waitingApproval = !custom && use.evaluated_permission === "ask" && !result && !confirmation;
  const output = result ? textOf(result) : "";
  return (
    <div className={cn("rounded-md border text-sm", result?.is_error && "border-destructive/40")}>
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        {name === "bash" ? <Terminal className="size-4 shrink-0" /> : custom || mcpServer ? <Wrench className="size-4 shrink-0" /> : <FileText className="size-4 shrink-0" />}
        <span className="font-medium">{mcpServer && <span className="text-muted-foreground">{mcpServer} · </span>}{name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{summarize(name, (use.input as Record<string, unknown>) ?? {})}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs">
          {custom && <Badge variant="outline">custom</Badge>}
          {mcpServer && <Badge variant="outline">MCP</Badge>}
          {threadName && <Badge variant="secondary"><Users className="size-3" /> {threadName}</Badge>}
          {use.evaluated_permission === "ask" && <Badge variant="outline">ask</Badge>}
          {confirmation === "deny" && <Badge variant="destructive">Denied</Badge>}
          {result?.x_interrupted && <Badge variant="outline">Interrupted</Badge>}
          {result && !result.is_error && <Check className="size-3.5 text-emerald-600" />}
          {result?.is_error && !result.x_interrupted && confirmation !== "deny" && <X className="size-3.5 text-destructive" />}
          {!result && !waitingApproval && !custom && <Loader2 className="size-3.5 animate-spin" />}
          {typeof result?.x_duration_ms === "number" && <span className="text-muted-foreground">{result.x_duration_ms} ms</span>}
        </span>
      </button>
      {waitingApproval && (
        <div className="flex items-center gap-2 border-t bg-amber-50 px-3 py-2 dark:bg-amber-950/30">
          <span className="text-xs">This tool needs your approval.</span>
          <Button size="sm" className="ml-auto h-7" onClick={() => onConfirm(use.id, "allow")}><Check /> Approve</Button>
          <Button size="sm" variant="outline" className="h-7" onClick={() => onConfirm(use.id, "deny")}><X /> Deny</Button>
        </div>
      )}
      {custom && !result && <div className="border-t px-3 py-2 text-xs text-muted-foreground">Waiting for your application to return this custom tool's result.</div>}
      {open && (
        <div className="grid gap-2 border-t px-3 py-2">
          <pre className="overflow-auto whitespace-pre-wrap font-mono text-xs">{JSON.stringify(use.input, null, 2)}</pre>
          {result && <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-xs">{output}</pre>}
        </div>
      )}
    </div>
  );
}

function Composer({ session, onSend }: { session: Session; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const blocked =
    session.archived_at ? "This session is archived."
    : session.stop_reason?.type === "requires_action" ? "Approve or deny the pending tool calls first."
    : session.stop_reason?.type === "budget_reached" ? "The budget is used up."
    : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || blocked) return;
    setBusy(true);
    await onSend(text.trim());
    setText("");
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className="flex items-end gap-2 border-t p-3">
      <Textarea
        rows={2}
        value={text}
        disabled={Boolean(blocked) || busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit(e as unknown as FormEvent);
          }
        }}
        placeholder={blocked ?? "Send a message to the agent (Enter to send, Shift+Enter for a new line)"}
        className="min-h-12 resize-none"
      />
      <Button type="submit" size="icon" disabled={Boolean(blocked) || busy || !text.trim()} aria-label="Send"><Send /></Button>
    </form>
  );
}

/* ---------------------------------------------------------------- inspector */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function SessionTab({ session: s, events }: { session: Session; events: Ev[] }) {
  const costSeries = useMemo(() => {
    let total = 0;
    return events
      .filter((e) => e.type === "span.model_request_end")
      .map((e) => {
        total += Number(e.model_usage?.cost_usd ?? 0);
        return { t: time(e.processed_at), cost: Number(total.toFixed(6)) };
      });
  }, [events]);
  return (
    <div className="grid gap-4">
      <div>
        <Row label="ID"><span className="font-mono text-xs">{s.id}</span></Row>
        <Row label="Status">{s.status}{s.stop_reason ? ` (${s.stop_reason.type})` : ""}</Row>
        <Row label="Created">{new Date(s.created_at).toLocaleString()}</Row>
        <Row label="Agent">{s.agent.name} v{s.agent.version}</Row>
        <Row label="Model"><span className="font-mono text-xs">{s.agent.model.id}</span></Row>
        <Row label="Environment"><span className="font-mono text-xs">{s.environment_id}</span></Row>
        <Row label="Runs on">{s.runs_on}</Row>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between text-sm font-medium">
          <span>Cost</span>
          <span>{formatUsd(s.usage.cost_usd)}{s.budget ? ` / ${formatUsd(Number(s.budget.max_list_cost.amount) / 100)}` : ""}</span>
        </div>
        <div className="h-32">
          {costSeries.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={costSeries}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="t" fontSize={10} tickLine={false} axisLine={false} />
                <YAxis fontSize={10} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(v) => formatUsd(Number(v))} />
                <Area type="stepAfter" dataKey="cost" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.15} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-muted-foreground">No cost tracked yet.</p>
          )}
        </div>
      </div>
      <div>
        <div className="mb-1 text-sm font-medium">Usage</div>
        <Row label="Input">{s.usage.input_tokens.toLocaleString()}</Row>
        <Row label="Output">{s.usage.output_tokens.toLocaleString()}</Row>
        <Row label="Cache read">{s.usage.cache_read_input_tokens.toLocaleString()}</Row>
        <Row label="Cache write">{s.usage.cache_creation_input_tokens.toLocaleString()}</Row>
        <Row label="Active time">{Math.round(s.usage.active_seconds)}s</Row>
      </div>
      {Object.keys(s.metadata).length > 0 && (
        <div>
          <div className="mb-1 text-sm font-medium">Metadata</div>
          {Object.entries(s.metadata).map(([k, v]) => <Row key={k} label={k}><span className="font-mono text-xs">{v}</span></Row>)}
        </div>
      )}
    </div>
  );
}

function preview(e: Ev): string {
  if (e.type === "agent.tool_use" || e.type === "agent.custom_tool_use") return `${e.name} ${summarize(String(e.name), e.input ?? {})}`;
  if (e.type === "agent.mcp_tool_use") return `${e.mcp_server_name} · ${e.name} ${JSON.stringify(e.input ?? {})}`;
  if (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") return textOf(e).slice(0, 80);
  if (e.type === "span.model_request_end") {
    const u = e.model_usage ?? {};
    return `${u.input_tokens ?? 0} in · ${u.output_tokens ?? 0} out · ${u.cache_read_input_tokens ?? 0} cached`;
  }
  if (e.type === "session.status_idle") return e.stop_reason?.type ?? "";
  if (e.type === "session.usage") return `${formatUsd(e.usage?.cost_usd ?? 0)}`;
  return textOf(e).slice(0, 80);
}

function EventsTab({ events }: { events: Ev[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const shown = events.filter((e) => !filter || e.type.includes(filter));
  const color = (t: string) => (t.startsWith("user") ? "text-pink-600" : t.startsWith("agent") ? "text-blue-600" : t.startsWith("span") ? "text-violet-600" : "text-muted-foreground");
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2 px-2 pb-2">
        <input className="h-8 flex-1 rounded-md border bg-background px-2 text-sm" placeholder="Filter by type…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(JSON.stringify(events, null, 2))}><Copy /> Copy</Button>
      </div>
      {shown.map((e) => (
        <div key={e.id} className="rounded px-2 py-1 hover:bg-accent/50">
          <button className="grid w-full grid-cols-[1fr_auto] gap-2 text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
            <span className="min-w-0">
              <span className={cn("font-mono text-xs", color(e.type))}>{e.type}</span>
              <span className="ml-2 truncate text-xs text-muted-foreground">{preview(e)}</span>
            </span>
            <span className="text-xs text-muted-foreground">{time(e.processed_at)}</span>
          </button>
          {open === e.id && <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px]">{JSON.stringify(e, null, 2)}</pre>}
        </div>
      ))}
    </div>
  );
}

function ToolsTab({ session, events }: { session: Session; events: Ev[] }) {
  const rows = useMemo(() => {
    const byId = new Map(events.filter((e) => e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result")
      .map((e) => [String(e.tool_use_id ?? e.mcp_tool_use_id), e]));
    const stats = new Map<string, { calls: number; failed: number; denied: number; durations: number[]; permission: string }>();
    for (const e of events.filter((e) => ["agent.tool_use", "agent.custom_tool_use", "agent.mcp_tool_use"].includes(e.type))) {
      const name = e.type === "agent.mcp_tool_use" ? `${e.mcp_server_name} · ${e.name}` : String(e.name);
      const st = stats.get(name) ?? { calls: 0, failed: 0, denied: 0, durations: [], permission: e.type === "agent.custom_tool_use" ? "custom" : String(e.evaluated_permission ?? "") };
      st.calls++;
      const r = byId.get(e.id);
      if (r?.is_error) st.failed++;
      if (typeof r?.x_duration_ms === "number") st.durations.push(r.x_duration_ms);
      stats.set(name, st);
    }
    for (const c of events.filter((e) => e.type === "user.tool_confirmation" && e.result === "deny")) {
      const use = events.find((e) => e.id === c.tool_use_id);
      if (use) stats.get(use.type === "agent.mcp_tool_use" ? `${use.mcp_server_name} · ${use.name}` : String(use.name))!.denied++;
    }
    return [...stats.entries()].map(([name, st]) => {
      const d = [...st.durations].sort((a, b) => a - b);
      return { name, ...st, p50: d.length ? d[Math.floor(d.length / 2)] : null };
    });
  }, [events]);
  const total = rows.reduce((a, r) => a + r.calls, 0);
  const failed = rows.reduce((a, r) => a + r.failed, 0);
  return (
    <div className="grid gap-3">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr><th className="py-1">Tool</th><th>Permission</th><th className="text-right">Calls</th><th className="text-right">Failed</th><th className="text-right">p50</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t">
              <td className="py-1 font-mono text-xs">{r.name}</td>
              <td className="text-xs">{r.permission}</td>
              <td className="text-right">{r.calls}</td>
              <td className={cn("text-right", r.failed && "text-destructive")}>{r.failed}</td>
              <td className="text-right text-xs">{r.p50 != null ? `${r.p50} ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No tool calls yet.</p>}
      <div className="rounded-md border p-3 text-sm">
        <div className="flex justify-between"><span>Calls</span><span>{total}</span></div>
        <div className="flex justify-between"><span>Failed</span><span>{failed}</span></div>
        <div className="flex justify-between"><span>Active time</span><span>{Math.round(session.usage.active_seconds)}s</span></div>
      </div>
    </div>
  );
}

function OutputsTab({ sessionId, events }: { sessionId: string; events: Ev[] }) {
  const toolResults = events.filter((e) => e.type === "agent.tool_result").length;
  const outputs = useQuery({
    queryKey: ["outputs", sessionId, toolResults],
    queryFn: () => api<{ data: Array<{ path: string; size_bytes: number; modified_at: string }> }>(`/v1/sessions/${sessionId}/outputs`),
  });
  return (
    <div className="grid gap-1">
      {outputs.data?.data.length === 0 && <p className="text-sm text-muted-foreground">No files in /mnt/session/outputs yet.</p>}
      {outputs.data?.data.map((f) => (
        <a
          key={f.path}
          href={`/v1/sessions/${sessionId}/outputs/content?path=${encodeURIComponent(f.path)}`}
          className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
        >
          <FileText className="size-4 shrink-0" />
          <span className="truncate font-mono text-xs">{f.path}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{(f.size_bytes / 1024).toFixed(1)} kB · {timeAgo(f.modified_at)}</span>
          <Download className="size-3.5 shrink-0" />
        </a>
      ))}
    </div>
  );
}

/** Set, raise or remove the session's spending limit. Raising it resumes a session paused at its budget. */
function BudgetDialog({ session: s }: { session: Session }) {
  const qc = useQueryClient();
  const current = s.budget ? Number(s.budget.max_list_cost.amount) / 100 : null;
  const spent = Number(s.usage.cost_usd);
  const paused = s.stop_reason?.type === "budget_reached";
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(budget: unknown) {
    setSaving(true);
    setError(null);
    try {
      const updated = await api<Session>(`/v1/sessions/${s.id}`, { method: "POST", json: { budget } });
      qc.setQueryData(["session", s.id], updated);
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not update the budget.");
    } finally {
      setSaving(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const dollars = Number(value);
    if (!(dollars > 0)) return setError("Enter a positive dollar amount.");
    if (dollars <= spent) return setError(`The session has already spent ${formatUsd(spent)}; the new budget must be higher.`);
    void save({ type: "limit", max_list_cost: { amount: String(Math.round(dollars * 100)), currency: "USD" } });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setError(null);
        setValue(current ? String(Math.max(current * 2, spent + 1).toFixed(2)) : "");
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant={paused ? "default" : "outline"}><Wallet /> {paused ? "Raise budget" : "Budget"}</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Session budget</DialogTitle>
            <DialogDescription>
              Spent so far: {formatUsd(spent)}{current != null ? ` of ${formatUsd(current)}` : " (no limit)"}.
              {paused && " The session is paused at its budget; raising it resumes the work."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="budget">Budget in $</Label>
            <Input id="budget" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="5.00" autoFocus />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="sm:justify-between">
            {current != null ? (
              <Button type="button" variant="ghost" disabled={saving} onClick={() => save(null)}>Remove limit</Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save budget"}</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Sub-agent threads of this session (CMA session threads). */
function ThreadsTab({ sessionId, running, onOpen }: { sessionId: string; running: boolean; onOpen: (id: string) => void }) {
  const threads = useQuery({
    queryKey: ["session", sessionId, "threads"],
    queryFn: () => api<Page<SessionThread>>(`/v1/sessions/${sessionId}/threads?limit=100`),
    refetchInterval: running ? 2000 : false,
  });
  if (!threads.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="grid gap-2">
      {threads.data.data.map((t) => (
        <button key={t.id} onClick={() => onOpen(t.id)} className="grid gap-1 rounded-md border px-3 py-2 text-left text-sm hover:bg-accent/50">
          <div className="flex items-center gap-2">
            <Users className="size-4 shrink-0" />
            <span className="font-medium">{t.agent.name}</span>
            <Badge variant={t.status === "running" ? "default" : "outline"} className="ml-auto capitalize">{t.status}</Badge>
          </div>
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span className="font-mono">{t.id}</span>
            <span>{formatUsd(t.usage.cost_usd)}</span>
            <span>{formatTokens(t.usage.input_tokens + t.usage.cache_read_input_tokens)} / {formatTokens(t.usage.output_tokens)} tokens</span>
          </div>
        </button>
      ))}
    </div>
  );
}

/** One sub-agent's own transcript, in a side sheet. */
function ThreadSheet({ sessionId, threadId, name, events, onClose, onConfirm }: {
  sessionId: string;
  threadId: string | null;
  name: string;
  events: Ev[];
  onClose: () => void;
  onConfirm: (toolUseId: string, result: "allow" | "deny") => void;
}) {
  const threadEvents = useMemo(
    () => (threadId ? events.filter((e) => e.session_thread_id === threadId && !e.type.startsWith("session.thread_")) : []),
    [events, threadId],
  );
  const task = events.find((e) => e.type === "agent.thread_message_sent" && e.to_session_thread_id === threadId);
  return (
    <Sheet open={Boolean(threadId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2"><Users className="size-4" /> {name}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{threadId} · session {sessionId}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-3 px-4 pb-6">
          {task && (
            <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
              <div className="mb-1 text-xs opacity-70">Task from the lead agent</div>
              {textOf(task)}
            </div>
          )}
          {threadEvents.length === 0 && <p className="text-sm text-muted-foreground">No events yet.</p>}
          <Transcript events={threadEvents} lookup={events} onConfirm={onConfirm} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
