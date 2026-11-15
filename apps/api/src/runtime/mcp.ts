import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { assertPublicUrl } from "../lib/net-guard.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Agent, McpServer, McpToolset } from "@agentos/types";
import type { ResolvedTool } from "./tools.js";

/**
 * MCP servers attached to an agent (`mcp_servers` + `mcp_toolset` tools).
 * As in CMA, the MCP client runs on the platform side, not in the sandbox, and
 * authenticates with a `static_bearer` credential from the session's vaults.
 */

/** Name the model sees for an MCP tool: mcp__<server>__<tool>, within OpenAI's 64-char limit. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export const normaliseUrl = (u: string) => u.replace(/\/+$/, "");

interface Connection {
  client: Client;
  url: string;
  tokenHash: string;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
}

/** Live MCP connections, per session and server. */
const pool = new Map<string, Map<string, Connection>>();

const hash = (s: string | null) => (s ? `${s.length}:${s.slice(-6)}` : "none");

async function connect(server: McpServer, token: string | null): Promise<Connection> {
  await assertPublicUrl(server.url);
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: "agentos", version: "0.1.0" });
  await client.connect(transport, { timeout: 15_000 });
  const tools: Connection["tools"] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
    for (const t of page.tools) tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> });
    cursor = page.nextCursor;
  } while (cursor);
  return { client, url: server.url, tokenHash: hash(token), tools };
}

export interface McpSetup {
  tools: ResolvedTool[];
  /** Servers that could not be reached, with the reason (reported as session.error). */
  failures: Array<{ server: string; message: string }>;
}

/**
 * Connects (or reuses connections) to the agent's MCP servers that have an
 * `mcp_toolset`, and returns their tools with permission policies applied.
 * MCP tools default to `always_ask`, as in CMA.
 */
export async function mcpTools(
  sessionId: string,
  agent: Agent,
  tokenFor: (url: string) => Promise<string | null>,
): Promise<McpSetup> {
  const toolsets = agent.tools.filter((t) => t.type === "mcp_toolset") as McpToolset[];
  const out: McpSetup = { tools: [], failures: [] };
  if (!toolsets.length) return out;
  const conns = pool.get(sessionId) ?? new Map<string, Connection>();
  pool.set(sessionId, conns);

  for (const ts of toolsets) {
    const server = agent.mcp_servers.find((s) => s.name === ts.mcp_server_name);
    if (!server) {
      out.failures.push({ server: ts.mcp_server_name, message: `No mcp_servers entry named ${ts.mcp_server_name}` });
      continue;
    }
    const token = await tokenFor(normaliseUrl(server.url));
    let conn = conns.get(server.name);
    if (conn && conn.tokenHash !== hash(token)) {
      await conn.client.close().catch(() => {});
      conn = undefined;
    }
    if (!conn) {
      try {
        conn = await connect(server, token);
        conns.set(server.name, conn);
      } catch (err) {
        const msg = (err as Error).message || String(err);
        const auth = /401|403|unauthori[sz]ed|forbidden/i.test(msg);
        out.failures.push({
          server: server.name,
          message: auth
            ? `MCP server ${server.name} rejected the credentials. Add a static_bearer credential for ${server.url} to a vault on this session.`
            : `Could not connect to MCP server ${server.name} (${server.url}): ${msg}`,
        });
        continue;
      }
    }
    const defaultEnabled = ts.default_config?.enabled ?? true;
    const defaultPolicy = ts.default_config?.permission_policy?.type ?? "always_ask";
    for (const t of conn.tools) {
      const cfg = ts.configs?.find((c) => c.name === t.name);
      if (!(cfg?.enabled ?? defaultEnabled)) continue;
      const name = mcpToolName(server.name, t.name);
      out.tools.push({
        kind: "mcp",
        name,
        mcp: { server: server.name, tool: t.name },
        def: {
          type: "function",
          function: {
            name,
            description: `[MCP: ${server.name}] ${t.description ?? t.name}`.slice(0, 1024),
            parameters: t.inputSchema ?? { type: "object", properties: {} },
          },
        },
        policy: cfg?.permission_policy?.type ?? defaultPolicy,
      });
    }
  }
  return out;
}

/** Calls an MCP tool on an already-connected server. */
export async function callMcpTool(
  sessionId: string,
  server: string,
  tool: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ text: string; isError: boolean }> {
  const conn = pool.get(sessionId)?.get(server);
  if (!conn) return { text: `MCP server ${server} is not connected`, isError: true };
  try {
    const res = await conn.client.callTool({ name: tool, arguments: input }, undefined, { signal, timeout: 120_000 });
    const parts = (res.content as Array<Record<string, unknown>> | undefined) ?? [];
    const text = parts
      .map((p) => {
        if (p.type === "text") return String(p.text);
        if (p.type === "resource") {
          const r = p.resource as { text?: string; uri?: string };
          return r.text ?? `[resource ${r.uri ?? ""}]`;
        }
        if (p.type === "resource_link") return `[resource ${String(p.uri ?? "")}]`;
        return `[${String(p.type)} content]`;
      })
      .join("\n");
    const structured = !text && res.structuredContent ? JSON.stringify(res.structuredContent) : "";
    return { text: text || structured || "(no output)", isError: Boolean(res.isError) };
  } catch (err) {
    // A broken connection is dropped so the next turn reconnects.
    pool.get(sessionId)?.delete(server);
    return { text: signal.aborted ? "Interrupted" : `MCP call failed: ${(err as Error).message}`, isError: true };
  }
}

export async function closeMcp(sessionId: string): Promise<void> {
  const conns = pool.get(sessionId);
  if (!conns) return;
  pool.delete(sessionId);
  await Promise.all([...conns.values()].map((c) => c.client.close().catch(() => {})));
}
