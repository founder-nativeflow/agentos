import { z } from "zod";
import type {
  Agent, BuilderChat, BuilderPlan, BuilderWorkflowNode, Environment, Workflow, WorkflowEdge, WorkflowNode,
} from "@agentos/types";
import { badRequest, conflict } from "../lib/errors.js";
import { newId, nowIso } from "../lib/ids.js";
import { listModels } from "../lib/openrouter.js";
import { resolveOpenRouterKey } from "../lib/provider-keys.js";
import type { Store } from "../lib/store.js";
import { edgeSchema, nodeSchema } from "../routes/workflows.js";
import { callModel, ModelError } from "./model.js";
import type { SessionRuntime } from "./runner.js";
import { SANDBOX_PROVIDER } from "./sandbox.js";
import { createSession } from "./session-service.js";
import { BUILDER_DEFAULT_MODEL, stableJson, startWorkflowRun, workflowProblems } from "./workflows.js";

/**
 * The builder (AgentOS extension). A short request in a chat becomes a structured plan
 * (BuilderPlan): what to build (one agent, a team, or a workflow), the reasoning steps,
 * assumptions, the agents with their prompts and tools, the environment and, for a
 * workflow, its graph. Every turn returns the whole revised plan; the server validates it
 * (schema + graph rules), asks the model to repair it once if needed, lays the graph out,
 * and stores it. Nothing is created until the user applies the plan.
 */

/* ---------------------------------------------------------------- schema */

const builderNode = z.union([
  nodeSchema.options[0], // start
  z.object({
    id: z.string().min(1).max(48),
    label: z.string().min(1).max(120),
    position: z.object({ x: z.number(), y: z.number() }).nullish(),
    type: z.literal("agent"),
    agent_key: z.string().min(1),
    prompt: z.string().min(1).max(50_000),
  }),
  nodeSchema.options[2], // condition
  nodeSchema.options[3], // router
  nodeSchema.options[4], // output
]);

export const planSchema = z.object({
  kind: z.enum(["agent", "team", "workflow"]),
  title: z.string().min(1).max(120),
  summary: z.string().max(2000),
  steps: z.array(z.object({ title: z.string().max(200), detail: z.string().max(2000) })).max(20).default([]),
  assumptions: z.array(z.string().max(500)).max(20).default([]),
  open_questions: z.array(z.string().max(500)).max(10).default([]),
  agents: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
        name: z.string().min(1).max(120),
        description: z.string().max(1000).default(""),
        model: z.string().min(1).max(200),
        system: z.string().min(1).max(30_000),
        toolset: z.boolean().default(true),
        subagents: z.boolean().default(false),
        mcp_servers: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), url: z.string().url() })).max(10).default([]),
      }),
    )
    .min(1)
    .max(12),
  environment: z
    .object({
      name: z.string().min(1).max(120),
      networking: z.enum(["unrestricted", "limited"]).default("unrestricted"),
      allowed_hosts: z.array(z.string().max(253)).max(50).default([]),
      pip: z.array(z.string().max(100)).max(30).default([]),
      npm: z.array(z.string().max(100)).max(30).default([]),
    })
    .default({ name: "Default", networking: "unrestricted", allowed_hosts: [], pip: [], npm: [] }),
  workflow: z
    .object({
      name: z.string().min(1).max(256),
      description: z.string().max(2048).default(""),
      nodes: z.array(builderNode).min(2).max(60),
      edges: z.array(edgeSchema).max(200),
    })
    .nullable()
    .default(null),
  test_input: z.string().max(20_000).default(""),
});

const turnSchema = z.object({
  reply: z.string().min(1).max(4000),
  changes: z.array(z.string().max(300)).max(20).default([]),
  plan: planSchema,
});

/* ---------------------------------------------------------------- prompt */

