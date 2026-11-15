import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

// Deployments (CMA /v1/deployments, /v1/deployment_runs) through the official Anthropic SDK,
// plus the AgentOS webhook trigger. The scheduler runs every second in the test API.
const baseURL = process.env.AGENTOS_BASE_URL ?? "http://localhost:4000";
const apiKey = process.env.AGENTOS_API_KEY ?? "missing";
const client = new Anthropic({ baseURL, apiKey, maxRetries: 0 });
type Ev = { id: string; type: string; [k: string]: unknown };

let envId = "";
let agentId = "";
beforeAll(async () => {
  const env = await client.beta.environments.create({ name: "deploy-env", config: { type: "cloud", networking: { type: "unrestricted" } } } as never);
  envId = env.id;
  const agent = await client.beta.agents.create({ name: "deployed-agent", model: "mock/model", system: "v1" } as never);
  agentId = agent.id;
});

const deploy = (extra: Record<string, unknown> = {}) =>
  client.beta.deployments.create({
    name: "nightly report",
    agent: agentId,
    environment_id: envId,
    initial_events: [{ type: "user.message", content: [{ type: "text", text: "hello from the deployment" }] }],
    ...extra,
  } as never);

async function events(sessionId: string): Promise<Ev[]> {
  const out: Ev[] = [];
  for await (const e of client.beta.sessions.events.list(sessionId, { limit: 100 } as never)) out.push(e as unknown as Ev);
  return out;
}
async function idle(sessionId: string, timeoutMs = 30_000): Promise<Ev[]> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const evs = await events(sessionId);
    if (evs.some((e) => e.type === "session.status_idle")) return evs;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`session ${sessionId} did not go idle`);
}
const textOf = (e: Ev) => ((e.content as Array<{ text: string }>) ?? []).map((b) => b.text).join("");

