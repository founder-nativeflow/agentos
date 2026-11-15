// A scripted stand-in for OpenRouter's /chat/completions, so session tests run
// without network access or model cost. The reply depends on the last user
// message and on whether a tool result has already come back.
import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT ?? 4199);

// Used by egress.test.ts: what the sandbox sees, what leaves it, what is blocked.
const EGRESS_CMD = "python3 - <<'PY'\nimport os, urllib.request, urllib.error\nt = os.environ.get(\"ECHO_TOKEN\", \"\"); o = os.environ.get(\"OTHER_TOKEN\", \"\")\nprint(\"env:\" + t)\ndef get(url, data=None, headers={}, opener=None):\n    try:\n        req = urllib.request.Request(url, data=data, headers=headers)\n        r = (opener.open if opener else urllib.request.urlopen)(req, timeout=10)\n        return r.status, r.read().decode()\n    except urllib.error.HTTPError as e:\n        return e.code, e.read().decode()\n    except Exception as e:\n        return \"ERR\", type(e).__name__\ns, b = get(\"http://host.docker.internal:4197/h\", headers={\"Authorization\": \"Bearer \" + t, \"X-Other\": o}); print(b if s == 200 else \"http:%s\" % s)\ns, b = get(\"https://host.docker.internal:4196/b\", data=(\"token=\" + t).encode()); print(b if s == 200 else \"https:%s %s\" % (s, b))\ns, b = get(\"http://example.org/\"); print(\"blocked:%s\" % s)\ns, b = get(\"https://example.org/\"); print(\"tlsblocked:%s\" % (\"0\" if s == 200 else s))\ns, b = get(\"http://host.docker.internal:4197/\", opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))); print(\"direct:%s\" % (\"0\" if s == 200 else s))\nPY";

function reply({ content = null, toolCalls = [], cost = 0.001 }) {
  return {
    id: "gen-mock",
    model: "mock/model",
    choices: [{
      index: 0,
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
      message: { role: "assistant", content, tool_calls: toolCalls.length ? toolCalls : undefined },
    }],
    usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 80 }, cost },
  };
}

const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

/* ---- builder (AgentOS builder system prompt) and workflow router */

function builderPlan(request, current) {
  const workflow = /triage|workflow/i.test(request) || current?.kind === "workflow";
  const addSummary = /add a summary step/i.test(request) || current?.workflow?.nodes?.some((n) => n.id === "summary");
  const agent = (key, name, system) => ({ key, name, description: name, model: "mock/model", system, toolset: false, subagents: false, mcp_servers: [] });
  if (!workflow) {
    return {
      kind: "agent", title: "Research assistant", summary: "One agent that researches a topic and writes a brief.",
      steps: [{ title: "Goal", detail: "A short, sourced brief." }, { title: "Shape", detail: "One agent is enough." }],
      assumptions: ["English output"], open_questions: [], agents: [agent("researcher", "Researcher", "You research topics and write briefs.")],
      environment: { name: "Research", networking: "unrestricted", allowed_hosts: [], pip: [], npm: [] }, workflow: null, test_input: "Summarise the history of the bicycle",
    };
  }
  const nodes = [
    { type: "start", id: "start", label: "Start", input_description: "A support ticket" },
    { type: "agent", id: "classify", label: "Classify ticket", agent_key: "classifier", prompt: "Classify this ticket. End with a line SEVERITY: P1|P2|P3.\n\n{{input}}" },
    { type: "condition", id: "is_p1", label: "Is it P1?", source: "{{nodes.classify.output}}", operator: "contains", value: "SEVERITY: P1" },
    { type: "agent", id: "page", label: "Page on-call", agent_key: "pager", prompt: "Write the on-call page for: {{input}}" },
    { type: "agent", id: "draft", label: "Draft reply", agent_key: "writer", prompt: "Draft a reply to: {{input}}" },
    { type: "output", id: "result", label: "Result", template: "Page: {{nodes.page.output}}\nReply: {{nodes.draft.output}}" },
  ];
  const edges = [
    { id: "e1", source: "start", target: "classify" },
    { id: "e2", source: "classify", target: "is_p1" },
    { id: "e3", source: "is_p1", target: "page", branch: "true" },
    { id: "e4", source: "is_p1", target: "draft", branch: "false" },
    { id: "e5", source: "page", target: "result" },
    { id: "e6", source: "draft", target: "result" },
  ];
  if (addSummary) {
    nodes.push({ type: "agent", id: "summary", label: "Summarise", agent_key: "writer", prompt: "Summarise: {{nodes.classify.output}}" });
    edges.push({ id: "e7", source: "classify", target: "summary" });
  }
  return {
    kind: "workflow", title: "Ticket triage", summary: "Classify tickets, page on-call for P1s, draft replies for the rest.",
    steps: [{ title: "Goal", detail: "Fast triage." }, { title: "Shape", detail: "Classifier, then a P1 branch." }],
    assumptions: ["Tickets arrive as plain text"], open_questions: ["Which on-call tool do you use?"],
    agents: [agent("classifier", "Classifier", "You classify tickets."), agent("pager", "Pager", "You write pages."), agent("writer", "Writer", "You draft replies.")],
    environment: { name: "Triage", networking: "unrestricted", allowed_hosts: [], pip: [], npm: [] },
    workflow: { name: "Ticket triage", description: "Triage tickets", nodes, edges }, test_input: "Our checkout is down for all users (outage)",
  };
}