function systemPrompt(defaultModel: string, models: string[]): string {
  return `You are the AgentOS builder. People describe, often in one sentence, an agent or an automation they want. You turn that into a complete, structured, buildable plan. You never run anything yourself; the person reviews the plan and clicks Create.

## Decide what to build (plan.kind)
- "agent": one agent can do the job in a single conversation (research, writing, coding, analysis).
- "team": open-ended work that benefits from delegation; one lead agent with "subagents": true that spins up helpers as it goes. Use when the steps aren't known in advance.
- "workflow": the work has known, repeatable steps, branches or hand-offs between specialists (triage → route → act; extract → review → publish). Each step is an agent; branches use a condition or router.
Prefer the simplest kind that does the job well.

## Think in this order (fill plan.steps with these, one or two sentences each, specific to the request)
1. Goal: what outcome the person wants and who uses it.
2. Inputs: what each run starts from (a ticket, a URL, a file, a question). This becomes the Start step and test_input.
3. Shape: which kind and why; for a workflow, the stages and where it branches.
4. Agents: each agent's single responsibility, its model, and its tools.
5. Data flow: what each step passes on, and which exact text later steps depend on.
6. Safety and setup: network access, packages, credentials the person must add (as open_questions), anything risky.
7. Testing: a realistic test_input that exercises the main path.

## Agents (plan.agents)
- key: snake_case, unique. name: short and human. description: one sentence.
- model: an OpenRouter model id. Default to "${defaultModel}" unless the person asks for another or the task clearly needs one. Known tool-capable models include: ${models.join(", ")}.
- system: a complete, specific system prompt (role, what good output looks like, the exact output format, what to do when information is missing). Not a one-liner.
- toolset: true gives bash, file tools and web_fetch in a sandbox; false for pure text work (classification, drafting).
- subagents: true only for a "team" lead.
- mcp_servers: only when the person names a service with an MCP server URL; otherwise leave empty and mention the integration in open_questions.

## Workflows (plan.workflow, only for kind "workflow"; null otherwise)
- nodes: exactly one {"type":"start","id":"start","label":"Start","input_description":"..."}.
  Agent step: {"type":"agent","id":"classify","label":"Classify ticket","agent_key":"<an agents[].key>","prompt":"..."}.
  Condition: {"type":"condition","id":"is_urgent","label":"Is it P1?","source":"{{nodes.classify.output}}","operator":"contains"|"not_contains"|"equals"|"matches","value":"SEVERITY: P1"}; its outgoing edges have "branch":"true" or "branch":"false".
  Router (a model picks one of several routes): {"type":"router","id":"route","label":"Route by topic","source":"{{nodes.classify.output}}","routes":[{"key":"billing","description":"..."},{"key":"bug","description":"..."}]}; each outgoing edge's "branch" is a route key.
  Output: {"type":"output","id":"result","label":"Result","template":"..."}; no outgoing edges.
- edges: {"id":"e1","source":"start","target":"classify"} (add "branch" only after conditions and routers).
- Templates: {{input}} is the run's input; {{nodes.<id>.output}} is an earlier step's final message (for a condition or router step, the branch it took). Nothing else: no {% if %}, loops, filters or fields. A step may only reference steps that run before it on its path. A step that was skipped renders as empty text, so an Output that joins several branches can simply list each branch's output.
- When a condition depends on an agent's answer, make that agent's prompt require an exact marker line (e.g. "End with a line: SEVERITY: P1|P2|P3") and test that marker. Use a router when the choice needs judgement.
- Independent steps can run in parallel: give them the same parent. A step after a branch runs if any of its incoming branches ran.
- workflow.name and every label: short human-readable titles ("Ticket triage", "Classify ticket"), not snake_case.
- ids: snake_case. Keep it to the steps that matter (usually 3–8).
- Agents may be reused by several steps.

## Environment (plan.environment)
- networking "unrestricted" unless the work only needs specific hosts; then "limited" with allowed_hosts. pip/npm: packages the agents need.

## Conversation
- First message: produce the full plan right away using sensible assumptions (list them in plan.assumptions). Ask at most three open_questions, only for things that would change the design.
- Later messages: apply the requested change to the existing plan; keep everything else (keys, ids, prompts) stable unless it must change. Put a short list of what changed in "changes".
- reply: 1–4 friendly sentences to the person: what you built or changed and what to check. No markdown headings, no JSON in the reply.

## Output format
Respond with ONE JSON object and nothing else (no prose before or after, no code fences):
{"reply": string, "changes": string[], "plan": {"kind","title","summary","steps":[{"title","detail"}],"assumptions":[],"open_questions":[],"agents":[...],"environment":{"name","networking","allowed_hosts","pip","npm"},"workflow": null | {"name","description","nodes":[...],"edges":[...]},"test_input": string}}`;
}

