import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

// Egress proxy: host allow-lists and secret injection, end to end through the
// sandbox. The upstream is a local echo server (tests/conformance/echo-server.mjs)
// reached at host.docker.internal, so no internet access is needed.
const baseURL = process.env.AGENTOS_BASE_URL ?? "http://localhost:4000";
const client = new Anthropic({ baseURL, apiKey: process.env.AGENTOS_API_KEY ?? "missing", maxRetries: 0 });
type Ev = { id: string; type: string; [k: string]: unknown };
const SECRET = "real-secret-123";
const OTHER = "other-secret-456";

async function idle(sessionId: string, timeoutMs = 120_000): Promise<Ev[]> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const out: Ev[] = [];
    for await (const e of client.beta.sessions.events.list(sessionId, { limit: 100 } as never)) out.push(e as unknown as Ev);
    if (out.some((e) => e.type === "session.status_idle")) return out;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`session ${sessionId} did not go idle`);
}
const textOf = (e: Ev) => ((e.content as Array<{ text: string }>) ?? []).map((b) => b.text).join("");

async function run(networking: Record<string, unknown>, vaultIds: string[] = []) {
  const env = await client.beta.environments.create({ name: `egress-${Date.now()}`, config: { type: "cloud", networking } } as never);
  const agent = await client.beta.agents.create({
    name: "egress-agent", model: "mock/model",
    tools: [{ type: "agent_toolset_20260401", default_config: { permission_policy: { type: "always_allow" } } }],
  } as never);
  const s = await client.beta.sessions.create({
    agent: agent.id, environment_id: env.id, vault_ids: vaultIds,
    initial_events: [{ type: "user.message", content: [{ type: "text", text: "egress test" }] }],
  } as never);
  const evs = await idle(s.id);
  const errors = evs.filter((e) => e.type === "session.error");
  expect(errors, JSON.stringify(errors)).toEqual([]);
  const result = evs.find((e) => e.type === "agent.tool_result");
  expect(result, "bash ran").toBeTruthy();
  const out = textOf(result!);
  const lines = out.split("\n");
  const json = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { method: string; headers: Record<string, string>; body: string });
  const line = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length);
  return { out, json, line, evs };
}

describe("Egress proxy", () => {
  it("injects vault secrets on the way out (HTTP + HTTPS), only for allowed hosts, and blocks everything else", async () => {
    const vault = await client.beta.vaults.create({ display_name: "egress" });
    await client.beta.vaults.credentials.create(vault.id, {
      auth: {
        type: "environment_variable", secret_name: "ECHO_TOKEN", secret_value: SECRET,
        networking: { type: "limited", allowed_hosts: ["host.docker.internal"] }, injection_location: { header: true, body: true },
      },
    } as never);
    // Allowed by the environment but not by this credential: must stay a placeholder.
    await client.beta.vaults.credentials.create(vault.id, {
      auth: { type: "environment_variable", secret_name: "OTHER_TOKEN", secret_value: OTHER, networking: { type: "limited", allowed_hosts: ["api.example.com"] } },
    } as never);

    const { out, json, line, evs } = await run({ type: "limited", allowed_hosts: ["host.docker.internal"] }, [vault.id]);

    // The sandbox only ever sees a placeholder.
    expect(line("env:")).toMatch(/^aos_ph_[0-9a-f]{32}$/);
    // (The echo server repeats what it received, so the tool output itself may show the
    // injected value; what matters is that nothing the sandbox or model sent contains it.)
    const sent = evs.filter((e) => e.type !== "agent.tool_result" && e.type !== "agent.message");
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(JSON.stringify(evs)).not.toContain(OTHER);

    // HTTP: header injected; the other credential's placeholder is left alone.
    expect(json[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(json[0]!.headers["x-other"]).toMatch(/^aos_ph_/);
    expect(json[0]!.headers["proxy-authorization"]).toBeUndefined();
    expect(json[0]!.headers["content-length"]).toBeUndefined();

    // HTTPS (intercepted with the AgentOS CA the sandbox trusts): body injected.
    expect(json[1]!.method).toBe("POST");
    expect(json[1]!.body).toBe(`token=${SECRET}`);

    // Not allowed: blocked by the proxy, and there is no way around it.
    expect(line("blocked:")).toBe("403");
    expect(line("tlsblocked:")).not.toBe("0");
    expect(line("direct:")).not.toBe("0");
    expect(out).toBeTruthy();
  });

  it("limited networking with nothing allowed blocks all traffic", async () => {
    const { line } = await run({ type: "limited" });
    expect(line("env:")).toBe("");
    expect(line("http:")).toBe("403");
    expect(line("blocked:")).toBe("403");
    expect(line("tlsblocked:")).not.toBe("0");
    expect(line("direct:")).not.toBe("0");
  });
});
