import { Hono } from "hono";
import { limitWebhook } from "../lib/limits.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Deployment, InboundEvent } from "@agentos/types";
import { sha256 } from "../lib/config.js";
import { badRequest, conflict, notFound, unauthorized } from "../lib/errors.js";
import { newId, nowIso } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import { storeScope } from "../lib/scope.js";
import type { Store } from "../lib/store.js";
import { deploymentView, runDeployment, validateSchedule } from "../runtime/deployments.js";
import type { SessionRuntime } from "../runtime/runner.js";

/**
 * CMA-compatible deployments (/v1/deployments) and deployment runs (/v1/deployment_runs).
 * A deployment pins an agent version; triggers: manual (POST …/run), cron schedule, and
 * (AgentOS extension) a webhook with a secret token.
 */

const textBlocks = z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1);
const initialEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user.message"), content: z.union([textBlocks, z.string().transform((t) => [{ type: "text" as const, text: t }])]) }),
  z.object({ type: z.literal("system.message"), content: textBlocks }),
  z.object({ type: z.literal("user.define_outcome") }).passthrough(),
]);
const agentRef = z.union([z.string(), z.object({ type: z.literal("agent"), id: z.string(), version: z.number().int().optional() }).passthrough()]);
const schedule = z.object({ type: z.literal("cron"), expression: z.string().min(1).max(200), timezone: z.string().min(1).max(64) });
const budget = z.object({
  type: z.literal("limit"),
  max_list_cost: z.object({ amount: z.string().regex(/^\d+$/), currency: z.literal("USD") }),
});
const metadata = z.record(z.string().max(64), z.string().max(512));
const resources = z.array(z.object({ type: z.literal("file"), file_id: z.string(), mount_path: z.string().nullish() })).max(100);

const createBody = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2048).nullish(),
  agent: agentRef,
  environment_id: z.string(),
  initial_events: z.array(initialEvent).min(1).max(50),
  schedule: schedule.nullish(),
  budget: budget.nullish(),
  vault_ids: z.array(z.string()).max(20).optional(),
  resources: resources.optional(),
  metadata: metadata.optional(),
});
const updateBody = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2048).nullish(),
  agent: agentRef.optional(),
  environment_id: z.string().optional(),
  initial_events: z.array(initialEvent).min(1).max(50).optional(),
  schedule: schedule.nullish(),
  budget: budget.nullish(),
  vault_ids: z.array(z.string()).max(20).nullish(),
  resources: resources.nullish(),
  metadata: z.record(z.string().max(64), z.string().max(512).nullable()).nullish(),
});

type Events = Deployment["initial_events"];

/** Resolves an agent reference to a pinned version (latest when no version is given). */
async function pin(store: Store, ref: z.infer<typeof agentRef>): Promise<Deployment["agent"]> {
  if (typeof ref !== "string" && !ref.id) throw badRequest("Inline agent definitions aren't supported yet; create the agent and reference its id");
  const id = typeof ref === "string" ? ref : ref.id;
  const version = typeof ref === "string" ? undefined : ref.version;
  const agent = version ? await store.agents.getVersion(id, version) : await store.agents.get(id);
  if (!agent) throw notFound("Agent", version ? `${id} version ${version}` : id);
  if (agent.archived_at) throw conflict("Archived agents can't be deployed");
  return { type: "agent", id: agent.id, version: agent.version };
}

async function checkRefs(store: Store, envId: string, vaultIds: string[], files: Deployment["resources"]) {
  const env = await store.environments.get(envId);
  if (!env) throw notFound("Environment", envId);
  if (env.archived_at) throw conflict("Archived environments can't be used in a deployment");
  for (const id of vaultIds) if (!(await store.vaults.get(id))) throw notFound("Vault", id);
  for (const f of files) if (!(await store.files.get(f.file_id))) throw notFound("File", f.file_id);
}

function checkEvents(events: z.infer<typeof initialEvent>[]): Events {
  if (events.some((e) => e.type === "user.define_outcome")) throw badRequest("user.define_outcome is not supported yet in AgentOS");
  return events as Events;
}

