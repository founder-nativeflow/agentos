/**
 * Runs sessions on @truefoundry/trueforge-core's AgentThread (the default runtime;
 * AGENTOS_RUNTIME=classic selects AgentOS's original loop in runner.ts).
 *
 * AgentOS keeps everything around the loop: the CMA API and event log, the
 * sandbox (Docker/E2B), egress, MCP connections, vaults, files and budgets.
 * TrueForge runs the model ↔ tool loop and context management (compaction).
 * This file translates between the two:
 *   in:  user.message / user.tool_confirmation / user.custom_tool_result
 *   out: span.*, session.usage, agent.thinking, agent.message,
 *        agent.(custom_|mcp_)tool_use, agent.(mcp_)tool_result,
 *        agent.thread_context_compacted, idle reasons.
 *
 * Sub-agents: with CMA `multiagent.subagents` enabled, the model can delegate to inline
 * sub-agents (trueforge DynamicSubAgents + AgentThreadOrchestrator). Each becomes a CMA
 * session thread: session.thread_created, agent.thread_message_sent/received and
 * session.thread_status_* on the primary thread, and its own events tagged with
 * session_thread_id.
 *
 * All threads' state is saved after every step (sessions.runtime_state) and restored
 * on demand, so sessions continue across API restarts.
 *
 * trueforge-core makes no compatibility promises: it is pinned to an exact
 * version, and this adapter is the only code that touches it.
 */
import { createRequire } from "node:module";
import winston from "winston";
import { core } from "@truefoundry/trueforge-core";
import type { Agent, Session, SessionEvent, SessionThread, StopReason } from "@agentos/types";
import { newId, nowIso } from "../../lib/ids.js";
import type { Store } from "../../lib/store.js";
import { listModels } from "../../lib/openrouter.js";
import { openRouterKey } from "../model.js";
import { callMcpTool } from "../mcp.js";
import type { Sandbox } from "../sandbox.js";
import { evaluate, runBuiltin, type ResolvedTool } from "../tools.js";
import { proxiedBaseUrl } from "./openrouter-proxy.js";

type AgentThread = InstanceType<typeof core.AgentThread>;
type Json = Record<string, unknown>;

const MAIN = "main";
const MAX_STEPS = 50;
const DEFAULT_MAX_TOKENS = Number(process.env.AGENTOS_MAX_OUTPUT_TOKENS ?? 8192);
/** trueforge-core's dynamic sub-agent tool (DynamicSubAgents capability). */
const SUB_AGENT_TOOL = "create_sub_agent";
export const TRUEFORGE_VERSION: string = createRequire(import.meta.url)("@truefoundry/trueforge-core/package.json").version;

