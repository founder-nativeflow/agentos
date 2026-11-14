// Spike probe: run one trueforge-core AgentThread against the mock model and print its events.
import winston from "winston";
import { z } from "zod/v4";
import { core } from "@truefoundry/trueforge-core";

core.configureOutboundUrlGuard({ enabled: true, allowedHosts: ["localhost"], blockedHosts: [] });
const logger = winston.createLogger({ level: "warn", transports: [new winston.transports.Console()] });
const tracing = {
  withInitSpan: <T>(op: () => Promise<T>) => op(),
  startRootSpan: () => ({ runInContext: <T>(op: () => T) => op(), startSubAgent() { return this; }, setOutput() {}, setMetrics() {}, setError() {}, setSuccess() {}, end() {} }),
  withLocalToolSpan: <T>(_i: unknown, op: (s: { setOutput(): void; setSandboxId(): void }) => Promise<T>) => op({ setOutput() {}, setSandboxId() {} }),
  withRemoteMcpToolSpan: <T>(_i: unknown, op: (s: { setOutput(): void; setNumberOfTools(): void }) => Promise<T>) => op({ setOutput() {}, setNumberOfTools() {} }),
};

class Tools {
  name = "agentos"; id = "agentos"; serverClass = "local" as const; preload = true; hasPreloadedTools = true; description = "AgentOS tools";
  async listTools() {
    return { result: { tools: [{ name: "bash", description: "Run bash", inputSchema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] }, preload: true }] }, wasInitialized: undefined };
  }
  async toolCallInfo(params: { name: string }) {
    return { type: "mcp" as const, mcp_server_id: "agentos", mcp_server_name: "agentos", original_tool_name: params.name, is_approval_required: process.env.ASK === "1" };
  }
  async callTool(params: { name: string; arguments?: Record<string, unknown> }, decision?: { status: string }) {
    if (process.env.ASK === "1" && !decision) return { approvalRequired: { tool_info: await this.toolCallInfo(params) } };
    return core.toolResultResponse({ text: `ran: ${String(params.arguments?.command)}` });
  }
  setApprovalPolicy() {}
  getApprovalPolicies() { return {}; }
}

const llm = new core.VercelAILLM({
  providerConfig: { provider: { type: "custom", name: "openrouter" }, model: { id: "mock/model", name: "mock/model" }, name: "openrouter", baseUrl: "http://localhost:4199", apiKey: "mock", headers: {} },
  logger,
});
const definition = { modelClient: llm, modelName: "mock/model", instruction: "Test agent.", toolSets: [new Tools() as never], iterationLimit: 10 };
const capabilities = process.env.COMPACT ? [core.contextCompaction({ definition: definition as never, compactionThresholdTokens: Number(process.env.COMPACT) })] : [];
const thread = new core.AgentThread({
  definition: definition as never, capabilities: capabilities as never,
  threadId: "main", title: "probe", tracing: tracing as never, logger,
});
const show = (e: Record<string, unknown>) => {
  const { type } = e;
  const brief = JSON.stringify(e, (k, v) => (k === "context" || k === "input_tokens_breakdown" ? undefined : v)).slice(0, 400);
  console.log(`[${String(type)}] ${brief}`);
};
for await (const e of thread.send([{ type: "user.message", content: "use bash" }] as never)) show(e as never);
for await (const e of thread.execute()) show(e as never);
if (process.env.COMPACT) {
  for (const msg of ["hello again", "and once more"]) {
    console.log(`--- user: ${msg}`);
    for await (const e of thread.send([{ type: "user.message", content: msg }] as never)) show(e as never);
    for await (const e of thread.execute()) show(e as never);
  }
  console.log("context messages now:", thread.toSnapshot().context.length);
}
if (process.env.ASK === "1") {
  const snap = thread.toSnapshot();
  const last = [...snap.context].reverse().find((m: any) => m.role === "assistant") as any;
  const id = last?.tool_calls?.[0]?.id;
  console.log("--- approving", id);
  for await (const e of thread.send([{ type: "user.tool_approval", thread_id: "main", tool_call_id: id, approval: { status: "allow" } }] as never)) show(e as never);
  for await (const e of thread.execute()) show(e as never);
}
void z;
