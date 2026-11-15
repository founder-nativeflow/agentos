import { Hono } from "hono";
import { z } from "zod";
import type { BuilderChat, BuilderPlan } from "@agentos/types";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors.js";
import { newId, nowIso } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import type { Store } from "../lib/store.js";
import { applyPlan, builderTurn, layout, planProblems, planSchema, testPlan } from "../runtime/builder.js";
import { ModelError } from "../runtime/model.js";
import type { SessionRuntime } from "../runtime/runner.js";
import { BUILDER_DEFAULT_MODEL } from "../runtime/workflows.js";

/* The builder chat (AgentOS extension): /v1/x/builder/chats. */

const busy = new Set<string>();

async function load(store: Store, id: string): Promise<BuilderChat> {
  const chat = await store.builderChats.get(id);
  if (!chat) throw notFound("Builder chat", id);
  return chat;
}

async function turn(store: Store, chat: BuilderChat, message: string, signal: AbortSignal): Promise<BuilderChat> {
  if (busy.has(chat.id)) throw conflict("The builder is still working on the previous message");
  busy.add(chat.id);
  try {
    const next = await builderTurn(store, chat, message, signal);
    await store.builderChats.upsert(next);
    return next;
  } catch (err) {
    if (err instanceof ModelError) throw new ApiError(400, "invalid_request_error", `The builder model failed: ${err.message}`);
    throw err;
  } finally {
    busy.delete(chat.id);
  }
}

const messageBody = z.object({ message: z.string().min(1).max(20_000), model: z.string().min(1).max(200).optional() });

export function builderRoutes(runtime: SessionRuntime) {
  const r = new Hono();

  r.get("/chats", async (c) => {
    const chats = (await c.get("store").builderChats.list()).map((b) => ({ ...b, messages: b.messages.slice(0, 1) }));
    return c.json(paginate(chats, c.req.query()));
  });

  /** Start a chat with the first request; the reply carries the first plan. */
  r.post("/chats", async (c) => {
    const store = c.get("store");
    const body = messageBody.parse(await c.req.json());
    const now = nowIso();
    const chat: BuilderChat = {
      type: "builder_chat", id: newId("builderChat"), title: body.message.slice(0, 80), model: body.model ?? BUILDER_DEFAULT_MODEL(),
      messages: [], plan: null, applied: null, created_at: now, updated_at: now,
    };
    await store.builderChats.upsert(chat);
    return c.json(await turn(store, chat, body.message, c.req.raw.signal));
  });

  r.get("/chats/:id", async (c) => c.json(await load(c.get("store"), c.req.param("id"))));

  r.post("/chats/:id/messages", async (c) => {
    const store = c.get("store");
    const body = messageBody.parse(await c.req.json());
    const chat = await load(store, c.req.param("id"));
    if (body.model) chat.model = body.model;
    return c.json(await turn(store, chat, body.message, c.req.raw.signal));
  });

  /** Direct edits from the canvas (labels, prompts, positions, connections). */
  r.post("/chats/:id/plan", async (c) => {
    const store = c.get("store");
    const chat = await load(store, c.req.param("id"));
    const { plan } = z.object({ plan: planSchema }).parse(await c.req.json());
    const p = plan as BuilderPlan;
    const problems = planProblems(p);
    if (problems.length) throw badRequest(`The plan isn't valid: ${problems.join("; ")}`);
    if (p.workflow) p.workflow.nodes = layout(p.workflow.nodes, p.workflow.edges);
    const next = { ...chat, plan: p, updated_at: nowIso() };
    await store.builderChats.upsert(next);
    return c.json(next);
  });

  r.post("/chats/:id/apply", async (c) => {
    const store = c.get("store");
    const next = await applyPlan(store, await load(store, c.req.param("id")));
    await store.builderChats.upsert(next);
    return c.json(next);
  });

  r.post("/chats/:id/test", async (c) => {
    const store = c.get("store");
    const { input } = z.object({ input: z.string().max(200_000).optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await testPlan(store, runtime, await load(store, c.req.param("id")), input));
  });

  r.delete("/chats/:id", async (c) => {
    const store = c.get("store");
    await load(store, c.req.param("id"));
    await store.builderChats.delete(c.req.param("id"));
    return c.json({ type: "builder_chat_deleted", id: c.req.param("id") });
  });

  return r;
}