/* ---------------------------------------------------------------- layout */

/** Layered left-to-right layout for nodes without a position. */
export function layout<N extends { id: string; position?: { x: number; y: number } | null }>(nodes: N[], edges: Array<Pick<WorkflowEdge, "source" | "target">>): N[] {
  const depth = new Map<string, number>();
  const parents = (id: string) => edges.filter((e) => e.target === id).map((e) => e.source);
  const visit = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...parents(id).map((p) => visit(p, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => visit(n.id));
  const rows = new Map<number, number>();
  return nodes.map((n) => {
    if (n.position) return n;
    const d = depth.get(n.id) ?? 0;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    return { ...n, position: { x: d * 280, y: row * 150 } };
  });
}

/* ----------------------------------------------------------------- turns */

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The reply didn't contain a JSON object");
  return JSON.parse(t.slice(start, end + 1));
}

/** Plan-level checks beyond the schema. Returns problems. */
export function planProblems(plan: BuilderPlan): string[] {
  const p: string[] = [];
  const keys = new Set(plan.agents.map((a) => a.key));
  if (keys.size !== plan.agents.length) p.push("agents[].key must be unique");
  if (plan.kind === "workflow") {
    if (!plan.workflow) return [...p, 'kind "workflow" needs plan.workflow'];
    for (const n of plan.workflow.nodes) {
      if (n.type === "agent" && !keys.has(n.agent_key)) p.push(`step "${n.id}" uses agent_key "${n.agent_key}", which isn't in agents`);
    }
    p.push(...workflowProblems(toWorkflowNodes(plan.workflow.nodes, Object.fromEntries([...keys].map((k) => [k, k]))), plan.workflow.edges));
  } else {
    if (plan.workflow) p.push(`kind "${plan.kind}" must have "workflow": null`);
    if (plan.kind === "team" && !plan.agents.some((a) => a.subagents)) p.push('kind "team" needs a lead agent with "subagents": true');
  }
  return p;
}

function toWorkflowNodes(nodes: BuilderWorkflowNode[], agentIds: Record<string, string>): WorkflowNode[] {
  return nodes.map((n) => {
    if (n.type !== "agent") return n;
    const { agent_key, ...rest } = n;
    return { ...rest, agent: { id: agentIds[agent_key] ?? agent_key, version: null } };
  });
}

