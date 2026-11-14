import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

// Sub-agents as CMA session threads (multiagent_20261001, inline sub-agents), through the
// official Anthropic SDK. Runs on the trueforge runtime (the classic loop has no sub-agents).
const baseURL = process.env.AGENTOS_BASE_URL ?? "http://localhost:4000";
const client = new Anthropic({ baseURL, apiKey: process.env.AGENTOS_API_KEY ?? "missing", maxRetries: 0 });
type Ev = { id: string; type: string; [k: string]: unknown };

let envId = "";
let runtime = "";
beforeAll(async () => {
  runtime = (await fetch(`${baseURL}/health`).then((r) => r.json())).runtime?.engine ?? "";
  const env = await client.beta.environments.create({ name: "threads-env", config: { type: "cloud", networking: { type: "unrestricted" } } } as never);
  envId = env.id;
});

async function events(sessionId: string): Promise<Ev[]> {
  const out: Ev[] = [];
  for await (const e of client.beta.sessions.events.list(sessionId, { limit: 100 } as never)) out.push(e as unknown as Ev);
  return out;
}
async function idle(sessionId: string, count = 1, timeoutMs = 30_000): Promise<Ev[]> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const evs = await events(sessionId);
    if (evs.filter((e) => e.type === "session.status_idle").length >= count) return evs;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`session ${sessionId} did not go idle`);
}
const textOf = (e: Ev) => ((e.content as Array<{ text: string }>) ?? []).map((b) => b.text).join("");
const lastIdle = (evs: Ev[]) => evs.filter((e) => e.type === "session.status_idle").at(-1)!;

function agent(policy: "always_allow" | "always_ask", multiagent: unknown = { type: "multiagent_20261001" }) {
  return client.beta.agents.create({
    name: "lead", model: "mock/model", system: "You lead a team.",
    tools: [{ type: "agent_toolset_20260401", default_config: { permission_policy: { type: policy } } }],
    multiagent,
  } as never);
}

