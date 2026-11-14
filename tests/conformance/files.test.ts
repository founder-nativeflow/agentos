import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

// Files API and session file resources, through the official Anthropic SDK.
const baseURL = process.env.AGENTOS_BASE_URL ?? "http://localhost:4000";
const client = new Anthropic({ baseURL, apiKey: process.env.AGENTOS_API_KEY ?? "missing", maxRetries: 0 });
type Ev = { id: string; type: string; [k: string]: unknown };

let envId = "";
beforeAll(async () => {
  const env = await client.beta.environments.create({ name: "files-env", config: { type: "cloud", networking: { type: "limited" } } } as never);
  envId = env.id;
});

async function idle(sessionId: string, timeoutMs = 60_000): Promise<Ev[]> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const out: Ev[] = [];
    for await (const e of client.beta.sessions.events.list(sessionId, { limit: 100 } as never)) out.push(e as unknown as Ev);
    if (out.some((e) => e.type === "session.status_idle")) return out;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`session ${sessionId} did not go idle`);
}

describe("Files (CMA-compatible)", () => {
  it("uploads, retrieves metadata, lists, downloads and deletes", async () => {
    const f = await client.beta.files.upload({ file: await toFile(Buffer.from("a,b\n1,2\n3,4\n"), "data.csv", { type: "text/csv" }) });
    expect(f.id).toMatch(/^file_01/);
    expect(f).toMatchObject({ type: "file", filename: "data.csv", mime_type: "text/csv", size_bytes: 12, downloadable: true });

    const meta = await client.beta.files.retrieveMetadata(f.id);
    expect(meta.filename).toBe("data.csv");

    const ids: string[] = [];
    for await (const item of client.beta.files.list({ limit: 2 })) ids.push(item.id);
    expect(ids).toContain(f.id);

    const byIds = await client.beta.files.list({ ids: [f.id, "file_01doesnotexist"] } as never);
    expect(byIds.data.map((x) => x.id)).toEqual([f.id]);

    const res = await client.beta.files.download(f.id);
    expect(await res.text()).toBe("a,b\n1,2\n3,4\n");

    const del = await client.beta.files.delete(f.id);
    expect(del).toEqual({ type: "file_deleted", id: f.id });
    await expect(client.beta.files.retrieveMetadata(f.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects bad expiry and missing files", async () => {
    await expect(
      client.beta.files.upload({ file: await toFile(Buffer.from("x"), "x.txt"), expires_in_seconds: 10 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(client.beta.files.download("file_01nope")).rejects.toMatchObject({ status: 404 });
  });

  it("mounts a file into the session sandbox and exposes outputs as session-scoped files", async () => {
    const f = await client.beta.files.upload({ file: await toFile(Buffer.from("a,b\n1,2\n3,4\n"), "data.csv") });
    const agent = await client.beta.agents.create({
      name: "files-agent", model: "mock/model",
      tools: [{ type: "agent_toolset_20260401", default_config: { permission_policy: { type: "always_allow" } } }],
    } as never);
    const s = await client.beta.sessions.create({
      agent: agent.id, environment_id: envId,
      resources: [{ type: "file", file_id: f.id, mount_path: "/mnt/session/uploads/data.csv" }],
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "read upload" }] }],
    } as never);
    expect(s.resources).toEqual([expect.objectContaining({ type: "file", file_id: f.id, mount_path: "/mnt/session/uploads/data.csv" })]);

    const evs = await idle(s.id);
    const result = evs.find((e) => e.type === "agent.tool_result")!;
    expect(JSON.stringify(result.content)).toContain("3,4");

    const scoped = await client.beta.files.list({ scope_id: s.id });
    const out = scoped.data.find((x) => x.filename === "count.txt")!;
    expect(out).toMatchObject({ scope: { type: "session", id: s.id }, mime_type: "text/plain" });
    expect((await (await client.beta.files.download(out.id)).text()).trim()).toBe("3");
  });

  it("refuses an unknown file or an unsafe mount path", async () => {
    const agent = await client.beta.agents.create({ name: "files-agent-2", model: "mock/model" } as never);
    await expect(client.beta.sessions.create({
      agent: agent.id, environment_id: envId, resources: [{ type: "file", file_id: "file_01missing" }],
    } as never)).rejects.toMatchObject({ status: 404 });
    const f = await client.beta.files.upload({ file: await toFile(Buffer.from("x"), "x.txt") });
    await expect(client.beta.sessions.create({
      agent: agent.id, environment_id: envId, resources: [{ type: "file", file_id: f.id, mount_path: "/mnt/../etc/passwd" }],
    } as never)).rejects.toMatchObject({ status: 400 });
  });
});