const load = async (store: Store, id: string) => {
  const d = await store.deployments.get(id);
  if (!d) throw notFound("Deployment", id);
  return d;
};

export function deploymentRoutes(runtime: SessionRuntime) {
  const r = new Hono();

  r.post("/", async (c) => {
    const store = c.get("store");
    const body = createBody.parse(await c.req.json());
    if (body.schedule) validateSchedule(body.schedule.expression, body.schedule.timezone);
    const agent = await pin(store, body.agent);
    const vaultIds = [...new Set(body.vault_ids ?? [])];
    await checkRefs(store, body.environment_id, vaultIds, body.resources ?? []);
    const now = nowIso();
    const d: Deployment = {
      type: "deployment",
      id: newId("deployment"),
      name: body.name,
      description: body.description ?? null,
      agent,
      environment_id: body.environment_id,
      vault_ids: vaultIds,
      resources: body.resources ?? [],
      initial_events: checkEvents(body.initial_events),
      budget: body.budget ?? null,
      schedule: body.schedule ? { ...body.schedule, last_run_at: null } : null,
      status: "active",
      paused_reason: null,
      metadata: body.metadata ?? {},
      x_webhook: { enabled: false },
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    await store.deployments.insert(d);
    return c.json(deploymentView(d));
  });

  r.get("/", async (c) => {
    const q = c.req.query();
    let list = await c.get("store").deployments.list({ includeArchived: q.include_archived === "true", agentId: q.agent_id, status: q.status });
    if (q["created_at[gte]"]) list = list.filter((d) => d.created_at >= q["created_at[gte]"]!);
    if (q["created_at[lte]"]) list = list.filter((d) => d.created_at <= q["created_at[lte]"]!);
    return c.json(paginate(list.map(deploymentView), q));
  });

  r.get("/:id", async (c) => c.json(deploymentView(await load(c.get("store"), c.req.param("id")))));

  r.post("/:id", async (c) => {
    const store = c.get("store");
    const d = await load(store, c.req.param("id"));
    if (d.archived_at) throw conflict("Archived deployments can't be changed");
    const body = updateBody.parse(await c.req.json());
    if (body.name !== undefined) d.name = body.name;
    if (body.description !== undefined) d.description = body.description ?? null;
    // Changing the agent re-pins it: a bare id means its latest version now.
    if (body.agent !== undefined) d.agent = await pin(store, body.agent);
    if (body.environment_id !== undefined) d.environment_id = body.environment_id;
    if (body.initial_events !== undefined) d.initial_events = checkEvents(body.initial_events);
    if (body.schedule !== undefined) {
      if (body.schedule) validateSchedule(body.schedule.expression, body.schedule.timezone);
      d.schedule = body.schedule ? { ...body.schedule, last_run_at: d.schedule?.last_run_at ?? null } : null;
    }
    if (body.budget !== undefined) d.budget = body.budget ?? null;
    if (body.vault_ids !== undefined) d.vault_ids = [...new Set(body.vault_ids ?? [])];
    if (body.resources !== undefined) d.resources = body.resources ?? [];
    if (body.metadata !== undefined) {
      if (body.metadata === null) d.metadata = {};
      else for (const [k, v] of Object.entries(body.metadata)) {
        if (v === null) delete d.metadata[k];
        else d.metadata[k] = v;
      }
    }
    await checkRefs(store, d.environment_id, d.vault_ids, d.resources);
    d.updated_at = nowIso();
    await store.deployments.update(d);
    return c.json(deploymentView(d));
  });

  r.post("/:id/archive", async (c) => {
    const store = c.get("store");
    const d = await load(store, c.req.param("id"));
    d.archived_at ??= nowIso();
    d.updated_at = nowIso();
    await store.deployments.update(d);
    await store.deployments.setWebhookHash(d.id, null);
    d.x_webhook = { enabled: false };
    return c.json(deploymentView(d));
  });

  r.post("/:id/pause", async (c) => {
    const store = c.get("store");
    const d = await load(store, c.req.param("id"));
    if (d.archived_at) throw conflict("Archived deployments can't be paused");
    d.status = "paused";
    d.paused_reason = { type: "manual" };
    d.updated_at = nowIso();
    await store.deployments.update(d);
    return c.json(deploymentView(d));
  });

  r.post("/:id/unpause", async (c) => {
    const store = c.get("store");
    const d = await load(store, c.req.param("id"));
    if (d.archived_at) throw conflict("Archived deployments can't be unpaused");
    await checkRefs(store, d.environment_id, d.vault_ids, d.resources);
    d.status = "active";
    d.paused_reason = null;
    d.updated_at = nowIso();
    await store.deployments.update(d);
    return c.json(deploymentView(d));
  });

  /** Manual run: works for active and paused deployments; returns the run (session or error). */
  r.post("/:id/run", async (c) => {
    const store = c.get("store");
    const d = await load(store, c.req.param("id"));
    if (d.archived_at) throw conflict("Archived deployments can't run");
    return c.json(await runDeployment(store, runtime, d, { type: "manual" }));
  });

  /** AgentOS extension: create or rotate the webhook token (shown once). */
  r.post("/:id/webhook", async (c) => {
    const store = c.get("store");
    const d = await load(store, c.req.param("id"));
    if (d.archived_at) throw conflict("Archived deployments can't have webhooks");
    const token = `whk_${randomBytes(24).toString("base64url")}`;
    await store.deployments.setWebhookHash(d.id, sha256(token));
    return c.json({ url: `/v1/x/hooks/deployments/${d.id}`, token, header: "x-agentos-webhook-token" });
  });

  r.delete("/:id/webhook", async (c) => {
    const store = c.get("store");
    const d = await load(store, c.req.param("id"));
    await store.deployments.setWebhookHash(d.id, null);
    return c.json({ ...deploymentView(d), x_webhook: { enabled: false } });
  });

  return r;
}

export function deploymentRunRoutes() {
  const r = new Hono();
  r.get("/", async (c) => {
    const q = c.req.query();
    const runs = await c.get("store").deploymentRuns.list({
      deploymentId: q.deployment_id,
      hasError: q.has_error === undefined ? undefined : q.has_error === "true",
      triggerType: q.trigger_type,
      createdGte: q["created_at[gte]"], createdLte: q["created_at[lte]"], createdGt: q["created_at[gt]"], createdLt: q["created_at[lt]"],
    });
    return c.json(paginate(runs, q));
  });
  r.get("/:id", async (c) => {
    const run = await c.get("store").deploymentRuns.get(c.req.param("id"));
    if (!run) throw notFound("Deployment run", c.req.param("id"));
    return c.json(run);
  });
  return r;
}

/**
 * Public webhook trigger (AgentOS extension): POST /v1/x/hooks/deployments/{id} with
 * `x-agentos-webhook-token: <token>` (or `Authorization: Bearer <token>`). The request body
 * (up to 64 KB) is appended to the run's first message.
 */
export function webhookRoute(runtime: SessionRuntime) {
  const r = new Hono();
  r.post("/deployments/:id", async (c) => {
    const base = c.get("store");
    const id = c.req.param("id");
    limitWebhook(c);
    const token = c.req.header("x-agentos-webhook-token") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const target = await base.deployments.forWebhook(id);
    const given = Buffer.from(sha256(token));
    const ok = target?.hash && token && given.length === target.hash.length && timingSafeEqual(given, Buffer.from(target.hash));
    if (!ok) throw unauthorized("Invalid webhook token");
    const raw = (await c.req.text()).slice(0, 65_536);
    const scoped = base.scoped(target!.workspace_id);
    return storeScope.run(scoped, async () => {
      const d = await scoped.deployments.get(id);
      if (!d || d.archived_at) throw notFound("Deployment", id);
      if (d.status === "paused") throw conflict("This deployment is paused");
      let pretty = raw;
      try {
        pretty = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        /* not JSON: pass as text */
      }
      const extra: InboundEvent[] = raw.trim()
        ? [{ type: "user.message", content: [{ type: "text", text: `Webhook payload:\n\`\`\`\n${pretty}\n\`\`\`` }] }]
        : [];
      const run = await runDeployment(scoped, runtime, d, { type: "webhook" }, extra);
      return c.json(run, run?.error ? 422 : 202);
    });
  });
  return r;
}
