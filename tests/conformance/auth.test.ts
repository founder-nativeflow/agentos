import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

// Supabase Auth mode (AGENTOS_AUTH=supabase): users, workspaces, roles and workspace-bound
// API keys. Runs only when the API under test is in that mode:
//   AGENTOS_TEST_AUTH=supabase pnpm test:conformance
const baseURL = process.env.AGENTOS_BASE_URL ?? "http://localhost:4000";
const TAG = process.env.AGENTOS_TEST_RUN_TAG ?? "conf";
let mode = "";

/** A signed-in Console user (cookie session). */
class User {
  cookies = new Map<string, string>();
  constructor(readonly email: string) {}
  async call(path: string, init: { method?: string; json?: unknown; workspace?: string } = {}) {
    const res = await fetch(`${baseURL}${path}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers: {
        "content-type": "application/json",
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(init.workspace ? { "anthropic-workspace-id": init.workspace } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair!.split("=");
      if (v) this.cookies.set(k!, v);
      else this.cookies.delete(k!);
    }
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
  }
}

async function signUp(name: string, workspace: string) {
  const u = new User(`${TAG}-${name}@example.test`);
  const r = await u.call("/v1/x/auth/signup", { json: { email: u.email, password: `${name}-pass-1234`, workspace_name: workspace } });
  expect(r.status).toBe(200);
  return { user: u, workspace: String(r.body.workspace_id) };
}

async function keyFor(u: User, workspace?: string) {
  const r = await u.call("/v1/x/api_keys", { json: { name: "test" }, workspace });
  expect(r.status).toBe(200);
  return new Anthropic({ baseURL, apiKey: r.body.key, maxRetries: 0 });
}

beforeAll(async () => {
  mode = (await fetch(`${baseURL}/health`).then((r) => r.json())).auth ?? "local";
});

describe("Supabase Auth mode", () => {
  it("isolates workspaces: one user's agents are invisible to another", async () => {
    if (mode !== "supabase") return;
    const a = await signUp("alice", "Alice Co");
    const b = await signUp("bob", "Bob Co");
    expect(a.workspace).toMatch(/^wrkspc_01/);
    const alice = await keyFor(a.user);
    const bob = await keyFor(b.user);

    const agent = await alice.beta.agents.create({ name: "alice-agent", model: "mock/model" } as never);
    const bobs: string[] = [];
    for await (const x of bob.beta.agents.list()) bobs.push(x.id);
    expect(bobs).not.toContain(agent.id);
    await expect(bob.beta.agents.retrieve(agent.id)).rejects.toMatchObject({ status: 404 });

    // A key belongs to one workspace; asking for another is refused.
    await expect(alice.beta.agents.list({ workspace_id: b.workspace } as never)).rejects.toMatchObject({ status: 403 });
    // A user can't select a workspace they don't belong to.
    expect((await b.user.call("/v1/agents", { workspace: a.workspace })).status).toBe(403);

    const me = await a.user.call("/v1/x/auth/me");
    expect(me.body.workspace).toMatchObject({ id: a.workspace, name: "Alice Co", role: "admin" });
  });

  it("enforces roles: viewers read, developers write, admins manage members", async () => {
    if (mode !== "supabase") return;
    const owner = await signUp("owner2", "Team");
    const member = await signUp("member2", "Member's own");
    const ownerKey = await keyFor(owner.user);
    await ownerKey.beta.agents.create({ name: "team-agent", model: "mock/model" } as never);

    // Owner adds the member as a viewer.
    const add = await owner.user.call("/v1/x/workspace/members", { json: { email: member.user.email, role: "viewer" } });
    expect(add.status).toBe(200);
    const viewerList = await member.user.call("/v1/agents", { workspace: owner.workspace });
    expect(viewerList.status).toBe(200);
    expect(viewerList.body.data.map((x: { name: string }) => x.name)).toContain("team-agent");
    const viewerWrite = await member.user.call("/v1/agents", { workspace: owner.workspace, json: { name: "nope", model: "mock/model" } });
    expect(viewerWrite.status).toBe(403);
    // Members can't manage members.
    expect((await member.user.call("/v1/x/workspace/members", { workspace: owner.workspace, json: { email: owner.user.email, role: "viewer" } })).status).toBe(403);

    // Promote to developer: writes are allowed now.
    const memberId = String(add.body.user_id);
    expect((await owner.user.call(`/v1/x/workspace/members/${memberId}`, { json: { role: "developer" } })).status).toBe(200);
    expect((await member.user.call("/v1/agents", { workspace: owner.workspace, json: { name: "dev-agent", model: "mock/model" } })).status).toBe(200);

    // The last admin can't be removed or demoted.
    const ownerId = String((await owner.user.call("/v1/x/auth/me")).body.actor.id);
    expect((await owner.user.call(`/v1/x/workspace/members/${ownerId}`, { method: "DELETE" })).status).toBe(409);
    const members = await owner.user.call("/v1/x/workspace/members");
    expect(members.body.data.map((m: { email: string; role: string }) => `${m.email}:${m.role}`).sort()).toEqual(
      [`${member.user.email}:developer`, `${owner.user.email}:admin`].sort(),
    );

    // Switching workspaces: the member's own workspace and the team's are both listed.
    const ws = await member.user.call("/v1/x/workspaces");
    expect(ws.body.data.map((w: { id: string }) => w.id).sort()).toEqual([member.workspace, owner.workspace].sort());
    expect((await member.user.call(`/v1/x/workspaces/${owner.workspace}/select`, { json: {} })).status).toBe(200);
    expect((await member.user.call("/v1/x/auth/me")).body.workspace.id).toBe(owner.workspace);
  });

  it("rejects bad credentials and signs out", async () => {
    if (mode !== "supabase") return;
    const u = new User(`${TAG}-nobody@example.test`);
    expect((await u.call("/v1/x/auth/login", { json: { email: u.email, password: "wrong-password" } })).status).toBe(401);
    const s = await signUp("carol", "Carol Co");
    expect((await s.user.call("/v1/agents")).status).toBe(200);
    await s.user.call("/v1/x/auth/logout", { json: {} });
    expect((await s.user.call("/v1/agents")).status).toBe(401);
  });

  it("uses each workspace's own OpenRouter key (BYOK), never returning it", async () => {
    if (mode !== "supabase") return;
    const mock = process.env.AGENTOS_MOCK_URL ?? "http://localhost:4199";
    const d = await signUp("dave", "Dave Co");
    const e = await signUp("erin", "Erin Co");
    // No workspace key yet: the operator's platform key is used.
    expect((await e.user.call("/v1/x/providers/openrouter")).body).toMatchObject({ configured: true, scope: "platform", key_hint: null });

    expect((await d.user.call("/v1/x/providers/openrouter", { method: "PUT", json: { api_key: "not-a-real-key-123" } })).body.status).toBe("invalid");
    const daveKey = `sk-or-${TAG}-dave-0001`;
    const set = await d.user.call("/v1/x/providers/openrouter", { method: "PUT", json: { api_key: daveKey } });
    expect(set.body).toMatchObject({ configured: true, scope: "workspace", status: "valid", key_hint: `${daveKey.slice(0, 6)}…${daveKey.slice(-4)}` });
    expect(JSON.stringify(set.body)).not.toContain(daveKey);

    const runOnce = async (client: Anthropic) => {
      const env = await client.beta.environments.create({ name: "byok", config: { type: "cloud" } } as never);
      const agent = await client.beta.agents.create({ name: "byok", model: "mock/model" } as never);
      const s = await client.beta.sessions.create({ agent: agent.id, environment_id: env.id } as never);
      await client.beta.sessions.events.send(s.id, { events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }] } as never);
      for (let i = 0; i < 120; i++) {
        const evs: Array<{ type: string }> = [];
        for await (const ev of client.beta.sessions.events.list(s.id, { limit: 100 } as never)) evs.push(ev as never);
        if (evs.some((x) => x.type === "session.status_idle")) return evs;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("session did not go idle");
    };
    const before = (await fetch(`${mock}/_keys_seen`).then((r) => r.json())).length as number;
    await runOnce(await keyFor(d.user));
    await runOnce(await keyFor(e.user));
    const seen = (await fetch(`${mock}/_keys_seen`).then((r) => r.json())) as string[];
    const recent = seen.slice(before);
    expect(recent).toContain(daveKey);
    expect(recent).toContain("mock");

    // Removing the key falls back to the platform key.
    expect((await d.user.call("/v1/x/providers/openrouter", { method: "DELETE" })).body.scope).toBe("platform");
  });
});
