import { Hono } from "hono";
import { z } from "zod";
import type { Agent, CreateAgentParams, ModelConfig } from "@agentos/types";
import { newId, nowIso } from "../lib/ids.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { paginate } from "../lib/pagination.js";

/* CMA field limits (managed-agents-api-reference). */
const effort = z.union([
  z.enum(["low", "medium", "high", "xhigh", "max"]),
  z.object({ type: z.enum(["low", "medium", "high", "xhigh", "max"]) }),
]);
const modelSchema = z.union([
  z.string().min(1),
  z
    .object({
      id: z.string().min(1),
      effort: effort.optional(),
      speed: z.enum(["standard", "fast"]).optional(),
      fallbacks: z.array(z.string()).max(5).optional(),
      max_tokens: z.number().int().min(256).max(200_000).optional(),
      provider: z
        .object({
          order: z.array(z.string()).optional(),
          allow: z.array(z.string()).optional(),
          deny: z.array(z.string()).optional(),
          data_collection: z.enum(["allow", "deny"]).optional(),
        })
        .optional(),
    })
    .passthrough(),
]);
const metadataSchema = z
  .record(z.string().max(64), z.string().max(512))
  .refine((m) => Object.keys(m).length <= 16, "metadata allows at most 16 pairs");

const agentBody = z.object({
  name: z.string().min(1).max(256),
  model: modelSchema,
  description: z.string().max(2048).nullish(),
  system: z.string().max(100_000).nullish(),
  tools: z.array(z.record(z.unknown())).max(256).optional(),
  mcp_servers: z
    .array(z.object({ type: z.literal("url"), name: z.string().min(1), url: z.string().url() }))
    .max(20)
    .refine((s) => new Set(s.map((x) => x.name)).size === s.length, "mcp_servers names must be unique")
    .optional(),
  skills: z.array(z.record(z.unknown())).max(500).optional(),
  multiagent: z
    .object({
      type: z.literal("multiagent_20261001"),
      subagents: z
        .union([
          z.object({
            type: z.literal("enabled"),
            inline_agents: z.object({ type: z.enum(["enabled", "disabled"]) }).nullish(),
            predefined_agents: z.array(z.unknown()).max(20).nullish(),
          }),
          z.object({ type: z.literal("disabled") }),
        ])
        .nullish(),
      advisor: z.union([z.object({ type: z.literal("enabled"), model: z.string() }), z.object({ type: z.literal("disabled") })]).nullish(),
      workflows: z.object({ type: z.enum(["enabled", "disabled"]) }).passthrough().nullish(),
    })
    .nullish(),
  metadata: metadataSchema.optional(),
});

const updateBody = agentBody.partial().extend({ version: z.number().int().min(1).optional() });

/**
 * Resolves CMA `multiagent_20261001` (defaults filled in, merged into the stored value on
 * update). AgentOS supports inline sub-agents today; predefined agents, the advisor and
 * workflow runs are rejected explicitly rather than silently ignored.
 */
type MultiagentInput = z.infer<typeof agentBody>["multiagent"];
function resolveMultiagent(input: MultiagentInput, stored: Agent["multiagent"] | null = null): Agent["multiagent"] {
  if (input === undefined) return stored;
  if (input === null) return null;
  const base = stored?.type === input.type ? stored : null;
  const subagents =
    input.subagents === undefined ? (base?.subagents ?? null) : input.subagents;
  const resolvedSub =
    subagents === null || subagents === undefined
      ? { type: "enabled" as const, inline_agents: { type: "enabled" as const }, predefined_agents: [] }
      : subagents.type === "disabled"
        ? { type: "disabled" as const }
        : {
            type: "enabled" as const,
            inline_agents: { type: subagents.inline_agents?.type ?? "enabled" },
            predefined_agents: (subagents.predefined_agents ?? []) as never[],
          };
  if (resolvedSub.type === "enabled" && resolvedSub.predefined_agents.length) {
    throw badRequest("multiagent.subagents.predefined_agents is not supported yet in AgentOS; inline sub-agents are");
  }
  const advisor = input.advisor === undefined ? (base?.advisor ?? { type: "disabled" as const }) : (input.advisor ?? { type: "disabled" as const });
  if (advisor.type === "enabled") throw badRequest("multiagent.advisor is not supported yet in AgentOS");
  const workflows = input.workflows === undefined ? base?.workflows : input.workflows;
  if (workflows && workflows.type === "enabled") throw badRequest("multiagent.workflows is not supported yet in AgentOS; set it to disabled");
  return { type: "multiagent_20261001", subagents: resolvedSub, advisor, workflows: { type: "disabled" } };
}

