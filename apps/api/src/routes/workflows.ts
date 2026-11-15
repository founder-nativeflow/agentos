import { Hono } from "hono";
import { z } from "zod";
import type { Workflow, WorkflowNode } from "@agentos/types";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { newId, nowIso } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import type { Store } from "../lib/store.js";
import type { SessionRuntime } from "../runtime/runner.js";
import { assertRunnable, cancelRun, stableJson, startWorkflowRun, workflowProblems } from "../runtime/workflows.js";

/* Workflows (AgentOS extension): /v1/x/workflows, /v1/x/workflow_runs. */

const position = z.object({ x: z.number(), y: z.number() }).nullish();
const base = { id: z.string().min(1).max(48), label: z.string().min(1).max(120), position };
export const nodeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("start"), input_description: z.string().max(2000).nullish() }),
  z.object({
    ...base,
    type: z.literal("agent"),
    agent: z.object({ id: z.string().min(1), version: z.number().int().min(1).nullish() }),
    prompt: z.string().min(1).max(50_000),
  }),
  z.object({
    ...base,
    type: z.literal("condition"),
    source: z.string().min(1).max(2000),
    operator: z.enum(["contains", "not_contains", "equals", "matches"]),
    value: z.string().max(2000),
  }),
  z.object({
    ...base,
    type: z.literal("router"),
    source: z.string().min(1).max(2000),
    routes: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), description: z.string().min(1).max(500) })).min(2).max(10),
    model: z.string().nullish(),
  }),
  z.object({ ...base, type: z.literal("output"), template: z.string().min(1).max(20_000) }),
]);
export const edgeSchema = z.object({
  id: z.string().min(1).max(100),
  source: z.string().min(1),
  target: z.string().min(1),
  branch: z.string().max(32).nullish(),
});

const body = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2048).nullish(),
  nodes: z.array(nodeSchema).min(1).max(100),
  edges: z.array(edgeSchema).max(300),
  environment_id: z.string().min(1),
  vault_ids: z.array(z.string()).max(20).optional(),
  metadata: z.record(z.string().max(64), z.string().max(512)).optional(),
});
const updateBody = body.partial().extend({ version: z.number().int().min(1).optional() });

/** Checks references (agents, environment, vaults) exist in this workspace. */
async function checkRefs(store: Store, w: Pick<Workflow, "nodes" | "environment_id" | "vault_ids">) {
  const env = await store.environments.get(w.environment_id);
  if (!env) throw badRequest(`Environment ${w.environment_id} was not found`);
  for (const v of w.vault_ids) if (!(await store.vaults.get(v))) throw badRequest(`Vault ${v} was not found`);
  for (const n of w.nodes) {
    if (n.type !== "agent") continue;
    const a = n.agent.version ? await store.agents.getVersion(n.agent.id, n.agent.version) : await store.agents.get(n.agent.id);
    if (!a) throw badRequest(`Step "${n.id}" uses agent ${n.agent.id}${n.agent.version ? ` version ${n.agent.version}` : ""}, which was not found`);
  }
}

