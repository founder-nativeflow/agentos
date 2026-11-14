// A tiny MCP server (Streamable HTTP, stateless) for the conformance tests.
// It requires `Authorization: Bearer test-mcp-token`, so tests can prove that
// AgentOS sends the vault credential and never leaks it to the model.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const port = Number(process.env.MCP_PORT ?? 4198);
const TOKEN = "test-mcp-token";

function build() {
  const server = new McpServer({ name: "calc", version: "1.0.0" });
  server.registerTool("add", { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
  server.registerTool("fail", { description: "Always fails", inputSchema: {} },
    async () => ({ isError: true, content: [{ type: "text", text: "calc is broken" }] }));
  return server;
}

createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = build();
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
}).listen(port, () => console.log(`mock mcp on :${port}`));
