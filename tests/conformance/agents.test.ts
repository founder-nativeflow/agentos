import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

// Official Anthropic SDK pointed at AgentOS (CMA-compatible /v1).
const baseURL = process.env.AGENTOS_BASE_URL ?? "http://localhost:4000";
const client = new Anthropic({ baseURL, apiKey: process.env.AGENTOS_API_KEY ?? "missing" });

describe("Agents (CMA-compatible)", () => {
  it("creates, updates (new version), lists, archives an agent", async () => {
    const a = await client.beta.agents.create({ name: "conformance", model: "qwen/qwen3-coder", system: "Be brief." } as never);
    expect(a.id).toMatch(/^agent_01/);
    expect(a.version).toBe(1);
    const u = await client.beta.agents.update(a.id, { system: "Be very brief.", version: 1 } as never);
    expect(u.version).toBe(2);
    const got = await client.beta.agents.retrieve(a.id);
    expect(got.system).toBe("Be very brief.");
    const archived = await client.beta.agents.archive(a.id);
    expect(archived.archived_at).toBeTruthy();
  });

  it("returns CMA errors the SDK understands", async () => {
    await expect(client.beta.agents.retrieve("agent_01doesnotexist")).rejects.toBeInstanceOf(Anthropic.NotFoundError);
    const bad = new Anthropic({ baseURL, apiKey: "wrong" });
    await expect(bad.beta.agents.list()).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
  });
});

describe("Planned resources", () => {
  it("answer 404 not_found_error with a \"not implemented yet\" message (no SDK retries)", async () => {
    const err = await client.beta.memoryStores.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.NotFoundError);
    expect((err as Error).message).toContain("not implemented yet");
  });

  it("paginates agents with page / next_page", async () => {
    for (let i = 0; i < 3; i++) await client.beta.agents.create({ name: `p${i}`, model: "qwen/qwen3-coder" } as never);
    const first = await client.beta.agents.list({ limit: 2 } as never);
    expect(first.data.length).toBe(2);
    expect(first.hasNextPage()).toBe(true);
  });
});