function builderReply(messages) {
  const users = messages.filter((m) => m.role === "user");
  const last = users[users.length - 1].content;
  const request = last.split("Request: ").pop();
  const currentMatch = last.match(/^Current plan \(revise it; return the whole plan\):\n(.*)\n\nRequest:/s);
  const current = currentMatch ? JSON.parse(currentMatch[1]) : null;
  // "broken plan": first answer refers to an unknown agent; the repair turn fixes it.
  if (/broken plan/i.test(request) && !last.startsWith("That plan can't be used yet")) {
    const plan = builderPlan("triage", null);
    plan.workflow.nodes[1].agent_key = "nobody";
    return reply({ content: JSON.stringify({ reply: "Here's a plan.", changes: [], plan }) });
  }
  const original = users.map((u) => u.content).reverse().find((c) => c.includes("Request: ")) ?? last;
  const asked = original.split("Request: ").pop();
  const plan = builderPlan(/broken plan/i.test(asked) ? "triage" : asked, current);
  const changes = /add a summary step/i.test(request) ? ["Added a Summarise step after Classify"] : [];
  return reply({ content: "```json\n" + JSON.stringify({ reply: current ? "Updated the plan." : `I drafted ${plan.title}.`, changes, plan }) + "\n```" });
}

function script(messages) {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  if (system.startsWith("You are the AgentOS builder")) return builderReply(messages);
  if (system.startsWith("AgentOS workflow router")) {
    const input = messages[messages.length - 1].content.toLowerCase();
    const keys = [...system.matchAll(/^- ([a-z0-9_]+):/gm)].map((m) => m[1]);
    return reply({ content: keys.find((k) => input.includes(k)) ?? keys[0] });
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  // Workflow agent steps that must end with a severity marker.
  if (/SEVERITY: P1\|P2\|P3/.test(lastUser)) {
    return reply({ content: `Looks like ${/outage|down/i.test(lastUser) ? "an outage" : "a question"}.\nSEVERITY: ${/outage|down/i.test(lastUser) ? "P1" : "P3"}` });
  }
  if (/^Write the on-call page for:/.test(lastUser)) return reply({ content: "PAGE: checkout outage" });
  if (/^Draft a reply to:/.test(lastUser)) return reply({ content: "Thanks for writing in." });
  if (/^Summarise:/.test(lastUser)) return reply({ content: "Summary ready." });
  if (/^Step marker /.test(lastUser)) return reply({ content: `Done: ${lastUser.slice(12, 80)}` });
  const lastIsTool = messages[messages.length - 1]?.role === "tool";
  const toolText = lastIsTool ? messages[messages.length - 1].content : "";

  // Sub-agent threads: the parent delegates "subtask: …" via create_sub_agent.
  if (lastUser.startsWith("subtask:")) {
    if (lastUser.includes("use bash") && !lastIsTool) {
      return reply({ toolCalls: [call("s1", "bash", { command: "echo from-subagent" })] });
    }
    return reply({ content: `Subagent result: ${lastIsTool ? toolText.trim() : lastUser.slice(8).trim()} (done)` });
  }
  if (lastUser.includes("budget loop")) {
    return reply({ toolCalls: [call("c1", "bash", { command: "echo tick" })], cost: 0.02 });
  }
  if (lastIsTool) return reply({ content: `Done. Tool said: ${toolText.slice(0, 200)}` });
  if (lastUser.includes("count messages")) {
    // Reveals how much conversation history the client sent (restart / compaction tests).
    const users = messages.filter((m) => m.role === "user").length;
    return reply({ content: `I see ${users} user messages.` });
  }
  const fetchUrl = lastUser.match(/^fetch url (\S+)/);
  if (fetchUrl) return reply({ toolCalls: [call("c1", "web_fetch", { url: fetchUrl[1] })] });
  if (lastUser.includes("egress test")) {
    return reply({ toolCalls: [call("c1", "bash", { command: EGRESS_CMD })] });
  }
  if (lastUser.includes("use mcp")) {
    return reply({ toolCalls: [call("c1", lastUser.includes("fail") ? "mcp__calc__fail" : "mcp__calc__add", lastUser.includes("fail") ? {} : { a: 2, b: 3 })] });
  }
  if (lastUser.includes("read upload")) {
    // Uses the mount path the runtime lists in the system prompt.
    const path = (messages[0]?.content ?? "").match(/Files provided for this session:\n- (\S+)/)?.[1] ?? "/missing";
    return reply({ toolCalls: [call("c1", "bash", { command: `cat ${path} && wc -l < ${path} > /mnt/session/outputs/count.txt` })] });
  }
  if (lastUser.includes("use subagent")) {
    const task = lastUser.includes("with bash") ? "subtask: use bash please" : "subtask: count to three";
    return reply({ content: "Delegating to a helper.", toolCalls: [call("c1", "create_sub_agent", { name: "Helper", input: task })] });
  }
  if (lastUser.includes("use bash")) {
    return reply({ content: "Running a command.", toolCalls: [call("c1", "bash", { command: "echo hello > /mnt/session/outputs/hello.txt && cat /mnt/session/outputs/hello.txt" })] });
  }
  if (lastUser.includes("write and read")) {
    return reply({ toolCalls: [
      call("c1", "write", { file_path: "/workspace/notes.txt", content: "line one\nline two\n" }),
    ] });
  }
  if (lastUser.includes("slow")) return reply({ toolCalls: [call("c1", "bash", { command: "sleep 30" })] });
  if (lastUser.includes("custom")) return reply({ toolCalls: [call("c1", "lookup_order", { order_id: "42" })] });
  if (lastUser.includes("bad json")) {
    return reply({ toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{not json" } }] });
  }
  return reply({ content: "Hello from the mock model." });
}

// The key on each model call, so tests can check which key a workspace used (BYOK).
const keysSeen = [];

createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url === "/_keys_seen") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(keysSeen));
      return;
    }
    if (req.url?.endsWith("/key") && req.method === "GET") {
      // Key check: keys that start with sk-or- are "valid".
      const ok = /^Bearer sk-or-/.test(req.headers.authorization ?? "");
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { data: { label: "mock" } } : { error: { message: "invalid key" } }));
      return;
    }
    if (req.url?.endsWith("/chat/completions") && req.method === "POST") {
      keysSeen.push(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
      const { messages, stream } = JSON.parse(body);
      const out = script(messages);
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      // Streaming (SSE) form of the same reply, for clients that always stream.
      const msg = out.choices[0].message;
      const chunk = (delta, extra = {}) =>
        `data: ${JSON.stringify({ id: out.id, object: "chat.completion.chunk", model: out.model, choices: [{ index: 0, delta, finish_reason: null, ...extra }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant", ...(msg.content ? { content: msg.content } : {}) }));
      (msg.tool_calls ?? []).forEach((tc, index) => res.write(chunk({ tool_calls: [{ index, ...tc }] })));
      res.write(`data: ${JSON.stringify({ id: out.id, object: "chat.completion.chunk", model: out.model,
        choices: [{ index: 0, delta: {}, finish_reason: out.choices[0].finish_reason }], usage: out.usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(404).end();
    }
  });
}).listen(port, () => console.log(`mock openrouter on :${port}`));
