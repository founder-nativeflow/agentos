import { Hono } from "hono";
import { assertCanStartTurn } from "../lib/limits.js";
import { streamSSE } from "hono/streaming";
import { readdirSync, statSync, createReadStream, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { InboundEvent, Session, SessionEvent, SessionResource } from "@agentos/types";
import { newId, nowIso } from "../lib/ids.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { paginate } from "../lib/pagination.js";
import { bus } from "../runtime/bus.js";
import { destroySandbox, SANDBOX_PROVIDER } from "../runtime/sandbox.js";
import { closeMcp } from "../runtime/mcp.js";
import { createSession } from "../runtime/session-service.js";
import { egress } from "../egress/manager.js";
import { SESSIONS_DIR } from "../lib/paths.js";
import type { SessionRuntime } from "../runtime/runner.js";

const textBlocks = z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1);

const inboundEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user.message"), content: z.union([textBlocks, z.string().transform((t) => [{ type: "text" as const, text: t }])]) }),
  z.object({ type: z.literal("user.interrupt") }),
  z.object({
    type: z.literal("user.tool_confirmation"),
    tool_use_id: z.string(),
    result: z.enum(["allow", "deny"]),
    deny_message: z.string().nullish(),
  }),
  z.object({
    type: z.literal("user.custom_tool_result"),
    custom_tool_use_id: z.string(),
    content: textBlocks.optional(),
    is_error: z.boolean().nullish(),
  }),
  z.object({ type: z.literal("system.message"), content: textBlocks }),
  z.object({
    type: z.literal("user.define_outcome"),
    description: z.string(),
    rubric: z.unknown(),
    max_iterations: z.number().int().min(1).max(20).optional(),
  }),
]);

const budgetSchema = z.object({
  type: z.literal("limit"),
  max_list_cost: z.object({ amount: z.string().regex(/^\d+$/, "amount is an integer string in cents"), currency: z.literal("USD") }),
});

const createBody = z.object({
  agent: z.union([z.string(), z.object({ type: z.literal("agent"), id: z.string(), version: z.number().int().optional() })]),
  environment_id: z.string(),
  title: z.string().max(512).nullish(),
  vault_ids: z.array(z.string()).optional(),
  budget: budgetSchema.optional(),
  metadata: z.record(z.string().max(64), z.string().max(512)).optional(),
  initial_events: z.array(inboundEvent).max(50).optional(),
  runs_on: z.enum(["local"]).optional(), // "cloud" / workers arrive in Phase 2
  resources: z
    .array(z.object({ type: z.literal("file"), file_id: z.string(), mount_path: z.string().nullish() }))
    .max(100)
    .optional(),
});

const updateBody = z.object({
  title: z.string().max(512).nullish(),
  metadata: z.record(z.string().max(64), z.string().max(512)).optional(),
  budget: budgetSchema.nullable().optional(),
});