export async function builderTurn(store: Store, chat: BuilderChat, text: string, signal?: AbortSignal): Promise<BuilderChat> {
  const catalog = await listModels().catch(() => []);
  const toolModels = catalog.filter((m) => m.supports_tools).map((m) => m.id);
  const shortlist = [...new Set([chat.model, BUILDER_DEFAULT_MODEL(), ...toolModels.filter((id) => /^(anthropic|openai|google|qwen|deepseek|mistralai|meta-llama|x-ai|moonshotai)\//.test(id)).slice(0, 25)])];
  const history = chat.messages.slice(-12).map((m) => ({ role: m.role, content: m.content }) as const);
  const context = chat.plan
    ? `Current plan (revise it; return the whole plan):\n${JSON.stringify(chat.plan)}`
    : "There is no plan yet: create one.";
  const messages = [
    { role: "system" as const, content: systemPrompt(chat.model, shortlist) },
    ...history,
    { role: "user" as const, content: `${context}\n\nRequest: ${text}` },
  ];
  const key = await resolveOpenRouterKey(store);

  let parsed: z.infer<typeof turnSchema> | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    if (attempt > 0) {
      messages.push({ role: "user", content: `That plan can't be used yet: ${lastError}\nFix these problems and reply with the corrected JSON object only.` });
    }
    const res = await callModel({ id: chat.model, max_tokens: 16_000 }, messages, [], signal, key);
    const raw = res.text ?? "";
    messages.push({ role: "assistant", content: raw } as never);
    try {
      const candidate = turnSchema.parse(extractJson(raw));
      const problems = planProblems(candidate.plan as BuilderPlan);
      if (problems.length) throw new Error(problems.join("; "));
      parsed = candidate;
    } catch (err) {
      lastError = err instanceof z.ZodError ? err.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (err as Error).message;
    }
  }

  const now = nowIso();
  const userMsg = { role: "user" as const, content: text, created_at: now };
  if (!parsed) {
    return {
      ...chat,
      messages: [...chat.messages, userMsg, {
        role: "assistant",
        content: `I couldn't turn that into a valid plan (${lastError.slice(0, 300)}). Try rephrasing, or pick a stronger builder model.`,
        created_at: nowIso(),
      }],
      updated_at: nowIso(),
    };
  }
  const plan = parsed.plan as BuilderPlan;
  // Unknown models fall back to the builder's default rather than failing at run time.
  if (catalog.length) {
    const known = new Set(catalog.map((m) => m.id));
    for (const a of plan.agents) {
      if (!known.has(a.model)) {
        plan.assumptions.push(`"${a.model}" isn't an OpenRouter model id, so ${a.name} uses ${chat.model}.`);
        a.model = chat.model;
      }
    }
  }
  if (plan.workflow) {
    // Keep positions the person arranged on earlier turns.
    const prior = new Map((chat.plan?.workflow?.nodes ?? []).map((n) => [n.id, n.position]));
    plan.workflow.nodes = layout(plan.workflow.nodes.map((n) => ({ ...n, position: n.position ?? prior.get(n.id) ?? null })), plan.workflow.edges);
  }
  return {
    ...chat,
    title: chat.plan ? chat.title : plan.title,
    plan,
    messages: [...chat.messages, userMsg, { role: "assistant", content: parsed.reply, changes: parsed.changes, created_at: nowIso() }],
    updated_at: nowIso(),
  };
}

/* ----------------------------------------------------------------- apply */

function agentSpec(a: BuilderPlan["agents"][number]): Omit<Agent, "type" | "id" | "version" | "created_at" | "updated_at" | "archived_at"> {
  return {
    name: a.name,
    model: { id: a.model },
    description: a.description || null,
    system: a.system,
    tools: [
      ...(a.toolset ? [{ type: "agent_toolset_20260401" }] : []),
      ...a.mcp_servers.map((s) => ({ type: "mcp_toolset", mcp_server_name: s.name })),
    ] as unknown as Agent["tools"],
    mcp_servers: a.mcp_servers.map((s) => ({ type: "url" as const, name: s.name, url: s.url })),
    skills: [],
    multiagent: a.subagents
      ? { type: "multiagent_20261001", subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [] }, advisor: { type: "disabled" }, workflows: { type: "disabled" } } as Agent["multiagent"]
      : null,
    metadata: { "agentos.builder": "true" },
  };
}

/**
 * Creates what the plan describes. Applying again after more changes updates the same
 * resources: agents and the workflow get new versions (unchanged ones are left alone).
 */
export async function applyPlan(store: Store, chat: BuilderChat): Promise<BuilderChat> {
  const plan = chat.plan;
  if (!plan) throw conflict("There's no plan to create yet");
  const problems = planProblems(plan);
  if (problems.length) throw badRequest(`The plan isn't valid: ${problems.join("; ")}`);
  const now = nowIso();
  const prev = chat.applied;

  // Environment: reuse the one created earlier (updating its rules), else create it.
  const envConfig = {
    type: (SANDBOX_PROVIDER === "e2b" ? "cloud" : "local") as "cloud" | "local",
    networking: plan.environment.networking === "limited"
      ? { type: "limited" as const, allowed_hosts: plan.environment.allowed_hosts, allow_package_managers: true, allow_mcp_servers: true }
      : { type: "unrestricted" as const },
    packages: { pip: plan.environment.pip, npm: plan.environment.npm },
  };
  let env = prev ? await store.environments.get(prev.environment_id) : null;
  if (env && !env.archived_at) {
    env = { ...env, name: plan.environment.name, config: envConfig as Environment["config"], updated_at: now };
    await store.environments.update(env);
  } else {
    env = {
      type: "environment", id: newId("environment"), name: plan.environment.name, description: `Created by the builder for ${plan.title}`,
      config: envConfig as Environment["config"], metadata: { "agentos.builder": "true" }, created_at: now, updated_at: now, archived_at: null,
    };
    await store.environments.insert(env);
  }

  const agents: Record<string, string> = {};
  for (const a of plan.agents) {
    const spec = agentSpec(a);
    const existingId = prev?.agents[a.key];
    const existing = existingId ? await store.agents.get(existingId) : null;
    if (existing && !existing.archived_at) {
      const changed = (Object.keys(spec) as Array<keyof typeof spec>).some((k) => stableJson(spec[k] ?? null) !== stableJson(existing[k] ?? null));
      if (changed) await store.agents.insert({ ...existing, ...spec, version: existing.version + 1, updated_at: now });
      agents[a.key] = existing.id;
    } else {
      const agent: Agent = { type: "agent", id: newId("agent"), version: 1, ...spec, created_at: now, updated_at: now, archived_at: null };
      await store.agents.insert(agent);
      agents[a.key] = agent.id;
    }
  }

  let workflowId: string | null = null;
  if (plan.kind === "workflow" && plan.workflow) {
    const nodes = toWorkflowNodes(plan.workflow.nodes, agents);
    const spec = {
      name: plan.workflow.name, description: plan.workflow.description || null, nodes, edges: plan.workflow.edges.map((e) => ({ ...e, branch: e.branch ?? null })),
      environment_id: env.id, vault_ids: [] as string[], metadata: { "agentos.builder_chat": chat.id },
    };
    const existing = prev?.workflow_id ? await store.workflows.get(prev.workflow_id) : null;
    if (existing && !existing.archived_at) {
      const next: Workflow = { ...existing, ...spec, vault_ids: existing.vault_ids };
      if (stableJson({ ...next, updated_at: 0 }) !== stableJson({ ...existing, updated_at: 0 })) {
        await store.workflows.insert({ ...next, version: existing.version + 1, updated_at: now });
      }
      workflowId = existing.id;
    } else {
      const wf: Workflow = { type: "workflow", id: newId("workflow"), version: 1, ...spec, created_at: now, updated_at: now, archived_at: null };
      await store.workflows.insert(wf);
      workflowId = wf.id;
    }
  }

  return { ...chat, applied: { agents, environment_id: env.id, workflow_id: workflowId, applied_at: now }, updated_at: now };
}

/** Runs what was created with the plan's test input: a workflow run, or a session with the main agent. */
export async function testPlan(store: Store, runtime: SessionRuntime, chat: BuilderChat, input?: string) {
  if (!chat.plan || !chat.applied) throw conflict("Create the plan before testing it");
  const text = input ?? chat.plan.test_input ?? "";
  if (chat.applied.workflow_id) {
    const wf = await store.workflows.get(chat.applied.workflow_id);
    if (!wf) throw conflict("The workflow created by this chat no longer exists");
    const run = await startWorkflowRun(store, runtime, wf, text, { type: "builder_test" });
    return { type: "workflow_run" as const, id: run.id, workflow_id: wf.id };
  }
  const lead = chat.plan.agents.find((a) => a.subagents) ?? chat.plan.agents[0]!;
  const session = await createSession(store, runtime, {
    agent: chat.applied.agents[lead.key]!,
    environment_id: chat.applied.environment_id,
    title: `Test: ${chat.plan.title}`,
    initial_events: [{ type: "user.message", content: [{ type: "text", text: text || "Introduce yourself and what you can do." }] }],
  });
  return { type: "session" as const, id: session.id };
}

export { ModelError };
