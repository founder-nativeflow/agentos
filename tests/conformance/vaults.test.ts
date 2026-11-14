import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

// Credential vaults and MCP servers, through the official Anthropic SDK.
const baseURL = process.env.AGENTOS_BASE_URL ?? "http://localhost:4000";
const client = new Anthropic({ baseURL, apiKey: process.env.AGENTOS_API_KEY ?? "missing", maxRetries: 0 });
const MCP_URL = process.env.AGENTOS_MCP_URL ?? "http://localhost:4198/mcp";
const TOKEN = "test-mcp-token";
type Ev = { id: string; type: string; [k: string]: unknown };

let envId = "";
beforeAll(async () => {
  const env = await client.beta.environments.create({ name: "vault-env", config: { type: "cloud", networking: { type: "limited" } } } as never);
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

async function mcpAgent(policy?: "always_allow" | "always_ask") {
  return client.beta.agents.create({
    name: "mcp-agent", model: "mock/model",
    mcp_servers: [{ type: "url", name: "calc", url: MCP_URL }],
    tools: [{ type: "mcp_toolset", mcp_server_name: "calc", ...(policy ? { default_config: { permission_policy: { type: policy } } } : {}) }],
  } as never);
}

async function vaultWithToken(token = TOKEN) {
  const v = await client.beta.vaults.create({ display_name: "mcp-vault" });
  await client.beta.vaults.credentials.create(v.id, { auth: { type: "static_bearer", token, mcp_server_url: MCP_URL } } as never);
  return v;
}

describe("Vaults (CMA-compatible)", () => {
  it("creates, updates, lists, archives and deletes vaults", async () => {
    const v = await client.beta.vaults.create({ display_name: "Team secrets", metadata: { team: "data", tmp: "x" } });
    expect(v.id).toMatch(/^vlt_01/);
    expect(v).toMatchObject({ type: "vault", display_name: "Team secrets", archived_at: null });

    const up = await client.beta.vaults.update(v.id, { display_name: "Data team", metadata: { tmp: null, env: "prod" } });
    expect(up.metadata).toEqual({ team: "data", env: "prod" });
    expect((await client.beta.vaults.retrieve(v.id)).display_name).toBe("Data team");

    const ids: string[] = [];
    for await (const x of client.beta.vaults.list()) ids.push(x.id);
    expect(ids).toContain(v.id);

    const archived = await client.beta.vaults.archive(v.id);
    expect(archived.archived_at).not.toBeNull();
    const visible: string[] = [];
    for await (const x of client.beta.vaults.list()) visible.push(x.id);
    expect(visible).not.toContain(v.id);

    expect(await client.beta.vaults.delete(v.id)).toEqual({ type: "vault_deleted", id: v.id });
    await expect(client.beta.vaults.retrieve(v.id)).rejects.toMatchObject({ status: 404 });
  });

  it("stores credentials without ever returning the secret", async () => {
    const v = await client.beta.vaults.create({ display_name: "creds" });
    const bearer = await client.beta.vaults.credentials.create(v.id, {
      display_name: "Linear", auth: { type: "static_bearer", token: "super-secret-1", mcp_server_url: "https://mcp.example.com/sse/" },
    } as never);
    expect(bearer.id).toMatch(/^vcrd_01/);
    expect(bearer.auth).toEqual({ type: "static_bearer", mcp_server_url: "https://mcp.example.com/sse" });
    expect(JSON.stringify(bearer)).not.toContain("super-secret");

    const envCred = await client.beta.vaults.credentials.create(v.id, {
      auth: { type: "environment_variable", secret_name: "GITHUB_TOKEN", secret_value: "ghp_secret", networking: { type: "limited", allowed_hosts: ["api.github.com"] } },
    } as never);
    expect(envCred.auth).toEqual({
      type: "environment_variable", secret_name: "GITHUB_TOKEN",
      networking: { type: "limited", allowed_hosts: ["api.github.com"] }, injection_location: { header: true, body: false },
    });

    const listed = [];
    for await (const c of client.beta.vaults.credentials.list(v.id)) listed.push(c);
    expect(listed.map((c) => c.id).sort()).toEqual([bearer.id, envCred.id].sort());
    expect(JSON.stringify(listed)).not.toMatch(/super-secret|ghp_secret/);

    const got = await client.beta.vaults.credentials.retrieve(bearer.id, { vault_id: v.id });
    expect(got.display_name).toBe("Linear");

    const rotated = await client.beta.vaults.credentials.update(bearer.id, { vault_id: v.id, auth: { type: "static_bearer", token: "super-secret-2" } } as never);
    expect(rotated.auth).toEqual(bearer.auth);

    await expect(client.beta.vaults.credentials.create(v.id, {
      auth: { type: "static_bearer", token: "x", mcp_server_url: "https://mcp.example.com/sse" },
    } as never)).rejects.toMatchObject({ status: 409 });
    await expect(client.beta.vaults.credentials.create(v.id, {
      auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.example.com", access_token: "x" },
    } as never)).rejects.toMatchObject({ status: 400 });

    const arch = await client.beta.vaults.credentials.archive(envCred.id, { vault_id: v.id });
    expect(arch.archived_at).not.toBeNull();
    expect(await client.beta.vaults.credentials.delete(bearer.id, { vault_id: v.id })).toEqual({ type: "vault_credential_deleted", id: bearer.id });
    await client.beta.vaults.delete(v.id);
  });

  it("rejects sessions that reference unknown or archived vaults", async () => {
    const a = await client.beta.agents.create({ name: "plain", model: "mock/model" } as never);
    await expect(client.beta.sessions.create({ agent: a.id, environment_id: envId, vault_ids: ["vlt_01missing"] } as never))
      .rejects.toMatchObject({ status: 404 });
    const v = await client.beta.vaults.create({ display_name: "old" });
    await client.beta.vaults.archive(v.id);
    await expect(client.beta.sessions.create({ agent: a.id, environment_id: envId, vault_ids: [v.id] } as never))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe("MCP servers", () => {
  it("calls an MCP tool with the vault's bearer token (always_allow)", async () => {
    const a = await mcpAgent("always_allow");
    const v = await vaultWithToken();
    const s = await client.beta.sessions.create({
      agent: a.id, environment_id: envId, vault_ids: [v.id],
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "use mcp" }] }],
    } as never);
    expect(s.vault_ids).toEqual([v.id]);
    const evs = await idle(s.id);
    const use = evs.find((e) => e.type === "agent.mcp_tool_use")!;
    expect(use).toMatchObject({ name: "add", mcp_server_name: "calc", input: { a: 2, b: 3 }, evaluated_permission: "allow" });
    const result = evs.find((e) => e.type === "agent.mcp_tool_result")!;
    expect(result.mcp_tool_use_id).toBe(use.id);
    expect(result.is_error).toBe(false);
    expect(textOf(result)).toBe("5");
    expect(textOf(evs.filter((e) => e.type === "agent.message").at(-1)!)).toContain("5");
    expect(JSON.stringify(evs)).not.toContain(TOKEN);
  });

  it("asks before MCP tools by default, then runs after approval", async () => {
    const a = await mcpAgent();
    const v = await vaultWithToken();
    const s = await client.beta.sessions.create({
      agent: a.id, environment_id: envId, vault_ids: [v.id],
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "use mcp" }] }],
    } as never);
    let evs = await idle(s.id);
    const use = evs.find((e) => e.type === "agent.mcp_tool_use")!;
    expect(use.evaluated_permission).toBe("ask");
    expect(evs.filter((e) => e.type === "session.status_idle").at(-1)!.stop_reason).toEqual({ type: "requires_action", event_ids: [use.id] });
    await client.beta.sessions.events.send(s.id, { events: [{ type: "user.tool_confirmation", tool_use_id: use.id, result: "allow" }] } as never);
    evs = await idle(s.id, 2);
    expect(textOf(evs.find((e) => e.type === "agent.mcp_tool_result")!)).toBe("5");
  });

  it("returns MCP tool errors to the model", async () => {
    const a = await mcpAgent("always_allow");
    const v = await vaultWithToken();
    const s = await client.beta.sessions.create({
      agent: a.id, environment_id: envId, vault_ids: [v.id],
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "use mcp fail" }] }],
    } as never);
    const evs = await idle(s.id);
    const result = evs.find((e) => e.type === "agent.mcp_tool_result")!;
    expect(result.is_error).toBe(true);
    expect(textOf(result)).toContain("calc is broken");
  });

  it("reports a clear error when the MCP server rejects the credentials", async () => {
    const a = await mcpAgent("always_allow");
    const s = await client.beta.sessions.create({
      agent: a.id, environment_id: envId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }],
    } as never);
    const evs = await idle(s.id);
    const err = evs.find((e) => e.type === "session.error")!;
    expect(err.error).toMatchObject({ type: "mcp_connection_failed_error" });
    expect(JSON.stringify(err.error)).toContain("static_bearer");
    expect(evs.filter((e) => e.type === "session.status_idle").at(-1)!.stop_reason).toEqual({ type: "end_turn" });
  });
});
