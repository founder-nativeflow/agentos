import type { SessionEvent, Workflow, WorkflowEdge, WorkflowNode, WorkflowRun, WorkflowStepState } from "@agentos/types";
import { badRequest } from "../lib/errors.js";
import { newId, nowIso } from "../lib/ids.js";
import { RateLimitError } from "../lib/limits.js";
import { resolveOpenRouterKey } from "../lib/provider-keys.js";
import { storeScope } from "../lib/scope.js";
import type { Store } from "../lib/store.js";
import { callModel } from "./model.js";
import type { SessionRuntime } from "./runner.js";
import { createSession } from "./session-service.js";

/**
 * Workflow engine (AgentOS extension).
 *
 * A run walks the graph from the Start step. A step becomes ready when every incoming
 * connection is settled; it runs if at least one of them is *active* (its source succeeded
 * and, for a Condition or Router, the connection is the branch it chose), otherwise it is
 * skipped. Ready steps run in parallel. Agent steps are ordinary sessions, so their
 * transcripts, approvals and cost are all visible in the Console.
 */

export const BUILDER_DEFAULT_MODEL = () => process.env.AGENTOS_BUILDER_MODEL ?? "qwen/qwen3-coder";
const STEP_TIMEOUT_MS = () => Number(process.env.AGENTOS_WORKFLOW_STEP_TIMEOUT_MS ?? 30 * 60_000);
const POLL_MS = 400;

/** JSON with sorted object keys: Postgres jsonb doesn't keep key order, so compare with this. */
export const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val));

/* ------------------------------------------------------------- validation */

const ID_RE = /^[a-z][a-z0-9_]{0,47}$/;
const REF_RE = /\{\{\s*nodes\.([a-zA-Z0-9_]+)\.output\s*\}\}/g;

export function templateRefs(t: string): string[] {
  return [...t.matchAll(REF_RE)].map((m) => m[1]!);
}

function templatesOf(n: WorkflowNode): string[] {
  switch (n.type) {
    case "agent": return [n.prompt];
    case "condition": return [n.source];
    case "router": return [n.source];
    case "output": return [n.template];
    default: return [];
  }
}

/** Ancestors of each node (by following edges backwards). */
function ancestors(nodes: WorkflowNode[], edges: WorkflowEdge[]): Map<string, Set<string>> {
  const parents = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.target === n.id).map((e) => e.source)]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    if (memo.has(id)) return memo.get(id)!;
    const out = new Set<string>();
    memo.set(id, out);
    for (const p of parents.get(id) ?? []) {
      out.add(p);
      for (const a of visit(p)) out.add(a);
    }
    return out;
  };
  for (const n of nodes) visit(n.id);
  return memo;
}