export function sessionRoutes(runtime: SessionRuntime) {
  const r = new Hono();

  const load = async (store: ReturnType<typeof getStore>, id: string) => {
    const s = await store.sessions.get(id);
    if (!s) throw notFound("Session", id);
    return s;
  };
  const getStore = (c: { get: (k: "store") => import("../lib/store.js").Store }) => c.get("store");

  r.get("/", async (c) => {
    const q = c.req.query();
    const all = await c.get("store").sessions.list({ includeArchived: q.include_archived === "true", agentId: q.agent_id });
    const page = paginate(all, q);
    return c.json({ ...page, prev_page: null });
  });

  r.post("/", async (c) => {
    const body = createBody.parse(await c.req.json());
    if (body.initial_events?.some((e) => e.type !== "user.message" && e.type !== "user.define_outcome")) {
      throw badRequest("initial_events accepts only user.message and user.define_outcome");
    }
    const session = await createSession(c.get("store"), runtime, {
      ...body,
      initial_events: body.initial_events as InboundEvent[] | undefined,
    });
    return c.json(session);
  });

  r.get("/:id", async (c) => c.json(await load(getStore(c), c.req.param("id"))));

  r.post("/:id", async (c) => {
    const store = getStore(c);
    const s = await load(store, c.req.param("id"));
    const body = updateBody.parse(await c.req.json());
    if (body.title !== undefined) s.title = body.title ?? null;
    if (body.metadata) s.metadata = body.metadata;
    if (body.budget !== undefined) {
      if (body.budget === null) s.budget = null;
      else {
        if (Number(body.budget.max_list_cost.amount) <= Number(s.usage.cost_usd) * 100) {
          throw badRequest("The new budget must be higher than what the session has already spent");
        }
        s.budget = body.budget;
      }
      // Raising/removing the budget resumes a paused session.
      if (s.stop_reason?.type === "budget_reached") s.stop_reason = { type: "end_turn" };
    }
    s.updated_at = nowIso();
    await store.sessions.update(s);
    if (body.budget !== undefined) runtime.wake(s.id);
    return c.json(s);
  });

  r.delete("/:id", async (c) => {
    const store = getStore(c);
    const s = await load(store, c.req.param("id"));
    if (runtime.isRunning(s.id)) throw conflict("Interrupt the session before deleting it");
    await destroySandbox(s.id);
    await closeMcp(s.id);
    await egress.remove(s.id);
    await store.sessions.remove(s.id);
    return c.json({ type: "session_deleted", id: s.id });
  });

  r.post("/:id/archive", async (c) => {
    const store = getStore(c);
    const s = await load(store, c.req.param("id"));
    if (runtime.isRunning(s.id)) throw conflict("Interrupt the session before archiving it");
    await destroySandbox(s.id);
    await closeMcp(s.id);
    await egress.remove(s.id);
    s.archived_at ??= nowIso();
    s.status = "terminated";
    s.updated_at = nowIso();
    await store.sessions.update(s);
    return c.json(s);
  });

  /* ------------------------------------------------------------- events */

  r.get("/:id/events", async (c) => {
    const store = getStore(c);
    const s = await load(store, c.req.param("id"));
    const q = c.req.query();
    let events = (await store.events.list(s.id)).map((e) => e.event);
    if (q.order === "desc") events = events.reverse();
    return c.json(paginate(events, { limit: q.limit ?? "100", page: q.page }));
  });

  r.post("/:id/events", async (c) => {
    const store = getStore(c);
    const s = await load(store, c.req.param("id"));
    if (s.archived_at) throw conflict("This session is archived");
    const { events } = z.object({ events: z.array(inboundEvent).min(1).max(50) }).parse(await c.req.json());
    const parsed = events as InboundEvent[];

    const waitingOn = s.stop_reason?.type === "requires_action" ? s.stop_reason.event_ids : [];
    if (waitingOn.length && parsed.some((e) => e.type === "user.message")) {
      throw badRequest("The session is waiting on tool confirmations or custom tool results; send those (or user.interrupt) first");
    }
    if (s.stop_reason?.type === "budget_reached" && parsed.some((e) => e.type === "user.message")) {
      throw conflict("The session reached its budget. Raise or remove the budget to continue.");
    }
    for (const e of parsed) {
      if (e.type === "user.define_outcome") throw badRequest("Outcomes arrive in Phase 3");
      if (e.type === "user.tool_confirmation" || e.type === "user.custom_tool_result") {
        const id = e.type === "user.tool_confirmation" ? e.tool_use_id : e.custom_tool_use_id;
        const target = await store.events.get(s.id, id);
        const wanted = e.type === "user.tool_confirmation" ? ["agent.tool_use", "agent.mcp_tool_use"] : ["agent.custom_tool_use"];
        if (!target || !wanted.includes(target.type)) throw badRequest(`${id} is not a pending ${wanted.join(" / ")} event in this session`);
      }
    }
    if (parsed.some((e) => e.type === "user.message")) await assertCanStartTurn(store, s.status);
    const stored = await runtime.receive(s, parsed);
    return c.json({ data: stored });
  });

  /**
   * SSE of new events (plus a replay after `after_seq`, an AgentOS extension).
   * `keep` filters events, e.g. to one session thread.
   */
  const sseEvents = (
    c: Parameters<typeof streamSSE>[0],
    sessionId: string,
    after: number,
    replay: (afterSeq: number) => Promise<Array<{ seq: number; event: SessionEvent }>>,
    keep: (e: SessionEvent) => boolean,
  ) =>
    streamSSE(c, async (stream) => {
      const queue: Array<{ seq: number; event: SessionEvent }> = [];
      let wake: (() => void) | null = null;
      const unsubscribe = bus.subscribe(sessionId, (seq, event) => {
        if (!keep(event as SessionEvent)) return;
        queue.push({ seq, event: event as SessionEvent });
        wake?.();
      });
      if (Number.isFinite(after)) {
        for (const r of await replay(after)) if (keep(r.event)) queue.push(r);
      }
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 15_000);
      try {
        const seen = new Set<number>();
        while (!stream.aborted) {
          while (queue.length) {
            const item = queue.shift()!;
            if (seen.has(item.seq)) continue;
            seen.add(item.seq);
            await stream.writeSSE({ event: item.event.type, id: String(item.seq), data: JSON.stringify(item.event) });
          }
          await new Promise<void>((done) => (wake = done));
          wake = null;
        }
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });

  r.get("/:id/events/stream", async (c) => {
    const store = getStore(c);
    const s = await load(store, c.req.param("id"));
    const after = Number(c.req.query("after_seq") ?? c.req.header("last-event-id") ?? NaN);
    return sseEvents(c, s.id, after, (a) => store.events.list(s.id, a), () => true);
  });

  /* ------------------------------------------- session threads (sub-agents) */

  const loadThread = async (store: ReturnType<typeof getStore>, sessionId: string, threadId: string) => {
    const t = await store.threads.get(sessionId, threadId);
    if (!t) throw notFound("Session thread", threadId);
    return t;
  };

  r.get("/:id/threads", async (c) => {
    const store = getStore(c);
    const s = await load(store, c.req.param("id"));
    const statuses = [...(c.req.queries("statuses") ?? []), ...(c.req.queries("statuses[]") ?? [])].flatMap((v) => v.split(","));
    let threads = await store.threads.list(s.id);
    if (statuses.length) threads = threads.filter((t) => statuses.includes(t.status));
    return c.json(paginate(threads, c.req.query()));
  });

  r.get("/:id/threads/:tid", async (c) => {
    const store = getStore(c);
    const s = await load(store, c.req.param("id"));
    return c.json(await loadThread(store, s.id, c.req.param("tid")));
  });

  r.post("/:id/threads/:tid/archive", async (c) => {
    const store = getStore(c);
    const s = await load(store, c.req.param("id"));
    const t = await loadThread(store, s.id, c.req.param("tid"));
    if (t.status === "running") throw conflict("Interrupt the session before archiving a running thread");
    t.archived_at ??= nowIso();
    t.updated_at = nowIso();
    await store.threads.update(t);
    return c.json(t);
  });

  r.get("/:id/threads/:tid/events", async (c) => {
    const store = getStore(c);
    const s = await load(store, c.req.param("id"));
    const t = await loadThread(store, s.id, c.req.param("tid"));
    const q = c.req.query();
    let events = (await store.events.listThread(s.id, t.id)).map((e) => e.event);
    if (q.order === "desc") events = events.reverse();
    return c.json(paginate(events, { limit: q.limit ?? "100", page: q.page }));
  });

  r.get("/:id/threads/:tid/stream", async (c) => {
    const store = getStore(c);
    const s = await load(store, c.req.param("id"));
    const t = await loadThread(store, s.id, c.req.param("tid"));
    const after = Number(c.req.query("after_seq") ?? c.req.header("last-event-id") ?? NaN);
    return sseEvents(c, s.id, after, (a) => store.events.listThread(s.id, t.id, a), (e) => e.session_thread_id === t.id);
  });

  /* ---------------------------------------------- outputs (AgentOS ext) */

  r.get("/:id/outputs", async (c) => {
    const s = await load(getStore(c), c.req.param("id"));
    const dir = resolve(SESSIONS_DIR, s.id, "outputs");
    const files: Array<{ path: string; size_bytes: number; modified_at: string }> = [];
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const name of readdirSync(d)) {
        const p = resolve(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else files.push({ path: `/mnt/session/outputs/${relative(dir, p)}`, size_bytes: st.size, modified_at: st.mtime.toISOString() });
      }
    };
    walk(dir);
    return c.json({ data: files });
  });

  r.get("/:id/outputs/content", async (c) => {
    const s = await load(getStore(c), c.req.param("id"));
    const dir = resolve(SESSIONS_DIR, s.id, "outputs");
    const rel = (c.req.query("path") ?? "").replace(/^\/mnt\/session\/outputs\/?/, "");
    const file = resolve(dir, rel);
    if (!file.startsWith(dir + "/") || !existsSync(file) || statSync(file).isDirectory()) throw notFound("Output file", rel);
    c.header("content-disposition", `attachment; filename="${file.split("/").pop()}"`);
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
  });

  return r;
}