describe("Deployments (CMA-compatible)", () => {
  it("pins the agent version, and re-pins only when the deployment is updated", async () => {
    const d = await deploy();
    expect(d.id).toMatch(/^depl_01/);
    expect(d).toMatchObject({ type: "deployment", status: "active", paused_reason: null, schedule: null, environment_id: envId });
    expect(d.agent).toEqual({ type: "agent", id: agentId, version: 1 });

    const a = await client.beta.agents.retrieve(agentId);
    await client.beta.agents.update(agentId, { version: a.version, system: "v2" } as never);
    expect((await client.beta.deployments.retrieve(d.id)).agent.version).toBe(1);

    const repinned = await client.beta.deployments.update(d.id, { agent: agentId } as never);
    expect(repinned.agent.version).toBe(2);
    const back = await client.beta.deployments.update(d.id, { agent: { type: "agent", id: agentId, version: 1 } } as never);
    expect(back.agent.version).toBe(1);
  });

  it("validates cron schedules and lists upcoming runs", async () => {
    for (const schedule of [
      { type: "cron", expression: "0 9 * * 1-5 *", timezone: "UTC" },
      { type: "cron", expression: "@daily", timezone: "UTC" },
      { type: "cron", expression: "0 9 L * *", timezone: "UTC" },
      { type: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" },
    ]) {
      await expect(deploy({ schedule })).rejects.toMatchObject({ status: 400 });
    }
    const d = await deploy({ schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "America/Los_Angeles" } });
    expect(d.schedule).toMatchObject({ type: "cron", expression: "0 9 * * 1-5", timezone: "America/Los_Angeles", last_run_at: null });
    expect(d.schedule!.upcoming_runs_at).toHaveLength(5);
    const archived = await client.beta.deployments.archive(d.id);
    expect(archived.schedule!.upcoming_runs_at).toEqual([]);
  });

  it("runs on demand: a run record, a session with the deployment's message, run history", async () => {
    const d = await deploy({ budget: { type: "limit", max_list_cost: { amount: "50", currency: "USD" } }, metadata: { team: "ops" } });
    const run = await client.beta.deployments.run(d.id);
    expect(run.id).toMatch(/^drun_01/);
    expect(run).toMatchObject({ type: "deployment_run", deployment_id: d.id, error: null, trigger_context: { type: "manual" } });
    expect(run.agent).toEqual(d.agent);
    const s = await client.beta.sessions.retrieve(run.session_id!);
    expect(s.deployment_id).toBe(d.id);
    expect(s.budget).toEqual({ type: "limit", max_list_cost: { amount: "50", currency: "USD" } });
    expect((s.metadata as Record<string, string>).team).toBe("ops");
    const evs = await idle(s.id);
    expect(textOf(evs.find((e) => e.type === "user.message")!)).toBe("hello from the deployment");
    expect(evs.some((e) => e.type === "agent.message")).toBe(true);

    expect((await client.beta.deploymentRuns.retrieve(run.id)).session_id).toBe(s.id);
    const runs = [];
    for await (const r of client.beta.deploymentRuns.list({ deployment_id: d.id })) runs.push(r);
    expect(runs.map((r) => r.id)).toEqual([run.id]);
    const scheduled = [];
    for await (const r of client.beta.deploymentRuns.list({ deployment_id: d.id, trigger_type: "schedule" })) scheduled.push(r);
    expect(scheduled).toHaveLength(0);
  });

  it("pauses and unpauses; a broken reference pauses it with the error", async () => {
    const d = await deploy();
    const paused = await client.beta.deployments.pause(d.id);
    expect(paused).toMatchObject({ status: "paused", paused_reason: { type: "manual" } });
    expect((await client.beta.deployments.unpause(d.id)).status).toBe("active");

    const env = await client.beta.environments.create({ name: "doomed", config: { type: "cloud" } } as never);
    const d2 = await deploy({ environment_id: env.id });
    await client.beta.environments.archive(env.id);
    const run = await client.beta.deployments.run(d2.id);
    expect(run.session_id).toBeNull();
    expect(run.error).toMatchObject({ type: "environment_archived_error" });
    const after = await client.beta.deployments.retrieve(d2.id);
    expect(after.status).toBe("paused");
    expect(after.paused_reason).toMatchObject({ type: "error", error: { type: "environment_archived_error" } });
    const failed = [];
    for await (const r of client.beta.deploymentRuns.list({ deployment_id: d2.id, has_error: true })) failed.push(r);
    expect(failed).toHaveLength(1);
  });

  it("fires on its cron schedule exactly once per occurrence", async () => {
    const d = await deploy({ schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" } });
    const t0 = Date.now();
    let runs: Awaited<ReturnType<typeof client.beta.deploymentRuns.retrieve>>[] = [];
    while (Date.now() - t0 < 75_000) {
      runs = [];
      for await (const r of client.beta.deploymentRuns.list({ deployment_id: d.id })) runs.push(r);
      if (runs.length) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(runs).toHaveLength(1);
    const ctx = runs[0]!.trigger_context as { type: string; scheduled_at: string };
    expect(ctx.type).toBe("schedule");
    expect(new Date(ctx.scheduled_at).getUTCSeconds()).toBe(0);
    expect(runs[0]!.session_id).toMatch(/^sesn_01/);
    await new Promise((r) => setTimeout(r, 3000)); // a few more scheduler ticks: still one run for that minute
    const again = [];
    for await (const r of client.beta.deploymentRuns.list({ deployment_id: d.id, "created_at[lte]": new Date(new Date(ctx.scheduled_at).getTime() + 59_000).toISOString() } as never)) again.push(r);
    expect(again).toHaveLength(1);
    expect((await client.beta.deployments.retrieve(d.id)).schedule!.last_run_at).toBe(ctx.scheduled_at);
    await client.beta.deployments.archive(d.id);
  }, 90_000);
});

describe("Webhook trigger (AgentOS extension)", () => {
  it("runs the deployment with the request body, and only with the current token", async () => {
    const d = await deploy();
    const hook = await fetch(`${baseURL}/v1/deployments/${d.id}/webhook`, { method: "POST", headers: { "x-api-key": apiKey } }).then((r) => r.json());
    expect(hook.token).toMatch(/^whk_/);
    expect((await client.beta.deployments.retrieve(d.id) as unknown as { x_webhook: unknown }).x_webhook).toEqual({ enabled: true });

    const post = (token: string, body: unknown) =>
      fetch(`${baseURL}${hook.url}`, { method: "POST", headers: { "x-agentos-webhook-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("whk_wrong", {})).status).toBe(401);
    const res = await post(hook.token, { ticket: 42, priority: "high" });
    expect(res.status).toBe(202);
    const run = await res.json();
    expect(run.trigger_context).toEqual({ type: "webhook" });
    const evs = await idle(run.session_id);
    const msgs = evs.filter((e) => e.type === "user.message").map(textOf);
    expect(msgs[0]).toBe("hello from the deployment");
    expect(msgs[1]).toContain('"ticket": 42');

    // Rotating replaces the token.
    const rotated = await fetch(`${baseURL}/v1/deployments/${d.id}/webhook`, { method: "POST", headers: { "x-api-key": apiKey } }).then((r) => r.json());
    expect((await post(hook.token, {})).status).toBe(401);
    expect((await post(rotated.token, {})).status).toBe(202);
    // Paused deployments refuse webhook runs.
    await client.beta.deployments.pause(d.id);
    expect((await post(rotated.token, {})).status).toBe(409);
  });
});