/** Returns a list of problems; empty when the graph is runnable. */
export function workflowProblems(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!ID_RE.test(n.id)) problems.push(`Step id "${n.id}" must be lowercase letters, digits and _ (starting with a letter)`);
    if (ids.has(n.id)) problems.push(`Step id "${n.id}" is used twice`);
    ids.add(n.id);
  }
  const starts = nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) problems.push(`A workflow needs exactly one Start step (found ${starts.length})`);
  for (const e of edges) {
    if (!ids.has(e.source)) problems.push(`Connection ${e.id} starts at unknown step "${e.source}"`);
    if (!ids.has(e.target)) problems.push(`Connection ${e.id} ends at unknown step "${e.target}"`);
    if (e.source === e.target) problems.push(`Connection ${e.id} connects "${e.source}" to itself`);
  }
  if (problems.length) return problems;

  // Cycles (Kahn).
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indeg.set(e.target, indeg.get(e.target)! + 1);
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen++;
    for (const e of edges.filter((x) => x.source === id)) {
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (indeg.get(e.target) === 0) queue.push(e.target);
    }
  }
  if (seen !== nodes.length) problems.push("The workflow has a loop; connections must flow one way");

  const start = starts[0]!;
  for (const e of edges) if (e.target === start.id) problems.push("Nothing can connect into the Start step");
  const anc = ancestors(nodes, edges);
  for (const n of nodes) {
    if (n.type !== "start" && !anc.get(n.id)!.has(start.id)) problems.push(`Step "${n.label}" (${n.id}) isn't reachable from Start`);
    const out = edges.filter((e) => e.source === n.id);
    if (n.type === "condition") {
      for (const e of out) if (e.branch !== "true" && e.branch !== "false") problems.push(`Connections from condition "${n.id}" need branch "true" or "false"`);
      if (!out.length) problems.push(`Condition "${n.id}" has no outgoing connections`);
    } else if (n.type === "router") {
      const keys = new Set(n.routes.map((r) => r.key));
      if (n.routes.length < 2) problems.push(`Router "${n.id}" needs at least two routes`);
      for (const e of out) if (!e.branch || !keys.has(e.branch)) problems.push(`Connection ${e.id} from router "${n.id}" needs a branch that is one of its routes (${[...keys].join(", ")})`);
    } else {
      for (const e of out) if (e.branch) problems.push(`Connection ${e.id} has a branch, but "${n.id}" isn't a condition or router`);
    }
    if (n.type === "output" && out.length) problems.push(`Output step "${n.id}" can't have outgoing connections`);
    if (n.type === "agent" && !n.prompt.trim()) problems.push(`Agent step "${n.id}" needs a prompt`);
    for (const t of templatesOf(n)) {
      if (/\{%|%\}/.test(t)) problems.push(`Step "${n.id}" uses {% ... %} logic; templates only substitute {{input}} and {{nodes.<id>.output}} (use a condition or router step to branch)`);
      for (const m of t.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
        if (m[1] !== "input" && !/^nodes\.[a-zA-Z0-9_]+\.output$/.test(m[1]!)) {
          problems.push(`Step "${n.id}" uses {{${m[1]}}}; only {{input}} and {{nodes.<id>.output}} are available`);
        }
      }
      for (const ref of templateRefs(t)) {
        if (!ids.has(ref)) problems.push(`Step "${n.id}" refers to unknown step "${ref}"`);
        else if (!anc.get(n.id)!.has(ref)) problems.push(`Step "${n.id}" refers to "${ref}", which doesn't run before it`);
      }
    }
  }
  return problems;
}

export function assertRunnable(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  const p = workflowProblems(nodes, edges);
  if (p.length) throw badRequest(`The workflow isn't valid: ${p.join("; ")}`);
}

/* -------------------------------------------------------------- templates */

export function render(t: string, input: string, steps: Record<string, WorkflowStepState>): string {
  return t
    .replace(/\{\{\s*input\s*\}\}/g, input)
    .replace(REF_RE, (_m, id: string) => steps[id]?.output ?? "");
}

export function evaluateCondition(n: Extract<WorkflowNode, { type: "condition" }>, value: string): boolean {
  const v = value.trim();
  switch (n.operator) {
    case "contains": return v.toLowerCase().includes(n.value.toLowerCase());
    case "not_contains": return !v.toLowerCase().includes(n.value.toLowerCase());
    case "equals": return v.toLowerCase() === n.value.trim().toLowerCase();
    case "matches":
      try {
        return new RegExp(n.value, "i").test(v);
      } catch {
        throw new Error(`Condition "${n.id}" has an invalid pattern: ${n.value}`);
      }
  }
}

/* ------------------------------------------------------------------ runs */

const active = new Map<string, AbortController>();

export function cancelRun(id: string): boolean {
  const c = active.get(id);
  if (!c) return false;
  c.abort();
  return true;
}

export async function startWorkflowRun(
  store: Store,
  runtime: SessionRuntime,
  wf: Workflow,
  input: string,
  trigger: WorkflowRun["trigger"] = { type: "manual" },
): Promise<WorkflowRun> {
  if (wf.archived_at) throw badRequest("This workflow is archived");
  assertRunnable(wf.nodes, wf.edges);
  const run: WorkflowRun = {
    type: "workflow_run",
    id: newId("workflowExecution"),
    workflow_id: wf.id,
    workflow_version: wf.version,
    status: "running",
    input,
    output: null,
    error: null,
    steps: Object.fromEntries(wf.nodes.map((n) => [n.id, { status: "pending" }])),
    cost_usd: "0.000000",
    trigger,
    created_at: nowIso(),
    ended_at: null,
  };
  await store.workflowRuns.insert(run);
  const controller = new AbortController();
  active.set(run.id, controller);
  void storeScope.run(store, () => execute(store, runtime, wf, run, controller.signal))
    .catch(async (err) => {
      run.status = "failed";
      run.error = { type: "api_error", message: (err as Error).message };
      run.ended_at = nowIso();
      await store.workflowRuns.update(run).catch(() => {});
    })
    .finally(() => active.delete(run.id));
  return run;
}

