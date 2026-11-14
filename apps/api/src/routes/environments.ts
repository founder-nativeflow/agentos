import { Hono } from "hono";
import { z } from "zod";
import type { Environment } from "@agentos/types";
import { newId, nowIso } from "../lib/ids.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { paginate } from "../lib/pagination.js";

const pkgList = z.array(z.string().regex(/^[\w@.\-=<>~^/:+]+$/, "invalid package name")).max(100);
const configSchema = z.object({
  // CMA SDKs send "cloud" by default. Locally AgentOS runs "cloud" and "local" in a Docker sandbox on this machine.
  type: z.enum(["cloud", "local", "self_hosted"]),
  networking: z
    .union([
      z.object({ type: z.literal("unrestricted") }),
      z.object({
        type: z.literal("limited"),
        allowed_hosts: z.array(z.string()).max(16).optional(),
        allow_package_managers: z.boolean().optional(),
        allow_mcp_servers: z.boolean().optional(),
      }),
    ])
    .optional(),
  packages: z.object({ pip: pkgList, npm: pkgList, apt: pkgList, cargo: pkgList, gem: pkgList, go: pkgList }).partial().optional(),
});

const createBody = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2048).nullish(),
  config: configSchema.default({ type: "cloud" }),
  metadata: z.record(z.string().max(64), z.string().max(512)).optional(),
});

export const environments = new Hono();

environments.get("/", async (c) => {
  const all = await c.get("store").environments.list({ includeArchived: c.req.query("include_archived") === "true" });
  return c.json(paginate(all, c.req.query()));
});

environments.post("/", async (c) => {
  const body = createBody.parse(await c.req.json());
  if (body.config.type === "self_hosted") throw badRequest("Self-hosted workers arrive in Phase 2. Use type \"cloud\" or \"local\".");
  const now = nowIso();
  const env: Environment = {
    type: "environment",
    id: newId("environment"),
    name: body.name,
    description: body.description ?? null,
    config: { networking: { type: "unrestricted" }, ...body.config },
    metadata: body.metadata ?? {},
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  await c.get("store").environments.insert(env);
  return c.json(env);
});

environments.get("/:id", async (c) => {
  const env = await c.get("store").environments.get(c.req.param("id"));
  if (!env) throw notFound("Environment", c.req.param("id"));
  return c.json(env);
});

environments.post("/:id", async (c) => {
  const store = c.get("store");
  const env = await store.environments.get(c.req.param("id"));
  if (!env) throw notFound("Environment", c.req.param("id"));
  if (env.archived_at) throw conflict("Archived environments are read-only");
  const body = createBody.partial().parse(await c.req.json());
  if (body.config && body.config.type !== env.config.type) throw badRequest("Hosting type can't be changed after creation");
  if (body.name !== undefined) env.name = body.name;
  if (body.description !== undefined) env.description = body.description ?? null;
  if (body.config) env.config = { ...env.config, ...body.config };
  if (body.metadata) env.metadata = body.metadata;
  env.updated_at = nowIso();
  await store.environments.update(env);
  return c.json(env);
});

environments.delete("/:id", async (c) => {
  const store = c.get("store");
  const env = await store.environments.get(c.req.param("id"));
  if (!env) throw notFound("Environment", c.req.param("id"));
  try {
    await store.environments.remove(env.id);
  } catch {
    throw conflict("This environment is used by sessions; archive it instead");
  }
  return c.body(null, 204);
});

environments.post("/:id/archive", async (c) => {
  const store = c.get("store");
  const env = await store.environments.get(c.req.param("id"));
  if (!env) throw notFound("Environment", c.req.param("id"));
  env.archived_at ??= nowIso();
  env.updated_at = nowIso();
  await store.environments.update(env);
  return c.json(env);
});
