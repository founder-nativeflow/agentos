import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

// Sessions driven end to end through the official Anthropic SDK:
// real API + Postgres + Docker sandbox; only the model is a scripted mock.
const baseURL = process.env.AGENTOS_BASE_URL ?? "http://localhost:4000";
const client = new Anthropic({ baseURL, apiKey: process.env.AGENTOS_API_KEY ?? "missing", maxRetries: 0 });
type Ev = { id: string; type: string; [k: string]: unknown };

let envId = "";
const toolset = (policy: "always_allow" | "always_ask") => [
  { type: "agent_toolset_20260401", default_config: { permission_policy: { type: policy } } },
];

async function agent(name: string, extra: Record<string, unknown> = {}) {
  return client.beta.agents.create({ name, model: "mock/model", system: "Test agent.", tools: toolset("always_allow"), ...extra } as never);
}

async function events(sessionId: string): Promise<Ev[]> {
  const out: Ev[] = [];
  for await (const e of client.beta.sessions.events.list(sessionId, { limit: 100 } as never)) out.push(e as unknown as Ev);
  return out;
}

/** Waits until the session has emitted `count` session.status_idle events. */
async function idle(sessionId: string, count = 1, timeoutMs = 60_000): Promise<Ev[]> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const evs = await events(sessionId);
    if (evs.filter((e) => e.type === "session.status_idle").length >= count) return evs;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`session ${sessionId} did not go idle`);
}

const lastIdle = (evs: Ev[]) => evs.filter((e) => e.type === "session.status_idle").at(-1)!;
const textOf = (e: Ev) => ((e.content as Array<{ text: string }>) ?? []).map((b) => b.text).join("");

beforeAll(async () => {
  const env = await client.beta.environments.create({ name: "conformance-env", config: { type: "cloud", networking: { type: "unrestricted" } } } as never);
  envId = env.id;
  expect(envId).toMatch(/^env_01/);
});