export function createWorkflowRecord(input: z.infer<typeof body>): Workflow {
  const now = nowIso();
  return {
    type: "workflow",
    id: newId("workflow"),
    version: 1,
    name: input.name,
    description: input.description ?? null,
    nodes: input.nodes as WorkflowNode[],
    edges: input.edges.map((e) => ({ ...e, branch: e.branch ?? null })),
    environment_id: input.environment_id,
    vault_ids: input.vault_ids ?? [],
    metadata: input.metadata ?? {},
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
}

export async function insertWorkflow(store: Store, input: unknown): Promise<Workflow> {
  const parsed = body.parse(input);
  assertRunnable(parsed.nodes as WorkflowNode[], parsed.edges);
  const wf = createWorkflowRecord(parsed);
  await checkRefs(store, wf);
  await store.workflows.insert(wf);
  return wf;
}

export function workflowRoutes(runtime: SessionRuntime) {
  const r = new Hono();

  r.get("/", async (c) => {
    const all = await c.get("store").workflows.list({ includeArchived: c.req.query("include_archived") === "true" });
    return c.json(paginate(all, c.req.query()));
  });

  r.post("/", async (c) => c.json(await insertWorkflow(c.get("store"), await c.req.json())));

  /** Validate a graph without saving it (the canvas uses this while you edit). */
  r.post("/validate", async (c) => {
    const parsed = z.object({ nodes: z.array(nodeSchema), edges: z.array(edgeSchema) }).parse(await c.req.json());
    const problems = workflowProblems(parsed.nodes as WorkflowNode[], parsed.edges);
    return c.json({ valid: problems.length === 0, problems });
  });

  r.get("/:id", async (c) => {
    const v = c.req.query("version");
    const wf = await c.get("store").workflows.get(c.req.param("id"), v ? Number(v) : undefined);
    if (!wf) throw notFound("Workflow", c.req.param("id"));
    return c.json(wf);
  });

  r.get("/:id/versions", async (c) => {
    const all = await c.get("store").workflows.versions(c.req.param("id"));
    if (!all.length) throw notFound("Workflow", c.req.param("id"));
    return c.json(paginate(all, c.req.query()));
  });

  /** Update: a change to anything but positions makes a new version; positions alone are saved in place. */
  r.post("/:id", async (c) => {
    const store = c.get("store");
    const current = await store.workflows.get(c.req.param("id"));
    if (!current) throw notFound("Workflow", c.req.param("id"));
    if (current.archived_at) throw conflict("Archived workflows are read-only");
    const b = updateBody.parse(await c.req.json());
    if (b.version !== undefined && b.version !== current.version) {
      throw conflict(`Version mismatch: workflow is at version ${current.version}, request expected ${b.version}`);
    }
    const next: Workflow = {
      ...current,
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.description !== undefined ? { description: b.description ?? null } : {}),
      ...(b.nodes !== undefined ? { nodes: b.nodes as WorkflowNode[] } : {}),
      ...(b.edges !== undefined ? { edges: b.edges.map((e) => ({ ...e, branch: e.branch ?? null })) } : {}),
      ...(b.environment_id !== undefined ? { environment_id: b.environment_id } : {}),
      ...(b.vault_ids !== undefined ? { vault_ids: b.vault_ids } : {}),
      ...(b.metadata !== undefined ? { metadata: b.metadata } : {}),
    };
    assertRunnable(next.nodes, next.edges);
    await checkRefs(store, next);
    const strip = (w: Workflow) => stableJson({ ...w, nodes: w.nodes.map((n) => ({ ...n, position: null })), updated_at: null });
    if (strip(next) === strip(current)) {
      if (stableJson(next.nodes) === stableJson(current.nodes)) return c.json(current);
      // Layout only: same version.
      await store.workflows.saveLayout(current.id, current.version, next.nodes);
      return c.json(next);
    }
    next.version = current.version + 1;
    next.updated_at = nowIso();
    await store.workflows.insert(next);
    return c.json(next);
  });

  r.post("/:id/archive", async (c) => {
    const store = c.get("store");
    const wf = await store.workflows.get(c.req.param("id"));
    if (!wf) throw notFound("Workflow", c.req.param("id"));
    wf.archived_at = nowIso();
    await store.workflows.archive(wf.id, wf.archived_at);
    return c.json(wf);
  });

  r.post("/:id/runs", async (c) => {
    const store = c.get("store");
    const { input, version } = z.object({ input: z.string().max(200_000).default(""), version: z.number().int().optional() }).parse(await c.req.json().catch(() => ({})));
    const wf = await store.workflows.get(c.req.param("id"), version);
    if (!wf) throw notFound("Workflow", c.req.param("id"));
    return c.json(await startWorkflowRun(store, runtime, wf, input));
  });

  r.get("/:id/runs", async (c) => {
    const runs = await c.get("store").workflowRuns.list({ workflowId: c.req.param("id") });
    return c.json(paginate(runs, c.req.query()));
  });

  return r;
}

export function workflowRunRoutes(runtime: SessionRuntime) {
  void runtime;
  const r = new Hono();
  r.get("/", async (c) => c.json(paginate(await c.get("store").workflowRuns.list({ workflowId: c.req.query("workflow_id") }), c.req.query())));
  r.get("/:id", async (c) => {
    const run = await c.get("store").workflowRuns.get(c.req.param("id"));
    if (!run) throw notFound("Workflow run", c.req.param("id"));
    return c.json(run);
  });
  r.post("/:id/cancel", async (c) => {
    const store = c.get("store");
    const run = await store.workflowRuns.get(c.req.param("id"));
    if (!run) throw notFound("Workflow run", c.req.param("id"));
    if (run.status !== "running") throw conflict(`This run is already ${run.status}`);
    cancelRun(run.id);
    for (let i = 0; i < 50; i++) {
      const now = await store.workflowRuns.get(run.id);
      if (now && now.status !== "running") return c.json(now);
      await new Promise((res) => setTimeout(res, 100));
    }
    return c.json(await store.workflowRuns.get(run.id));
  });
  return r;
}