function toModel(m: CreateAgentParams["model"]): ModelConfig {
  return typeof m === "string" ? { id: m } : (m as ModelConfig);
}

/** Fields that define a version; changing any of them creates a new version. */
const VERSIONED = ["name", "model", "description", "system", "tools", "mcp_servers", "skills", "multiagent", "metadata"] as const;

export const agents = new Hono();

agents.get("/", async (c) => {
  const includeArchived = c.req.query("include_archived") === "true";
  const all = await c.get("store").agents.list({ includeArchived });
  return c.json(paginate(all, c.req.query()));
});

agents.post("/", async (c) => {
  const body = agentBody.parse(await c.req.json());
  const now = nowIso();
  const agent: Agent = {
    type: "agent",
    id: newId("agent"),
    version: 1,
    name: body.name,
    model: toModel(body.model as CreateAgentParams["model"]),
    description: body.description ?? null,
    system: body.system ?? null,
    tools: (body.tools ?? []) as unknown as Agent["tools"],
    mcp_servers: body.mcp_servers ?? [],
    skills: (body.skills ?? []) as unknown as Agent["skills"],
    multiagent: resolveMultiagent(body.multiagent),
    metadata: body.metadata ?? {},
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  await c.get("store").agents.insert(agent);
  return c.json(agent);
});

agents.get("/:id", async (c) => {
  // CMA: ?version=N retrieves a specific version (default: latest).
  const v = c.req.query("version");
  const store = c.get("store");
  const agent = v ? await store.agents.getVersion(c.req.param("id"), Number(v)) : await store.agents.get(c.req.param("id"));
  if (!agent) throw notFound("Agent", v ? `${c.req.param("id")} version ${v}` : c.req.param("id"));
  return c.json(agent);
});

agents.post("/:id", async (c) => {
  const id = c.req.param("id");
  const store = c.get("store");
  const current = await store.agents.get(id);
  if (!current) throw notFound("Agent", id);
  if (current.archived_at) throw conflict("Archived agents are read-only");

  const body = updateBody.parse(await c.req.json());
  if (body.version !== undefined && body.version !== current.version) {
    throw conflict(`Version mismatch: agent is at version ${current.version}, request expected ${body.version}`);
  }

  const next: Agent = { ...current };
  if (body.name !== undefined) next.name = body.name;
  if (body.model !== undefined) next.model = toModel(body.model as CreateAgentParams["model"]);
  if (body.description !== undefined) next.description = body.description ?? null;
  if (body.system !== undefined) next.system = body.system ?? null;
  if (body.tools !== undefined) next.tools = body.tools as unknown as Agent["tools"];
  if (body.mcp_servers !== undefined) next.mcp_servers = body.mcp_servers;
  if (body.skills !== undefined) next.skills = body.skills as unknown as Agent["skills"];
  if (body.multiagent !== undefined) next.multiagent = resolveMultiagent(body.multiagent, current.multiagent);
  if (body.metadata !== undefined) next.metadata = body.metadata;

  const changed = VERSIONED.some((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
  if (!changed) return c.json(current);

  next.version = current.version + 1;
  next.updated_at = nowIso();
  await store.agents.insert(next);
  return c.json(next);
});

agents.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const store = c.get("store");
  const current = await store.agents.get(id);
  if (!current) throw notFound("Agent", id);
  if (current.archived_at) throw badRequest("Agent is already archived");
  current.archived_at = nowIso();
  await store.agents.archive(id, current.archived_at);
  return c.json(current);
});

agents.get("/:id/versions", async (c) => {
  const id = c.req.param("id");
  const versions = await c.get("store").agents.versions(id);
  if (versions.length === 0) throw notFound("Agent", id);
  return c.json(paginate(versions, c.req.query()));
});
