import { beforeAll, describe, expect, it } from "vitest";

// Workflows and the builder (AgentOS extensions under /v1/x), against the scripted mock model.
const baseURL = process.env.AGENTOS_BASE_URL ?? "http://localhost:4000";
const apiKey = process.env.AGENTOS_API_KEY ?? "missing";
type J = Record<string, any>;

async function api(path: string, init: { method?: string; json?: unknown } = {}): Promise<{ status: number; body: J }> {
  const res = await fetch(`${baseURL}${path}`, {
    method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as J };
}
const ok = async (path: string, init?: { method?: string; json?: unknown }) => {
  const r = await api(path, init);
  if (r.status !== 200) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
async function finished(runId: string, timeoutMs = 60_000): Promise<J> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await ok(`/v1/x/workflow_runs/${runId}`);
    if (r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`run ${runId} did not finish`);
}

let envId = "";
const agents: Record<string, string> = {};
beforeAll(async () => {
  envId = (await ok("/v1/environments", { json: { name: "wf-env", config: { type: "cloud" } } })).id;
  for (const k of ["classifier", "pager", "writer", "plain"]) {
    agents[k] = (await ok("/v1/agents", { json: { name: `wf-${k}`, model: "mock/model" } })).id;
  }
});

const triage = (extra: J = {}) => ({
  name: "Triage",
  environment_id: envId,
  nodes: [
    { type: "start", id: "start", label: "Start" },
    { type: "agent", id: "classify", label: "Classify", agent: { id: agents.classifier }, prompt: "Classify. End with a line SEVERITY: P1|P2|P3.\n\n{{input}}" },
    { type: "condition", id: "is_p1", label: "P1?", source: "{{nodes.classify.output}}", operator: "contains", value: "SEVERITY: P1" },
    { type: "agent", id: "page", label: "Page", agent: { id: agents.pager }, prompt: "Write the on-call page for: {{input}}" },
    { type: "agent", id: "draft", label: "Draft", agent: { id: agents.writer }, prompt: "Draft a reply to: {{input}}" },
    { type: "output", id: "result", label: "Result", template: "page={{nodes.page.output}} reply={{nodes.draft.output}}" },
  ],
  edges: [
    { id: "e1", source: "start", target: "classify" },
    { id: "e2", source: "classify", target: "is_p1" },
    { id: "e3", source: "is_p1", target: "page", branch: "true" },
    { id: "e4", source: "is_p1", target: "draft", branch: "false" },
    { id: "e5", source: "page", target: "result" },
    { id: "e6", source: "draft", target: "result" },
  ],
  ...extra,
});

describe("Workflows", () => {
  it("validates graphs: start, loops, references, branches", async () => {
    const v = async (nodes: J[], edges: J[]) => (await ok("/v1/x/workflows/validate", { json: { nodes, edges } })).problems as string[];
    expect(await v(triage().nodes, triage().edges)).toEqual([]);
    expect((await v([{ type: "output", id: "o", label: "O", template: "x" }], [])).join()).toMatch(/exactly one Start/);
    const loop = await v(
      [{ type: "start", id: "start", label: "S" }, { type: "agent", id: "a", label: "A", agent: { id: "x" }, prompt: "p" }, { type: "agent", id: "b", label: "B", agent: { id: "x" }, prompt: "p" }],
      [{ id: "1", source: "start", target: "a" }, { id: "2", source: "a", target: "b" }, { id: "3", source: "b", target: "a" }],
    );
    expect(loop.join()).toMatch(/loop/);
    const badRef = await v(
      [{ type: "start", id: "start", label: "S" }, { type: "agent", id: "a", label: "A", agent: { id: "x" }, prompt: "{{nodes.b.output}}" }, { type: "agent", id: "b", label: "B", agent: { id: "x" }, prompt: "p" }],
      [{ id: "1", source: "start", target: "a" }, { id: "2", source: "start", target: "b" }],
    );
    expect(badRef.join()).toMatch(/doesn't run before it/);
    const t = triage();
    t.edges[2] = { ...t.edges[2], branch: null } as never;
    expect((await v(t.nodes, t.edges)).join()).toMatch(/branch "true" or "false"/);
    const logic = triage();
    (logic.nodes[5] as J).template = "{% if nodes.is_p1.output %}{{nodes.page.output}}{% endif %} {{nodes.page.value}}";
    const tplProblems = (await v(logic.nodes, logic.edges)).join();
    expect(tplProblems).toMatch(/\{% \.\.\. %\} logic/);
    expect(tplProblems).toMatch(/only \{\{input\}\} and/);
    expect((await api("/v1/x/workflows", { json: triage({ environment_id: "env_missing" }) })).status).toBe(400);
  });

  it("runs the branch the condition picks; the other branch is skipped; each agent step is a session", async () => {
    const wf = await ok("/v1/x/workflows", { json: triage() });
    expect(wf).toMatchObject({ type: "workflow", version: 1 });
    expect(wf.id).toMatch(/^wf_01/);

    const p1 = await finished((await ok(`/v1/x/workflows/${wf.id}/runs`, { json: { input: "Checkout is down (outage)" } })).id);
    expect(p1.status).toBe("succeeded");
    expect(p1.steps.is_p1).toMatchObject({ status: "succeeded", branch: "true" });
    expect(p1.steps.page.status).toBe("succeeded");
    expect(p1.steps.draft.status).toBe("skipped");
    expect(p1.output).toBe("page=PAGE: checkout outage reply=");
    const s = await ok(`/v1/sessions/${p1.steps.classify.session_id}`);
    expect(s.metadata).toMatchObject({ "agentos.workflow_run": p1.id, "agentos.workflow_step": "classify" });
    expect(Number(p1.cost_usd)).toBeGreaterThan(0);

    const p3 = await finished((await ok(`/v1/x/workflows/${wf.id}/runs`, { json: { input: "How do I change my password?" } })).id);
    expect(p3.steps.is_p1.branch).toBe("false");
    expect([p3.steps.page.status, p3.steps.draft.status]).toEqual(["skipped", "succeeded"]);
    const runs = await ok(`/v1/x/workflows/${wf.id}/runs`);
    expect(runs.data.map((r: J) => r.id)).toEqual([p3.id, p1.id]);
  });

  it("runs independent steps in parallel and joins them; a router picks a route with the model", async () => {
    const wf = await ok("/v1/x/workflows", {
      json: {
        name: "Fan out", environment_id: envId,
        nodes: [
          { type: "start", id: "start", label: "S" },
          { type: "router", id: "route", label: "Route", source: "{{input}}", routes: [{ key: "billing", description: "money" }, { key: "bug", description: "broken" }] },
          { type: "agent", id: "a", label: "A", agent: { id: agents.plain }, prompt: "Step marker A {{input}}" },
          { type: "agent", id: "b", label: "B", agent: { id: agents.plain }, prompt: "Step marker B {{input}}" },
          { type: "agent", id: "c", label: "C", agent: { id: agents.plain }, prompt: "Step marker C" },
          { type: "output", id: "out", label: "Out", template: "{{nodes.a.output}} | {{nodes.b.output}}" },
        ],
        edges: [
          { id: "1", source: "start", target: "route" },
          { id: "2", source: "route", target: "a", branch: "billing" },
          { id: "3", source: "route", target: "c", branch: "bug" },
          { id: "4", source: "start", target: "b" },
          { id: "5", source: "a", target: "out" },
          { id: "6", source: "b", target: "out" },
        ],
      },
    });
    const run = await finished((await ok(`/v1/x/workflows/${wf.id}/runs`, { json: { input: "a billing question" } })).id);
    expect(run.status).toBe("succeeded");
    expect(run.steps.route).toMatchObject({ status: "succeeded", branch: "billing" });
    expect(run.steps.c.status).toBe("skipped");
    expect(run.output).toBe("Done: A a billing question | Done: B a billing question");
    // a and b overlapped: b started before a finished.
    expect(run.steps.b.started_at < run.steps.a.ended_at).toBe(true);
  });

  it("versions changes; moving steps around doesn't make a new version", async () => {
    const wf = await ok("/v1/x/workflows", { json: triage() });
    const moved = await ok(`/v1/x/workflows/${wf.id}`, { json: { nodes: wf.nodes.map((n: J, i: number) => ({ ...n, position: { x: i * 10, y: 5 } })) } });
    expect(moved.version).toBe(1);
    expect((await ok(`/v1/x/workflows/${wf.id}`)).nodes[2].position).toEqual({ x: 20, y: 5 });
    const nodes = moved.nodes.map((n: J) => (n.id === "draft" ? { ...n, prompt: "Draft a reply to: {{input}} (be brief)" } : n));
    const v2 = await ok(`/v1/x/workflows/${wf.id}`, { json: { version: 1, nodes } });
    expect(v2.version).toBe(2);
    expect((await api(`/v1/x/workflows/${wf.id}`, { json: { version: 1, name: "stale" } })).status).toBe(409);
    expect((await ok(`/v1/x/workflows/${wf.id}?version=1`)).nodes.find((n: J) => n.id === "draft").prompt).not.toContain("be brief");
  });

  it("a failing step fails the run and skips what depends on it", async () => {
    const doomed = (await ok("/v1/agents", { json: { name: "wf-doomed", model: "mock/model" } })).id;
    const wf = await ok("/v1/x/workflows", {
      json: {
        name: "Fails", environment_id: envId,
        nodes: [
          { type: "start", id: "start", label: "S" },
          { type: "agent", id: "a", label: "A", agent: { id: doomed }, prompt: "Step marker A" },
          { type: "output", id: "out", label: "Out", template: "{{nodes.a.output}}" },
        ],
        edges: [{ id: "1", source: "start", target: "a" }, { id: "2", source: "a", target: "out" }],
      },
    });
    await ok(`/v1/agents/${doomed}/archive`, { json: {} });
    const run = await finished((await ok(`/v1/x/workflows/${wf.id}/runs`, { json: { input: "" } })).id);
    expect(run.status).toBe("failed");
    expect(run.steps.a.status).toBe("failed");
    expect(run.steps.a.error).toMatch(/Archived agents/);
    expect(run.steps.out.status).toBe("skipped");
    expect(run.error.type).toBe("workflow_step_failed");
  });

  it("cancels a run and stops its running sessions", async () => {
    const slow = (await ok("/v1/agents", { json: { name: "wf-slow", model: "mock/model", tools: [{ type: "agent_toolset_20260401" }] } })).id;
    const env = (await ok("/v1/environments", { json: { name: "wf-local", config: { type: "local" } } })).id;
    const wf = await ok("/v1/x/workflows", {
      json: {
        name: "Slow", environment_id: env,
        nodes: [{ type: "start", id: "start", label: "S" }, { type: "agent", id: "a", label: "A", agent: { id: slow }, prompt: "slow" }],
        edges: [{ id: "1", source: "start", target: "a" }],
      },
    });
    const run = await ok(`/v1/x/workflows/${wf.id}/runs`, { json: { input: "" } });
    for (let i = 0; i < 40; i++) {
      if ((await ok(`/v1/x/workflow_runs/${run.id}`)).steps.a.session_id) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const t0 = Date.now();
    const cancelled = await ok(`/v1/x/workflow_runs/${run.id}/cancel`, { json: {} });
    expect(cancelled.status).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((await api(`/v1/x/workflow_runs/${run.id}/cancel`, { json: {} })).status).toBe(409);
  }, 60_000);
});

describe("Builder", () => {
  it("turns a short request into a structured workflow plan, revises it, creates it, and test-runs it", async () => {
    const chat = await ok("/v1/x/builder/chats", { json: { message: "Triage new support tickets", model: "mock/model" } });
    expect(chat.id).toMatch(/^bchat_01/);
    expect(chat.title).toBe("Ticket triage");
    expect(chat.plan.kind).toBe("workflow");
    expect(chat.plan.steps.length).toBeGreaterThan(0);
    expect(chat.plan.workflow.nodes.every((n: J) => n.position && typeof n.position.x === "number")).toBe(true);
    expect(chat.messages.map((m: J) => m.role)).toEqual(["user", "assistant"]);
    expect(chat.applied).toBeNull();

    const moved = structuredClone(chat.plan);
    moved.workflow.nodes[0].position = { x: -100, y: -100 };
    await ok(`/v1/x/builder/chats/${chat.id}/plan`, { json: { plan: moved } });

    const revised = await ok(`/v1/x/builder/chats/${chat.id}/messages`, { json: { message: "Also add a summary step" } });
    expect(revised.messages.at(-1).changes).toEqual(["Added a Summarise step after Classify"]);
    expect(revised.plan.workflow.nodes.map((n: J) => n.id)).toContain("summary");
    expect(revised.plan.workflow.nodes[0].position).toEqual({ x: -100, y: -100 }); // kept the person's layout

    const applied = await ok(`/v1/x/builder/chats/${chat.id}/apply`, { json: {} });
    expect(Object.keys(applied.applied.agents).sort()).toEqual(["classifier", "pager", "writer"]);
    const wf = await ok(`/v1/x/workflows/${applied.applied.workflow_id}`);
    expect(wf.nodes.find((n: J) => n.id === "classify").agent.id).toBe(applied.applied.agents.classifier);
    expect(wf.environment_id).toBe(applied.applied.environment_id);

    const again = await ok(`/v1/x/builder/chats/${chat.id}/apply`, { json: {} });
    expect(again.applied.workflow_id).toBe(wf.id);
    expect((await ok(`/v1/x/workflows/${wf.id}`)).version).toBe(1);
    expect((await ok(`/v1/agents/${applied.applied.agents.classifier}`)).version).toBe(1);

    const test = await ok(`/v1/x/builder/chats/${chat.id}/test`, { json: {} });
    expect(test.type).toBe("workflow_run");
    const run = await finished(test.id);
    expect(run.status).toBe("succeeded");
    expect(run.trigger).toEqual({ type: "builder_test" });
    expect(run.steps.page.status).toBe("succeeded");
  }, 90_000);

  it("repairs an invalid plan once, and builds single agents", async () => {
    const fixed = await ok("/v1/x/builder/chats", { json: { message: "broken plan please", model: "mock/model" } });
    expect(fixed.plan.workflow.nodes.find((n: J) => n.id === "classify").agent_key).toBe("classifier");

    const single = await ok("/v1/x/builder/chats", { json: { message: "A research assistant", model: "mock/model" } });
    expect(single.plan).toMatchObject({ kind: "agent", workflow: null });
    expect((await api(`/v1/x/builder/chats/${single.id}/test`, { json: {} })).status).toBe(409);
    const applied = await ok(`/v1/x/builder/chats/${single.id}/apply`, { json: {} });
    expect(applied.applied.workflow_id).toBeNull();
    const test = await ok(`/v1/x/builder/chats/${single.id}/test`, { json: {} });
    expect(test.type).toBe("session");
    expect((await ok("/v1/x/builder/chats")).data.map((c: J) => c.id)).toContain(single.id);
    await ok(`/v1/x/builder/chats/${single.id}`, { method: "DELETE" });
    expect((await api(`/v1/x/builder/chats/${single.id}`)).status).toBe(404);
  }, 60_000);
});
