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

function script(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
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

createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url?.endsWith("/chat/completions") && req.method === "POST") {
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
