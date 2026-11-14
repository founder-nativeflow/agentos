// Probe: orchestrator + dynamic sub-agents against the mock model; prints every event.
import winston from "winston";
import { core } from "@truefoundry/trueforge-core";

core.configureOutboundUrlGuard({ enabled: true, allowedHosts: ["localhost"], blockedHosts: [] });
const logger = winston.createLogger({ level: "warn", transports: [new winston.transports.Console()] });
const span: any = { runInContext: (op: any) => op(), startSubAgent: () => span, setOutput() {}, setMetrics() {}, setError() {}, setSuccess() {}, end() {} };
const tracing: any = {
  withInitSpan: (op: any) => op(), startRootSpan: () => span,
  withLocalToolSpan: (_i: any, op: any) => op({ setOutput() {}, setSandboxId() {} }),
  withRemoteMcpToolSpan: (_i: any, op: any) => op({ setOutput() {}, setNumberOfTools() {} }),
};
class Tools {
  name = "agentos"; id = "agentos"; serverClass = "local" as const; preload = true; hasPreloadedTools = true; description = "t";
  async listTools() { return { result: { tools: [{ name: "bash", description: "Run bash", inputSchema: { type: "object" as const, properties: { command: { type: "string" } } }, preload: true }] }, wasInitialized: undefined }; }
  async toolCallInfo(p: any) { return { type: "mcp" as const, mcp_server_id: "agentos", mcp_server_name: "agentos", original_tool_name: p.name, is_approval_required: process.env.ASK === "1" }; }
  async callTool(p: any, d?: any) { if (process.env.ASK === "1" && !d) return { approvalRequired: { tool_info: await this.toolCallInfo(p) } }; return core.toolResultResponse({ text: `ran ${p.arguments?.command}` }); }
  setApprovalPolicy() {} getApprovalPolicies() { return {}; }
}
const llm = new core.VercelAILLM({ providerConfig: { provider: { type: "custom", name: "m" }, model: { id: "mock/model", name: "mock/model" }, name: "m", baseUrl: "http://localhost:4199", apiKey: "x", headers: {} }, logger });
const definition: any = { modelClient: llm, modelName: "mock/model", instruction: "Main agent.", toolSets: [new Tools()], iterationLimit: 10 };
const main = new core.AgentThread({ definition, threadId: "main", title: "main", tracing, logger,
  capabilities: [core.dynamicSubAgents({ sandboxAvailable: true, tracing })] as any });
const threads = new Map<string, any>([["main", main]]);
const orch = new core.AgentThreadOrchestrator({
  agentThreads: threads, tracing, logger,
  createDynamicSubAgentThread: async ({ parentDefinition, request, threadId, parent }) => {
    console.log(`>>> factory: ${threadId} name=${request.name} parent=${JSON.stringify(parent)}`);
    return new core.AgentThread({ definition: { ...parentDefinition, instruction: core.SUB_AGENT_IDENTITY, messages: [{ role: "user", content: request.input }] }, threadId, title: request.name, parent, agentInfo: request, tracing, logger });
  },
});
const show = (e: any) => console.log(`[${e.type}] thread=${e.thread_id ?? "-"} ${JSON.stringify(e, (k, v) => (k === "context" || k === "input_tokens_breakdown" || k === "usage" ? undefined : v)).slice(0, 260)}`);
const ac = new AbortController();
for await (const e of orch.send([{ type: "user.message", content: process.env.MSG ?? "use subagent" }] as any)) show(e);
let res: any;
const it = orch.execute({ signal: ac.signal });
while (true) { const r = await it.next(); if (r.done) { res = r.value; break; } show(r.value); }
console.log("RESULT", JSON.stringify(res).slice(0, 400));
console.log("threads now:", [...threads.keys()]);