describe("Multiagent config", () => {
  it("resolves defaults: inline sub-agents on, advisor and workflows off", async () => {
    const a = await agent("always_allow");
    expect(a.multiagent).toEqual({
      type: "multiagent_20261001",
      subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [] },
      advisor: { type: "disabled" },
      workflows: { type: "disabled" },
    });
    const off = await client.beta.agents.update(a.id, { version: a.version, multiagent: { type: "multiagent_20261001", subagents: { type: "disabled" } } } as never);
    expect((off.multiagent as { subagents: unknown }).subagents).toEqual({ type: "disabled" });
  });

  it("rejects what AgentOS doesn't support yet, instead of ignoring it", async () => {
    for (const multiagent of [
      { type: "multiagent_20261001", subagents: { type: "enabled", predefined_agents: ["agent_01x"] } },
      { type: "multiagent_20261001", advisor: { type: "enabled", model: "x" } },
      { type: "multiagent_20261001", workflows: { type: "enabled" } },
    ]) {
      await expect(agent("always_allow", multiagent)).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe("Sub-agent threads", () => {
  it("delegates to an inline sub-agent and reports it as a session thread", async () => {
    if (runtime !== "trueforge-core") return;
    const a = await agent("always_allow");
    const s = await client.beta.sessions.create({
      agent: a.id, environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "use subagent" }] }],
    } as never);
    const evs = await idle(s.id);
    const primary = evs.filter((e) => !e.session_thread_id || e.type.startsWith("session.thread_"));
    const types = primary.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining([
      "session.thread_created", "agent.thread_message_sent", "session.thread_status_running",
      "agent.thread_message_received", "session.thread_status_idle",
    ]));
    // Delegation is represented by thread events, not as a tool call.
    expect(evs.some((e) => e.type === "agent.tool_use" && e.name === "create_sub_agent")).toBe(false);

    const created = evs.find((e) => e.type === "session.thread_created")!;
    const tid = String(created.session_thread_id);
    expect(tid).toMatch(/^sthr_01/);
    expect(created.agent_name).toBe("Helper");
    expect(textOf(evs.find((e) => e.type === "agent.thread_message_sent")!)).toBe("subtask: count to three");
    const received = evs.find((e) => e.type === "agent.thread_message_received")!;
    expect(received.from_session_thread_id).toBe(tid);
    expect(textOf(received)).toContain("Subagent result: count to three");
    expect(evs.find((e) => e.type === "session.thread_status_idle")!.stop_reason).toEqual({ type: "end_turn" });
    expect(textOf(evs.filter((e) => e.type === "agent.message" && !e.session_thread_id).at(-1)!)).toContain("Subagent result");
    expect(lastIdle(evs).stop_reason).toEqual({ type: "end_turn" });

    const threads = [];
    for await (const t of client.beta.sessions.threads.list(s.id)) threads.push(t);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: tid, type: "session_thread", session_id: s.id, parent_thread_id: null, status: "idle" });
    expect(threads[0]!.agent).toMatchObject({ type: "inline", name: "Helper" });
    expect(Number((threads[0]!.usage as { cost_usd: string }).cost_usd)).toBeGreaterThan(0);

    const one = await client.beta.sessions.threads.retrieve(tid, { session_id: s.id });
    expect(one.id).toBe(tid);
    const threadEvents: Ev[] = [];
    for await (const e of client.beta.sessions.threads.events.list(tid, { session_id: s.id })) threadEvents.push(e as unknown as Ev);
    const childMsg = threadEvents.find((e) => e.type === "agent.message")!;
    expect(childMsg.session_thread_id).toBe(tid);
    expect(textOf(childMsg)).toContain("Subagent result");

    // Session cost includes the sub-agent's model calls.
    const fresh = await client.beta.sessions.retrieve(s.id);
    expect(Number((fresh.usage as unknown as { cost_usd: string }).cost_usd)).toBeCloseTo(0.003, 5);
  });

  it("pauses for an approval inside a sub-agent, then continues after allow", async () => {
    if (runtime !== "trueforge-core") return;
    const a = await agent("always_ask");
    const s = await client.beta.sessions.create({
      agent: a.id, environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "use subagent with bash" }] }],
    } as never);
    let evs = await idle(s.id);
    const use = evs.find((e) => e.type === "agent.tool_use")!;
    const tid = String(evs.find((e) => e.type === "session.thread_created")!.session_thread_id);
    expect(use).toMatchObject({ name: "bash", evaluated_permission: "ask", session_thread_id: tid });
    expect(lastIdle(evs).stop_reason).toEqual({ type: "requires_action", event_ids: [use.id] });

    await client.beta.sessions.events.send(s.id, { events: [{ type: "user.tool_confirmation", tool_use_id: use.id, result: "allow" }] } as never);
    evs = await idle(s.id, 2);
    const result = evs.find((e) => e.type === "agent.tool_result")!;
    expect(result).toMatchObject({ tool_use_id: use.id, is_error: false, session_thread_id: tid });
    expect(textOf(result)).toContain("from-subagent");
    expect(textOf(evs.find((e) => e.type === "agent.thread_message_received")!)).toContain("from-subagent");
    expect(lastIdle(evs).stop_reason).toEqual({ type: "end_turn" });
  });

  it("without multiagent the model has no sub-agent tool", async () => {
    if (runtime !== "trueforge-core") return;
    const a = await agent("always_allow", null);
    const s = await client.beta.sessions.create({
      agent: a.id, environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "use subagent" }] }],
    } as never);
    const evs = await idle(s.id);
    expect(evs.some((e) => e.type === "session.thread_created")).toBe(false);
    const use = evs.find((e) => e.type === "agent.tool_use" && e.name === "create_sub_agent")!;
    expect(use.x_unknown_tool).toBe(true);
    const threads = [];
    for await (const t of client.beta.sessions.threads.list(s.id)) threads.push(t);
    expect(threads).toHaveLength(0);
  });
});