async function execute(store: Store, runtime: SessionRuntime, wf: Workflow, run: WorkflowRun, signal: AbortSignal) {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const incoming = (id: string) => wf.edges.filter((e) => e.target === id);
  const settled = (id: string) => ["succeeded", "skipped", "failed"].includes(run.steps[id]!.status);
  const edgeActive = (e: WorkflowEdge) => {
    const s = run.steps[e.source]!;
    if (s.status !== "succeeded") return false;
    const src = byId.get(e.source)!;
    return src.type === "condition" || src.type === "router" ? s.branch === e.branch : true;
  };
  let saving = Promise.resolve();
  const save = () => (saving = saving.then(() => store.workflowRuns.update(run)));
  const running = new Map<string, Promise<void>>();
  let failure: string | null = null;

  while (true) {
    if (signal.aborted) break;
    let progress = 0; // steps started or skipped in this pass
    for (const n of wf.nodes) {
      const st = run.steps[n.id]!;
      if (st.status !== "pending" || running.has(n.id)) continue;
      const ins = incoming(n.id);
      if (n.type !== "start" && !ins.every((e) => settled(e.source))) continue;
      progress++;
      if ((n.type !== "start" && !ins.some(edgeActive)) || failure) {
        st.status = "skipped";
        continue;
      }
      st.status = "running";
      st.started_at = nowIso();
      const p = runStep(store, runtime, wf, run, n, signal)
        .then((r) => {
          Object.assign(st, r, { status: "succeeded", ended_at: nowIso() });
        })
        .catch((err: Error) => {
          const cost = (err as Error & { cost?: string }).cost;
          Object.assign(st, { status: "failed", error: err.message, ended_at: nowIso(), ...(cost ? { cost_usd: Number(cost).toFixed(6) } : {}) });
          failure ??= `Step "${n.label}" failed: ${err.message}`;
        })
        .finally(() => {
          running.delete(n.id);
          run.cost_usd = Object.values(run.steps).reduce((a, s) => a + Number(s.cost_usd ?? 0), 0).toFixed(6);
          void save();
        });
      running.set(n.id, p);
    }
    await save();
    if (!running.size) {
      if (!progress) break;
      continue; // what just finished or was skipped may have made more steps ready
    }
    await Promise.race([...running.values(), new Promise((r) => signal.addEventListener("abort", r, { once: true }))]);
  }

  if (signal.aborted) {
    for (const st of Object.values(run.steps)) {
      if (st.status === "pending") st.status = "skipped";
      if (st.status === "running") Object.assign(st, { status: "failed", error: "Cancelled", ended_at: nowIso() });
    }
    // Stop the sessions of steps that were running.
    for (const st of Object.values(run.steps)) {
      if (st.session_id && st.error === "Cancelled") {
        const s = await store.sessions.get(st.session_id);
        if (s) await runtime.receive(s, [{ type: "user.interrupt" }]).catch(() => {});
      }
    }
    await Promise.allSettled(running.values());
    run.status = "cancelled";
  } else if (failure) {
    run.status = "failed";
    run.error = { type: "workflow_step_failed", message: failure };
  } else {
    run.status = "succeeded";
    // The result: the Output step(s) that ran, else the last agent step to finish.
    const outputs = wf.nodes.filter((n) => n.type === "output" && run.steps[n.id]!.status === "succeeded");
    const last = Object.entries(run.steps)
      .filter(([id, s]) => s.status === "succeeded" && byId.get(id)!.type === "agent")
      .sort((a, b) => String(a[1].ended_at).localeCompare(String(b[1].ended_at)))
      .pop();
    run.output = outputs.length ? outputs.map((n) => run.steps[n.id]!.output ?? "").join("\n\n") : (last?.[1].output ?? null);
  }
  run.ended_at = nowIso();
  await save();
}