describe("Sessions (CMA-compatible)", () => {
  it("runs a turn: model → bash in the sandbox → result → reply, with usage and outputs", async () => {
    const a = await agent("bash-agent");
    const s = await client.beta.sessions.create({
      agent: a.id, environment_id: envId, title: "bash test",
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "use bash" }] }],
    } as never);
    expect(s.id).toMatch(/^sesn_01/);
    const evs = await idle(s.id);
    const types = evs.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["user.message", "session.status_running", "span.model_request_start",
      "span.model_request_end", "agent.message", "agent.tool_use", "agent.tool_result", "session.status_idle"]));
    const use = evs.find((e) => e.type === "agent.tool_use")!;
    expect(use.name).toBe("bash");
    expect(use.evaluated_permission).toBe("allow");
    const result = evs.find((e) => e.type === "agent.tool_result")!;
    expect(result.tool_use_id).toBe(use.id);
    expect(textOf(result)).toContain("hello");
    expect(lastIdle(evs).stop_reason).toEqual({ type: "end_turn" });
    expect(textOf(evs.filter((e) => e.type === "agent.message").at(-1)!)).toContain("hello");

    const fresh = await client.beta.sessions.retrieve(s.id);
    expect(fresh.status).toBe("idle");
    expect(fresh.usage.cache_read_input_tokens).toBeGreaterThan(0);
    expect(Number((fresh.usage as unknown as { cost_usd: string }).cost_usd)).toBeGreaterThan(0);

    const outputs = await fetch(`${baseURL}/v1/sessions/${s.id}/outputs`, { headers: { "x-api-key": process.env.AGENTOS_API_KEY! } }).then((r) => r.json());
    expect(outputs.data.map((f: { path: string }) => f.path)).toContain("/mnt/session/outputs/hello.txt");
  });

  it("pauses for approval (always_ask), then runs after allow", async () => {
    const a = await agent("ask-agent", { tools: toolset("always_ask") });
    const s = await client.beta.sessions.create({ agent: a.id, environment_id: envId } as never);
    await client.beta.sessions.events.send(s.id, { events: [{ type: "user.message", content: [{ type: "text", text: "use bash" }] }] } as never);
    let evs = await idle(s.id);
    const use = evs.find((e) => e.type === "agent.tool_use")!;
    expect(use.evaluated_permission).toBe("ask");
    expect(lastIdle(evs).stop_reason).toEqual({ type: "requires_action", event_ids: [use.id] });
    expect(evs.some((e) => e.type === "agent.tool_result")).toBe(false);

    // A new user message is rejected while approvals are pending.
    await expect(client.beta.sessions.events.send(s.id, { events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }] } as never))
      .rejects.toBeInstanceOf(Anthropic.BadRequestError);

    await client.beta.sessions.events.send(s.id, { events: [{ type: "user.tool_confirmation", tool_use_id: use.id, result: "allow" }] } as never);
    evs = await idle(s.id, 2);
    expect(textOf(evs.find((e) => e.type === "agent.tool_result")!)).toContain("hello");
    expect(lastIdle(evs).stop_reason).toEqual({ type: "end_turn" });
  });

  it("deny returns an error result to the model", async () => {
    const a = await agent("deny-agent", { tools: toolset("always_ask") });
    const s = await client.beta.sessions.create({ agent: a.id, environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "use bash" }] }] } as never);
    let evs = await idle(s.id);
    const use = evs.find((e) => e.type === "agent.tool_use")!;
    await client.beta.sessions.events.send(s.id, { events: [{ type: "user.tool_confirmation", tool_use_id: use.id, result: "deny", deny_message: "not now" }] } as never);
    evs = await idle(s.id, 2);
    const result = evs.find((e) => e.type === "agent.tool_result")!;
    expect(result.is_error).toBe(true);
    expect(textOf(result)).toContain("not now");
  });

  it("custom tools wait for the client's result", async () => {
    const a = await agent("custom-agent", {
      tools: [{ type: "custom", name: "lookup_order", description: "Look up an order", input_schema: { type: "object", properties: { order_id: { type: "string" } } } }],
    });
    const s = await client.beta.sessions.create({ agent: a.id, environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "custom" }] }] } as never);
    let evs = await idle(s.id);
    const use = evs.find((e) => e.type === "agent.custom_tool_use")!;
    expect(use.input).toEqual({ order_id: "42" });
    expect(lastIdle(evs).stop_reason).toEqual({ type: "requires_action", event_ids: [use.id] });
    await client.beta.sessions.events.send(s.id, { events: [{ type: "user.custom_tool_result", custom_tool_use_id: use.id, content: [{ type: "text", text: "shipped" }] }] } as never);
    evs = await idle(s.id, 2);
    expect(textOf(evs.filter((e) => e.type === "agent.message").at(-1)!)).toContain("shipped");
  });

  it("user.interrupt stops a running tool", async () => {
    const a = await agent("slow-agent");
    const s = await client.beta.sessions.create({ agent: a.id, environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "slow" }] }] } as never);
    const t0 = Date.now();
    while (!(await events(s.id)).some((e) => e.type === "agent.tool_use") && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 500));
    await client.beta.sessions.events.send(s.id, { events: [{ type: "user.interrupt" }] } as never);
    const evs = await idle(s.id, 1, 20_000);
    const result = evs.find((e) => e.type === "agent.tool_result")!;
    expect(result.is_error).toBe(true);
    expect(Date.now() - t0).toBeLessThan(25_000);
  });

  it("stops at the budget (budget_reached) and blocks new messages", async () => {
    const a = await agent("budget-agent");
    const s = await client.beta.sessions.create({ agent: a.id, environment_id: envId,
      budget: { type: "limit", max_list_cost: { amount: "1", currency: "USD" } },
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "budget loop" }] }] } as never);
    const evs = await idle(s.id);
    expect(lastIdle(evs).stop_reason).toEqual({ type: "budget_reached" });
    expect(evs.filter((e) => e.type === "span.model_request_start").length).toBe(1);
    await expect(client.beta.sessions.events.send(s.id, { events: [{ type: "user.message", content: [{ type: "text", text: "more" }] }] } as never))
      .rejects.toBeInstanceOf(Anthropic.ConflictError);
  });

  it("invalid tool JSON from the model becomes an error result, not a crash", async () => {
    const a = await agent("json-agent");
    const s = await client.beta.sessions.create({ agent: a.id, environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "bad json" }] }] } as never);
    const evs = await idle(s.id);
    const result = evs.find((e) => e.type === "agent.tool_result")!;
    expect(result.is_error).toBe(true);
    expect(lastIdle(evs).stop_reason).toEqual({ type: "end_turn" });
  });

  it("streams events over SSE with the SDK", async () => {
    const a = await agent("stream-agent");
    const s = await client.beta.sessions.create({ agent: a.id, environment_id: envId } as never);
    const stream = await client.beta.sessions.events.stream(s.id);
    await client.beta.sessions.events.send(s.id, { events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }] } as never);
    const seen: string[] = [];
    for await (const e of stream as AsyncIterable<Ev>) {
      seen.push(e.type);
      if (e.type === "session.status_idle") break;
    }
    expect(seen).toEqual(expect.arrayContaining(["user.message", "session.status_running", "agent.message", "session.status_idle"]));
  });

  it("archives a session and removes its sandbox", async () => {
    const a = await agent("archive-agent");
    const s = await client.beta.sessions.create({ agent: a.id, environment_id: envId } as never);
    const archived = await client.beta.sessions.archive(s.id);
    expect(archived.archived_at).toBeTruthy();
    expect(archived.status).toBe("terminated");
  });
});