const logger = winston.createLogger({
  level: process.env.AGENTOS_TF_LOG_LEVEL ?? "error",
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

/** No-op tracing (AgentOS records its own spans as events). */
const tracing = {
  withInitSpan: <T>(op: () => Promise<T>) => op(),
  startRootSpan() {
    const span = {
      runInContext: <T>(op: () => T) => op(),
      startSubAgent: () => span,
      setOutput() {}, setMetrics() {}, setError() {}, setSuccess() {}, end() {},
    };
    return span;
  },
  withLocalToolSpan: <T>(_i: unknown, op: (s: { setOutput(): void; setSandboxId(): void }) => Promise<T>) =>
    op({ setOutput() {}, setSandboxId() {} }),
  withRemoteMcpToolSpan: <T>(_i: unknown, op: (s: { setOutput(): void; setNumberOfTools(): void }) => Promise<T>) =>
    op({ setOutput() {}, setNumberOfTools() {} }),
};

// TrueForge blocks private/loopback model URLs (SSRF guard). Model calls go to our own
// loopback OpenRouter proxy (openrouter-proxy.ts), so allow exactly that host.
core.configureOutboundUrlGuard({ enabled: true, allowedHosts: ["127.0.0.1"], blockedHosts: [] });

const textOf = (blocks: unknown): string =>
  Array.isArray(blocks) ? blocks.map((b) => (b && typeof b === "object" && "text" in b ? String((b as Json).text) : "")).join("\n") : String(blocks ?? "");

/**
 * AgentOS's tools as one TrueForge tool set. Names stay exactly as AgentOS
 * exposes them (bash, read, …, custom tools, mcp__server__tool), and the
 * AgentOS permission policy decides approvals.
 */
class AgentOSToolSet {
  readonly name = "agentos";
  readonly id = "agentos";
  readonly serverClass = "local" as const;
  readonly description = "AgentOS tools";
  readonly preload = true;
  readonly hasPreloadedTools = true;
  tools: ResolvedTool[] = [];
  sandbox!: Sandbox;
  signal!: AbortSignal;
  allowedHosts: string[] | null = null;
  /** Outcome of each executed call, keyed by name + input (tool.response carries neither is_error nor timing). */
  private outcomes = new Map<string, Array<{ isError: boolean; ms: number }>>();

  constructor(private sessionId: string) {}

  private key(name: string, input: unknown) {
    return `${name}\u0000${JSON.stringify(input ?? {})}`;
  }

  takeOutcome(name: string, input: unknown) {
    return this.outcomes.get(this.key(name, input))?.shift();
  }

  async listTools() {
    return {
      result: {
        tools: this.tools.map((t) => ({
          name: t.name,
          description: t.def.function.description,
          inputSchema: { type: "object" as const, ...(t.def.function.parameters as Json) },
          preload: true,
        })),
      },
      wasInitialized: undefined,
    };
  }

  async toolCallInfo(params: { name: string }) {
    const t = this.tools.find((x) => x.name === params.name);
    return {
      type: "mcp" as const,
      mcp_server_id: this.id,
      mcp_server_name: this.name,
      original_tool_name: params.name,
      is_approval_required: t ? t.kind !== "custom" && evaluate(t) === "ask" : false,
      is_client_side: t?.kind === "custom",
    };
  }

  async callTool(params: { name: string; arguments?: Json }, decision?: { status: "allow" } | { status: "deny"; reason?: string }) {
    const t = this.tools.find((x) => x.name === params.name);
    const input = params.arguments ?? {};
    if (!t) return core.toolResultResponse({ text: `Unknown tool: ${params.name}`, isError: true });
    if (t.kind === "custom") return { clientSideToolRequired: { tool_info: await this.toolCallInfo(params) } };
    if (evaluate(t) === "ask" && !decision) return { approvalRequired: { tool_info: await this.toolCallInfo(params) } };
    if (decision?.status === "deny") {
      this.record(t.name, input, true, 0);
      return core.toolResultResponse({ text: `The user denied this tool call.${decision.reason ? ` Reason: ${decision.reason}` : ""}`, isError: true });
    }
    const t0 = Date.now();
    let out: { text: string; isError: boolean };
    try {
      out = t.kind === "mcp"
        ? await callMcpTool(this.sessionId, t.mcp!.server, t.mcp!.tool, input, this.signal)
        : await runBuiltin(t.name, input, this.sandbox, { signal: this.signal, allowedHosts: this.allowedHosts });
    } catch (err) {
      out = { text: this.signal.aborted ? "Interrupted" : `Tool failed: ${(err as Error).message}`, isError: true };
    }
    this.record(t.name, input, out.isError, Date.now() - t0);
    return core.toolResultResponse({ text: out.text || "(no output)", isError: out.isError });
  }

  private record(name: string, input: unknown, isError: boolean, ms: number) {
    const k = this.key(name, input);
    this.outcomes.set(k, [...(this.outcomes.get(k) ?? []), { isError, ms }]);
  }

  setApprovalPolicy() {}
  getApprovalPolicies() {
    return {};
  }
}

/** A tool call the adapter is tracking, keyed by `${trueforge thread}|${tool_call_id}` (jsonb rejects \u0000). */
interface ToolMeta {
  eventId: string;
  kind: ResolvedTool["kind"] | "unknown" | "subagent";
  name: string;
  input: Json;
  tfThread: string;
}

/** The CMA session thread that mirrors a trueforge sub-agent thread. */
interface CmaThread {
  id: string;
  name: string;
}

interface SessionState {
  /** trueforge thread id → thread ("main" is the session's primary thread). */
  threads: Map<string, AgentThread>;
  orchestrator: InstanceType<typeof core.AgentThreadOrchestrator>;
  toolset: AgentOSToolSet;
  rootDefinition: Json;
  calls: Map<string, ToolMeta>;
  byEvent: Map<string, { tfThread: string; tcId: string }>;
  cma: Map<string, CmaThread>;
  /** Cost already charged, per in-memory thread (a rebuilt thread's metrics restart at 0). */
  costSeen: Map<string, number>;
  /** The last turn stopped at the budget; continue when it is raised. */
  needsResume: boolean;
}

type Snapshot = ReturnType<AgentThread["toSnapshot"]>;

/** What is saved in sessions.runtime_state. */
interface SavedState {
  v: 2;
  trueforge: string;
  threads: Snapshot[];
  cma: Array<[string, CmaThread]>;
  calls: Array<[string, ToolMeta]>;
  needsResume: boolean;
}

/** v1 (single thread, before sub-agents) → v2. */
function upgradeState(saved: unknown): SavedState | null {
  const s = saved as { v?: number } | null;
  if (!s) return null;
  if (s.v === 2) return s as SavedState;
  if (s.v === 1) {
    const v1 = s as { trueforge: string; snapshot: Snapshot; calls: Array<[string, Omit<ToolMeta, "tfThread">]>; needsResume: boolean };
    return {
      v: 2,
      trueforge: v1.trueforge,
      threads: [v1.snapshot],
      cma: [],
      calls: v1.calls.map(([tc, m]) => [`${MAIN}|${tc}`, { ...m, tfThread: MAIN }]),
      needsResume: v1.needsResume,
    };
  }
  return null;
}

const callKey = (tfThread: string, tcId: string) => `${tfThread}|${tcId}`;

export interface TurnContext {
  session: Session;
  agent: Agent;
  instruction: string;
  tools: ResolvedTool[];
  sandbox: Sandbox;
  allowedHosts: string[] | null;
  signal: AbortSignal;
  events: SessionEvent[];
  emit(fields: Json & { type: string }): Promise<SessionEvent>;
  setRunning(): Promise<void>;
  setIdle(stop: StopReason): Promise<void>;
  saveSession(): Promise<void>;
  overBudget(): boolean;
  /** Closes unanswered tool calls and idles the session (interrupt). */
  interrupted(): Promise<void>;
  markProcessed(eventId: string): Promise<void>;
  loadState(): Promise<unknown>;
  saveState(state: unknown): Promise<void>;
  threadStore: Pick<Store["threads"], "insert" | "update" | "get">;
}

/** cancel() is for sub-agent threads only; a thread's open calls are closed instead. */
function closeOpenCalls(thread: AgentThread, why: string) {
  for (const _ of thread.closeAllOpenToolCalls({ toolIdToClosureMessages: new Map(), defaultToolClosureContent: why })) void _;
}

/** Price per token from the OpenRouter catalog: only used when the provider reports no cost. */
async function estimateCost(model: string, u: { input_tokens: number; output_tokens: number; cache_read_tokens?: number }) {
  const m = (await listModels().catch(() => [])).find((x) => x.id === model);
  if (!m) return 0;
  const cached = u.cache_read_tokens ?? 0;
  const p = (s: string | undefined) => Number(s ?? 0) || 0;
  return (u.input_tokens - cached) * p(m.pricing.prompt) + cached * p(m.pricing.input_cache_read ?? m.pricing.prompt) + u.output_tokens * p(m.pricing.completion);
}

/** Compaction: on unless AGENTOS_COMPACTION=off; threshold from the model's context length unless set. */
function compactionCapabilities(definition: Json): unknown[] {
  if (process.env.AGENTOS_COMPACTION === "off") return [];
  const threshold = Number(process.env.AGENTOS_COMPACTION_THRESHOLD_TOKENS) || undefined;
  return [core.contextCompaction({ definition: definition as never, ...(threshold ? { compactionThresholdTokens: threshold } : {}) })];
}

/** Inline sub-agents are on when the agent's CMA multiagent config enables them. */
function subagentsEnabled(agent: Agent): boolean {
  const sub = agent.multiagent?.subagents;
  return agent.multiagent?.type === "multiagent_20261001" && sub?.type === "enabled" && sub.inline_agents?.type !== "disabled";
}

/** A sub-agent's definition: the parent's tools and model, its task as the first user message. */
function childDefinition(root: Json, info: { name: string; input: string }): Json {
  return {
    ...root,
    instruction: `${core.SUB_AGENT_IDENTITY}\n\n${String(root.instruction ?? "")}`,
    messages: [{ role: "user", content: info.input }],
  };
}

function newThreadRow(ctx: TurnContext, id: string, name: string, parentCma: string | null, system: string): SessionThread {
  const now = nowIso();
  return {
    type: "session_thread",
    id,
    session_id: ctx.session.id,
    parent_thread_id: parentCma,
    workflow_run_id: null,
    agent: {
      type: "inline", name, description: null, system, model: ctx.agent.model,
      tools: ctx.agent.tools, mcp_servers: ctx.agent.mcp_servers, skills: [],
    },
    status: "running",
    stop_reason: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cost_usd: "0", active_seconds: 0 },
    stats: {},
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
}

export class TrueForgeEngine {
  private states = new Map<string, SessionState>();

  private async state(ctx: TurnContext): Promise<SessionState> {
    const cached = this.states.get(ctx.session.id);
    if (cached) return cached;

    const toolset = new AgentOSToolSet(ctx.session.id);
    const model = ctx.agent.model;
    const effort = typeof model.effort === "string" ? model.effort : model.effort?.type;
    const contextLength = (await listModels().catch(() => [])).find((m) => m.id === model.id)?.context_length ?? undefined;
    const llm = new core.VercelAILLM({
      providerConfig: {
        provider: { type: "custom", name: "openrouter" },
        model: { id: model.id, name: model.id },
        name: "openrouter",
        baseUrl: await proxiedBaseUrl(model),
        apiKey: openRouterKey(),
        headers: { "HTTP-Referer": "https://agentos.dev", "X-Title": "AgentOS" },
      },
      logger,
    });
    const rootDefinition: Json = {
      modelClient: llm,
      modelName: model.id,
      modelProperties: { contextLength },
      instruction: ctx.instruction,
      modelParams: { max_tokens: model.max_tokens ?? DEFAULT_MAX_TOKENS, ...(effort ? { reasoning_effort: effort } : {}) },
      iterationLimit: MAX_STEPS,
      toolSets: [toolset as never],
    };
    const rootCapabilities = () => [
      ...compactionCapabilities(rootDefinition),
      ...(subagentsEnabled(ctx.agent) ? [core.dynamicSubAgents({ sandboxAvailable: true, tracing: tracing as never })] : []),
    ];

    const raw = (await ctx.loadState()) as { v?: number } | null;
    const saved = upgradeState(raw);
    if (raw && !saved) console.warn(`[trueforge] session ${ctx.session.id}: saved state v${raw.v} is not supported; starting fresh`);

    const threads = new Map<string, AgentThread>();
    const cma = new Map(saved?.cma ?? []);
    const rootSnap = saved?.threads.find((t) => !t.parent);
    threads.set(MAIN, new core.AgentThread({
      definition: rootDefinition as never,
      capabilities: rootCapabilities() as never,
      threadId: MAIN,
      title: ctx.session.title ?? ctx.session.id,
      ...(rootSnap ? { context: rootSnap.context, currentContextUsage: rootSnap.current_context_usage, capabilityState: rootSnap.capability_state ?? undefined } : {}),
      tracing: tracing as never,
      logger,
    }));
    // Sub-agent threads that were still open (e.g. waiting for an approval).
    for (const snap of saved?.threads.filter((t) => t.parent && t.agent_info) ?? []) {
      const info = snap.agent_info!;
      const def = childDefinition(rootDefinition, info);
      threads.set(snap.thread_id, new core.AgentThread({
        definition: def as never,
        capabilities: compactionCapabilities(def) as never,
        threadId: snap.thread_id,
        title: cma.get(snap.thread_id)?.name ?? info.name,
        parent: snap.parent!,
        agentInfo: info,
        context: snap.context,
        currentContextUsage: snap.current_context_usage,
        capabilityState: snap.capability_state ?? undefined,
        ...(snap.completion ? { preComputedCompletion: snap.completion } : {}),
        tracing: tracing as never,
        logger,
      }));
    }

    const orchestrator = new core.AgentThreadOrchestrator({
      agentThreads: threads,
      tracing: tracing as never,
      logger,
      createDynamicSubAgentThread: async ({ parentDefinition, request, threadId, parent }) => {
        const def = childDefinition(parentDefinition as unknown as Json, request);
        return new core.AgentThread({
          definition: def as never,
          capabilities: compactionCapabilities(def) as never, // depth 1: sub-agents can't spawn sub-agents
          threadId,
          title: request.name,
          parent,
          agentInfo: request,
          tracing: tracing as never,
          logger,
        });
      },
    });

    const calls = new Map(saved?.calls ?? []);
    const st: SessionState = {
      threads,
      orchestrator,
      toolset,
      rootDefinition,
      calls,
      byEvent: new Map([...calls].map(([key, m]) => [m.eventId, { tfThread: m.tfThread, tcId: key.slice(m.tfThread.length + 1) }])),
      cma,
      costSeen: new Map(),
      needsResume: saved?.needsResume ?? false,
    };
    this.states.set(ctx.session.id, st);
    return st;
  }

  private async persist(ctx: TurnContext, st: SessionState) {
    const state: SavedState = {
      v: 2,
      trueforge: TRUEFORGE_VERSION,
      threads: [...st.threads.values()].map((t) => t.toSnapshot()),
      cma: [...st.cma],
      calls: [...st.calls],
      needsResume: st.needsResume,
    };
    await ctx.saveState(state);
  }

  /** Drops the in-memory threads (they are restored from the saved state next time). */
  forget(sessionId: string): void {
    this.states.delete(sessionId);
  }

  private isOpen(st: SessionState, tfThread: string, tcId: string): boolean {
    return st.threads.get(tfThread)?.hasOpenToolCallId(tcId) ?? false;
  }

  /** Thread-scoped fields for an event emitted on behalf of a sub-agent thread. */
  private tag(st: SessionState, tfThread: string): Json {
    return tfThread === MAIN ? {} : { session_thread_id: st.cma.get(tfThread)?.id ?? null };
  }

  async turn(ctx: TurnContext): Promise<void> {
    const st = await this.state(ctx);
    const { toolset, orchestrator } = st;
    toolset.tools = ctx.tools;
    toolset.sandbox = ctx.sandbox;
    toolset.allowedHosts = ctx.allowedHosts;

    const answered = (meta: ToolMeta) =>
      ctx.events.some((e) =>
        (e.type === "agent.tool_result" && e.tool_use_id === meta.eventId) ||
        (e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id === meta.eventId) ||
        (e.type === "user.custom_tool_result" && e.custom_tool_use_id === meta.eventId && e.x_interrupted));

    // Calls AgentOS already closed (e.g. interrupted while waiting) must be closed in their thread too.
    for (const [key, meta] of st.calls) {
      const tcId = key.slice(meta.tfThread.length + 1);
      if (meta.kind !== "subagent" && answered(meta) && this.isOpen(st, meta.tfThread, tcId)) {
        closeOpenCalls(st.threads.get(meta.tfThread)!, "Interrupted by the user");
      }
    }

    // Calls that were running when AgentOS stopped (crash/restart) can never finish: record an
    // error result and close them. (Calls waiting for approval or already confirmed are kept.)
    const orphaned = [...st.calls].filter(([key, meta]) => {
      const tcId = key.slice(meta.tfThread.length + 1);
      if (meta.kind === "custom" || meta.kind === "subagent" || !this.isOpen(st, meta.tfThread, tcId)) return false;
      const confirmed = ctx.events.some((x) => x.type === "user.tool_confirmation" && x.tool_use_id === meta.eventId);
      const askedForApproval = ctx.events.find((x) => x.id === meta.eventId)?.evaluated_permission === "ask";
      return !answered(meta) && !confirmed && !askedForApproval;
    });
    if (orphaned.length) {
      const why = "Interrupted: AgentOS restarted while this tool was running";
      for (const [, meta] of orphaned) {
        const fields = { is_error: true, content: [{ type: "text", text: why }], x_interrupted: true, ...this.tag(st, meta.tfThread) };
        if (meta.kind === "mcp") await ctx.emit({ type: "agent.mcp_tool_result", mcp_tool_use_id: meta.eventId, ...fields });
        else await ctx.emit({ type: "agent.tool_result", tool_use_id: meta.eventId, ...fields });
        closeOpenCalls(st.threads.get(meta.tfThread)!, why);
      }
      await this.persist(ctx, st);
    }

    // Inbound events. Resumes (approvals, client tool results) go to the thread that owns the
    // call, and only while it is still open, which also makes this idempotent across restarts.
    const resumes: Json[] = [];
    const messages: Json[] = [];
    for (const e of ctx.events) {
      if (e.type === "user.tool_confirmation" || e.type === "user.custom_tool_result") {
        const target = st.byEvent.get(String(e.type === "user.tool_confirmation" ? e.tool_use_id : e.custom_tool_use_id));
        if (!target || !this.isOpen(st, target.tfThread, target.tcId) || resumes.some((r) => r.tool_call_id === target.tcId && r.thread_id === target.tfThread)) continue;
        if (e.type === "user.tool_confirmation") {
          resumes.push({
            type: "user.tool_approval", thread_id: target.tfThread, tool_call_id: target.tcId,
            approval: e.result === "deny" ? { status: "deny", ...(e.deny_message ? { reason: String(e.deny_message) } : {}) } : { status: "allow" },
          });
        } else {
          const body = textOf(e.content) || "(no output)";
          resumes.push({ type: "user.tool_response", thread_id: target.tfThread, tool_call_id: target.tcId, content: e.is_error ? `Error: ${body}` : body });
        }
      } else if (e.type === "user.message" && !e.processed_at) {
        messages.push({ type: "user.message", content: textOf(e.content) });
        await ctx.markProcessed(e.id);
      }
    }
    if (ctx.session.stop_reason?.type === "budget_reached") return;
    const batch = resumes.length ? resumes : messages;
    // Raising the budget resumes a session that stopped at it, as in CMA.
    const resumeOnly = !batch.length && st.needsResume && !ctx.overBudget();
    if (!batch.length && !resumeOnly) return;
    st.needsResume = false;

    await ctx.emit({ type: "session.status_running" });
    await ctx.setRunning();

    const budget = new AbortController();
    const signal = AbortSignal.any([ctx.signal, budget.signal]);
    toolset.signal = signal;
    const seen = new Set<string>();
    const waitFor: string[] = [];
    const starts = new Map<string, { id: string; t0: number }>();
    let failure: string | null = null;
    let budgetHit = false;

    const onEvent = async (e: Json): Promise<void> => {
      const type = String(e.type);
      if (type === "internal.agent.context.append") {
        for (const o of (e.output as Json[]) ?? []) await onEvent(o);
        return;
      }
      const tf = typeof e.thread_id === "string" ? e.thread_id : MAIN;
      if (e.id && seen.has(String(e.id)) && type !== "model.message") return;

      if (type === "model.message" && !("usage" in e) && !e.content && !e.tool_calls) {
        // Start of a model call (any thread).
        if (ctx.overBudget()) {
          budgetHit = true;
          budget.abort();
          return;
        }
        starts.set(tf, { id: (await ctx.emit({ type: "span.model_request_start", ...this.tag(st, tf) })).id, t0: Date.now() });
        return;
      }
      if (type === "model.message") {
        if (seen.has(String(e.id))) return;
        seen.add(String(e.id));
        await this.onModelMessage(ctx, st, e, tf, starts.get(tf) ?? null);
        starts.delete(tf);
        await this.persist(ctx, st);
        return;
      }
      if (type === "tool.response") {
        if (seen.has(String(e.id))) return;
        seen.add(String(e.id));
        await this.onToolResponse(ctx, st, e, tf);
        await this.persist(ctx, st);
        return;
      }
      if (type === "thread.created") {
        if (seen.has(String(e.id))) return;
        seen.add(String(e.id));
        await this.onThreadCreated(ctx, st, e);
        await this.persist(ctx, st);
        return;
      }
      if (type === "internal.agent.done" && e.parent) {
        const key = `done:${tf}`;
        if (seen.has(key)) return;
        seen.add(key);
        await this.onChildDone(ctx, st, e, tf);
        return;
      }
      if (type === "thread.context_compaction_finished") {
        if (e.id) seen.add(String(e.id));
        await ctx.emit({ type: "agent.thread_context_compacted", ...this.tag(st, tf) });
        await this.chargeUnbilled(ctx, st, tf);
        await this.persist(ctx, st);
        return;
      }
      if (type === "tool.approval_required" || type === "tool.response_required") {
        for (const tc of (e.tool_calls as Array<{ id: string }>) ?? []) {
          const meta = st.calls.get(callKey(tf, tc.id));
          if (meta && !waitFor.includes(meta.eventId)) waitFor.push(meta.eventId);
        }
        return;
      }
      if (type === "internal.agent.done" && !e.parent && e.status === "error") failure = String(e.error ?? "Agent failed");
    };

    try {
      if (batch.length) for await (const e of orchestrator.send(batch as never)) await onEvent(e as unknown as Json);
      for await (const e of orchestrator.execute({ signal })) await onEvent(e as unknown as Json);
    } catch (err) {
      if (!signal.aborted) failure = (err as Error).message;
    }

    try {
      if (ctx.signal.aborted) {
        // Stop everything: sub-agents are terminated, every open call is closed.
        for (const [tf, thread] of [...st.threads]) {
          closeOpenCalls(thread, "Interrupted by the user");
          if (tf !== MAIN) {
            await this.endThread(ctx, st, tf, "terminated", null);
            st.threads.delete(tf);
          }
        }
        return await ctx.interrupted();
      }
      if (budgetHit) {
        st.needsResume = true;
        return await ctx.setIdle({ type: "budget_reached" });
      }
      if (failure) {
        await ctx.emit({ type: "session.error", error: { type: "model_request_failed_error", message: failure } });
        return await ctx.setIdle({ type: "retries_exhausted" });
      }
      if (waitFor.length) return await ctx.setIdle({ type: "requires_action", event_ids: waitFor });
      return await ctx.setIdle({ type: "end_turn" });
    } finally {
      await this.persist(ctx, st);
    }
  }

  /* ----------------------------------------------------------- sub-agents */

  private async onThreadCreated(ctx: TurnContext, st: SessionState, e: Json) {
    const tf = String(e.thread_id);
    const info = e.agent_info as { name: string; input: string };
    const parentTf = (e.parent as { thread_id: string } | undefined)?.thread_id ?? MAIN;
    const id = newId("thread");
    st.cma.set(tf, { id, name: info.name });
    const def = childDefinition(st.rootDefinition, info);
    await ctx.threadStore.insert(newThreadRow(ctx, id, info.name, parentTf === MAIN ? null : (st.cma.get(parentTf)?.id ?? null), String(def.instruction)));
    await ctx.emit({ type: "session.thread_created", session_thread_id: id, agent_name: info.name, workflow_run_id: null });
    await ctx.emit({ type: "agent.thread_message_sent", to_session_thread_id: id, to_agent_name: info.name, content: [{ type: "text", text: info.input }] });
    await ctx.emit({ type: "session.thread_status_running", session_thread_id: id, agent_name: info.name });
  }

  private async onChildDone(ctx: TurnContext, st: SessionState, e: Json, tf: string) {
    const thread = st.cma.get(tf);
    if (!thread) return;
    const status = String(e.status);
    const output = e.output as { content?: unknown } | undefined;
    const text =
      status === "done" ? (typeof output?.content === "string" ? output.content : textOf(output?.content)) || "(no output)"
      : status === "error" ? `Sub-agent failed: ${String(e.error ?? "unknown error")}`
      : `Sub-agent cancelled: ${String(e.reason ?? "")}`;
    await ctx.emit({ type: "agent.thread_message_received", from_session_thread_id: thread.id, from_agent_name: thread.name, content: [{ type: "text", text }] });
    if (status === "cancelled") await this.endThread(ctx, st, tf, "terminated", null);
    else await this.endThread(ctx, st, tf, "idle", { type: status === "done" ? "end_turn" : "retries_exhausted" });
  }

  /** Marks a CMA thread idle/terminated and emits its status event. */
  private async endThread(ctx: TurnContext, st: SessionState, tf: string, status: "idle" | "terminated", stop: StopReason | null) {
    const thread = st.cma.get(tf);
    if (!thread) return;
    const row = await ctx.threadStore.get(ctx.session.id, thread.id);
    if (row) {
      row.status = status;
      row.stop_reason = stop;
      row.updated_at = nowIso();
      row.stats.duration_seconds = Math.round((Date.now() - new Date(row.created_at).getTime()) / 1000);
      await ctx.threadStore.update(row);
    }
    if (status === "terminated") {
      await ctx.emit({ type: "session.thread_status_terminated", session_thread_id: thread.id, agent_name: thread.name });
    } else {
      await ctx.emit({ type: "session.thread_status_idle", session_thread_id: thread.id, agent_name: thread.name, stop_reason: stop, stop_details: null });
    }
  }

  /* ----------------------------------------------------------- cost + events */

  /** Cost a thread's metrics report beyond what's already charged (e.g. compaction calls). */
  private async chargeUnbilled(ctx: TurnContext, st: SessionState, tf: string) {
    const total = st.threads.get(tf)?.getAgentThreadMetrics().total_cost_in_usd;
    const seen = st.costSeen.get(tf) ?? 0;
    if (typeof total !== "number" || total <= seen) return;
    ctx.session.usage.cost_usd = (Number(ctx.session.usage.cost_usd) + (total - seen)).toFixed(6);
    st.costSeen.set(tf, total);
    await ctx.emit({ type: "session.usage", usage: ctx.session.usage, budget: ctx.session.budget });
    await ctx.saveSession();
  }

  private async onModelMessage(ctx: TurnContext, st: SessionState, e: Json, tf: string, start: { id: string; t0: number } | null) {
    const s = ctx.session;
    const u = (e.usage as { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number } | undefined) ?? {
      input_tokens: 0, output_tokens: 0,
    };
    // Exact cost: the OpenRouter proxy passes usage.cost through as the field trueforge-core sums.
    const total = st.threads.get(tf)?.getAgentThreadMetrics().total_cost_in_usd;
    let cost: number;
    if (typeof total === "number") {
      cost = Math.max(total - (st.costSeen.get(tf) ?? 0), 0);
      st.costSeen.set(tf, total);
    } else {
      cost = await estimateCost(ctx.agent.model.id, u);
    }
    const cached = u.cache_read_tokens ?? 0;
    const usage = {
      input_tokens: Math.max(u.input_tokens - cached, 0),
      output_tokens: u.output_tokens,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: u.cache_write_tokens ?? 0,
    };
    const seconds = start ? (Date.now() - start.t0) / 1000 : 0;
    s.usage.input_tokens += usage.input_tokens;
    s.usage.output_tokens += usage.output_tokens;
    s.usage.cache_read_input_tokens += usage.cache_read_input_tokens;
    s.usage.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    s.usage.cost_usd = (Number(s.usage.cost_usd) + cost).toFixed(6);
    s.usage.active_seconds += seconds;
    const tag = this.tag(st, tf);
    if (start) {
      await ctx.emit({ type: "span.model_request_end", model_request_start_id: start.id, is_error: false,
        model: ctx.agent.model.id, model_usage: { ...usage, cost_usd: cost }, ...tag });
    }
    await ctx.emit({ type: "session.usage", usage: s.usage, budget: s.budget });
    await ctx.saveSession();
    if (tf !== MAIN) {
      const cmaId = st.cma.get(tf)?.id;
      const row = cmaId ? await ctx.threadStore.get(s.id, cmaId) : null;
      if (row) {
        row.usage.input_tokens += usage.input_tokens;
        row.usage.output_tokens += usage.output_tokens;
        row.usage.cache_read_input_tokens += usage.cache_read_input_tokens;
        row.usage.cost_usd = (Number(row.usage.cost_usd) + cost).toFixed(6);
        row.usage.active_seconds += seconds;
        row.updated_at = nowIso();
        await ctx.threadStore.update(row);
      }
    }

    if (typeof e.reasoning_content === "string" && e.reasoning_content.trim()) {
      await ctx.emit({ type: "agent.thinking", thinking: e.reasoning_content, ...tag });
    }
    const content = typeof e.content === "string" ? e.content : textOf(e.content);
    if (content.trim()) await ctx.emit({ type: "agent.message", content: [{ type: "text", text: content }], ...tag });

    for (const tc of (e.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>) ?? []) {
      const name = tc.function.name;
      let input: Json = {};
      let badJson = false;
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        badJson = true;
      }
      if (name === SUB_AGENT_TOOL && subagentsEnabled(ctx.agent)) {
        // Represented in CMA by session.thread_created / agent.thread_message_sent, not a tool use.
        st.calls.set(callKey(tf, tc.id), { eventId: `subagent:${tc.id}`, kind: "subagent", name, input, tfThread: tf });
        continue;
      }
      const t = ctx.tools.find((x) => x.name === name);
      let ev: SessionEvent;
      if (t?.kind === "custom") {
        ev = await ctx.emit({ type: "agent.custom_tool_use", name, input, ...tag });
      } else if (t?.kind === "mcp") {
        ev = await ctx.emit({ type: "agent.mcp_tool_use", name: t.mcp!.tool, mcp_server_name: t.mcp!.server, input,
          evaluated_permission: evaluate(t), ...tag });
      } else {
        ev = await ctx.emit({ type: "agent.tool_use", name, input, evaluated_permission: !t || badJson ? "deny" : evaluate(t),
          ...(t ? {} : { x_unknown_tool: true }), ...tag });
      }
      st.calls.set(callKey(tf, tc.id), { eventId: ev.id, kind: t?.kind ?? "unknown", name, input, tfThread: tf });
      st.byEvent.set(ev.id, { tfThread: tf, tcId: tc.id });
    }
  }

  private async onToolResponse(ctx: TurnContext, st: SessionState, e: Json, tf: string) {
    const meta = st.calls.get(callKey(tf, String(e.tool_call_id)));
    // Custom results are the client's user.custom_tool_result; sub-agent results are thread messages.
    if (!meta || meta.kind === "custom" || meta.kind === "subagent") return;
    const text = String(e.content ?? "") || "(no output)";
    const outcome = st.toolset.takeOutcome(meta.name, meta.input);
    const isError = outcome?.isError ?? /denied|error|unknown tool|invalid|interrupted|stopped/i.test(text.slice(0, 120));
    const fields = { is_error: isError, content: [{ type: "text", text }], ...(outcome ? { x_duration_ms: outcome.ms } : {}), ...this.tag(st, tf) };
    if (meta.kind === "mcp") await ctx.emit({ type: "agent.mcp_tool_result", mcp_tool_use_id: meta.eventId, ...fields });
    else await ctx.emit({ type: "agent.tool_result", tool_use_id: meta.eventId, ...fields });
  }
}