async function runStep(
  store: Store,
  runtime: SessionRuntime,
  wf: Workflow,
  run: WorkflowRun,
  n: WorkflowNode,
  signal: AbortSignal,
): Promise<Partial<WorkflowStepState>> {
  switch (n.type) {
    case "start":
      return { output: run.input };
    case "output":
      return { output: render(n.template, run.input, run.steps) };
    case "condition": {
      const value = render(n.source, run.input, run.steps);
      const ok = evaluateCondition(n, value);
      return { branch: ok ? "true" : "false", output: ok ? "true" : "false" };
    }
    case "router":
      return route(store, n, render(n.source, run.input, run.steps), signal);
    case "agent":
      return agentStep(store, runtime, wf, run, n, signal);
  }
}

async function route(store: Store, n: Extract<WorkflowNode, { type: "router" }>, text: string, signal: AbortSignal) {
  const list = n.routes.map((r) => `- ${r.key}: ${r.description}`).join("\n");
  const res = await callModel(
    { id: n.model ?? BUILDER_DEFAULT_MODEL(), max_tokens: 256 },
    [
      { role: "system", content: `AgentOS workflow router. Choose the single best route for the input. Reply with only the route key.\nRoutes:\n${list}` },
      { role: "user", content: text.slice(0, 20_000) },
    ],
    [],
    signal,
    await resolveOpenRouterKey(store),
  );
  const reply = (res.text ?? "").trim().toLowerCase();
  const pick = n.routes.find((r) => reply === r.key.toLowerCase()) ?? n.routes.find((r) => reply.includes(r.key.toLowerCase()));
  if (!pick) throw new Error(`The router's model didn't choose a known route (replied "${reply.slice(0, 80)}")`);
  return { branch: pick.key, output: pick.key, cost_usd: res.usage.cost_usd.toFixed(6) };
}

async function agentStep(
  store: Store,
  runtime: SessionRuntime,
  wf: Workflow,
  run: WorkflowRun,
  n: Extract<WorkflowNode, { type: "agent" }>,
  signal: AbortSignal,
) {
  const prompt = render(n.prompt, run.input, run.steps);
  const deadline = Date.now() + STEP_TIMEOUT_MS();
  let session;
  // Wait for a free slot when the workspace is at its running-sessions limit.
  while (!session) {
    try {
      session = await createSession(store, runtime, {
        agent: { type: "agent", id: n.agent.id, ...(n.agent.version ? { version: n.agent.version } : {}) },
        environment_id: wf.environment_id,
        vault_ids: wf.vault_ids,
        title: `${wf.name} · ${n.label}`,
        metadata: { "agentos.workflow_run": run.id, "agentos.workflow_step": n.id },
        initial_events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
      });
    } catch (err) {
      if (!(err instanceof RateLimitError) || Date.now() > deadline || signal.aborted) throw err;
      await sleep(5000, signal);
    }
  }
  run.steps[n.id]!.session_id = session.id;
  await store.workflowRuns.update(run);

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("Cancelled");
    await sleep(POLL_MS, signal);
    const s = await store.sessions.get(session.id);
    if (!s) throw new Error("The step's session was deleted");
    if (s.status !== "idle" || !s.stop_reason) continue;
    if (s.stop_reason.type === "requires_action") continue; // waiting for someone to approve a tool call
    const events = (await store.events.list(session.id)).map((e) => e.event as SessionEvent & Record<string, unknown>);
    const main = events.filter((e) => !e.session_thread_id);
    const err = [...main].reverse().find((e) => e.type === "session.error");
    const lastMsg = [...main].reverse().find((e) => e.type === "agent.message");
    const text = ((lastMsg?.content as Array<{ type: string; text?: string }>) ?? []).map((b) => b.text ?? "").join("");
    const cost = s.usage.cost_usd;
    if (s.stop_reason.type !== "end_turn" || (!lastMsg && err)) {
      const why = (err?.error as { message?: string } | undefined)?.message ?? `the session stopped (${s.stop_reason.type})`;
      throw Object.assign(new Error(why), { cost });
    }
    return { output: text, cost_usd: Number(cost).toFixed(6) };
  }
  throw new Error(`Timed out after ${Math.round(STEP_TIMEOUT_MS() / 60_000)} min`);
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
  });
}
