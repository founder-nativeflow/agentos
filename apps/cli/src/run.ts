/**
 * `agentos run`: start a session from the terminal and follow it live.
 *
 *   agentos run <agent id or name> "<message>" [--env <id>] [--budget 1.50] [--file ./data.csv]… [--yes] [--interactive]
 *
 * Talks to the same /v1 API as the SDKs. Auth: AGENTOS_API_KEY if set; otherwise,
 * on this machine, a short-lived admin session signed with the local config.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, signSession } from "../../api/src/lib/config.ts";

type Ev = { id: string; type: string; [k: string]: unknown };
type Json = Record<string, unknown>;

const BASE = (process.env.AGENTOS_URL ?? "http://localhost:4000").replace(/\/$/, "");
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

function authHeaders(): Record<string, string> {
  if (process.env.AGENTOS_API_KEY) return { "x-api-key": process.env.AGENTOS_API_KEY };
  const cfg = loadConfig();
  if (!cfg) throw new Error("No AGENTOS_API_KEY set and AgentOS isn't initialised here. Run `agentos init` or export AGENTOS_API_KEY.");
  return { cookie: `agentos_session=${signSession(cfg.admin.username, cfg.session_secret, 60 * 60 * 12)}` };
}

async function call<T = Json>(path: string, init: { method?: string; json?: unknown; body?: FormData } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method ?? (init.json !== undefined || init.body ? "POST" : "GET"),
      headers: { ...authHeaders(), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  } catch {
    throw new Error(`Can't reach the AgentOS API at ${BASE}. Is it running? (pnpm agentos dev)`);
  }
  const body = (await res.json().catch(() => null)) as Json | null;
  if (!res.ok) throw new Error((body?.error as { message?: string } | undefined)?.message ?? `${path} failed (${res.status})`);
  return body as T;
}

function multiFlag(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => a === `--${name}` && process.argv[i + 1] && out.push(process.argv[i + 1]!));
  return out;
}
const flag = (name: string) => multiFlag(name)[0];
const has = (name: string) => process.argv.includes(`--${name}`) || process.argv.includes(`-${name[0]}`);

/** Positional args, skipping flags and their values. */
function positionals(): string[] {
  const valued = new Set(["--env", "--budget", "--file", "--title"]);
  const out: string[] = [];
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if (valued.has(args[i]!)) i++;
    else if (!args[i]!.startsWith("-")) out.push(args[i]!);
  }
  return out;
}

const text = (e: Ev) => ((e.content as Array<{ text?: string }> | undefined) ?? []).map((b) => b.text ?? "").join("");
const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s);
const describeInput = (input: unknown) => {
  const i = (input ?? {}) as Json;
  return String(i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? JSON.stringify(i));
};

async function resolveAgent(ref: string): Promise<Json> {
  if (ref.startsWith("agent_")) return call(`/v1/agents/${ref}`);
  const list = await call<{ data: Json[] }>("/v1/agents?limit=100");
  const hits = list.data.filter((a) => String(a.name).toLowerCase() === ref.toLowerCase());
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new Error(`Several agents are named "${ref}"; pass the agent id instead.`);
  throw new Error(`No agent named "${ref}". Agents: ${list.data.map((a) => a.name).join(", ") || "none yet"}`);
}

async function resolveEnv(): Promise<string> {
  const explicit = flag("env");
  if (explicit) return explicit;
  const list = await call<{ data: Json[] }>("/v1/environments?limit=1");
  if (list.data[0]) return String(list.data[0].id);
  const env = await call<Json>("/v1/environments", { json: { name: "local", config: { type: "local", networking: { type: "unrestricted" } } } });
  console.log(c.dim(`Created environment "local" (${env.id}).`));
  return String(env.id);
}

async function upload(path: string): Promise<Json> {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(path)]), basename(path));
  return call("/v1/files", { body: form });
}

/** Reads the SSE stream and yields events (replaying from the start of the session). */
async function* stream(sessionId: string, signal: AbortSignal): AsyncGenerator<Ev> {
  const res = await fetch(`${BASE}/v1/sessions/${sessionId}/events/stream?after_seq=0`, { headers: authHeaders(), signal });
  if (!res.ok || !res.body) throw new Error(`Could not open the event stream (${res.status})`);
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) > -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      const type = block.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim();
      if (data && type !== "ping") yield JSON.parse(data) as Ev;
    }
  }
}

/**
 * Line prompter that also works with piped input: lines that arrive before a
 * question is asked are queued, and a closed stdin answers "" instead of throwing.
 */
function prompter() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines: string[] = [];
  const waiting: Array<(l: string) => void> = [];
  let closed = false;
  rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
  rl.on("close", () => {
    closed = true;
    while (waiting.length) waiting.shift()!("");
  });
  return {
    question(q: string): Promise<string> {
      process.stdout.write(q);
      if (lines.length) {
        const l = lines.shift()!;
        if (!process.stdin.isTTY) process.stdout.write(`${l}\n`);
        return Promise.resolve(l);
      }
      if (closed) {
        process.stdout.write("\n");
        return Promise.resolve("");
      }
      return new Promise((done) => waiting.push((l) => {
        if (!process.stdin.isTTY) process.stdout.write(`${l}\n`);
        done(l);
      }));
    },
    close: () => rl.close(),
  };
}

export async function runCommand(): Promise<void> {
  const [agentRef, ...words] = positionals();
  if (!agentRef) {
    console.log('Usage: agentos run <agent id or name> "<message>" [--env <id>] [--budget 1.50] [--file path]… [--yes] [--interactive]');
    process.exitCode = 1;
    return;
  }
  const rl = prompter();
  const autoYes = has("yes");
  const interactive = has("interactive");
  let message = words.join(" ").trim();
  if (!message) message = (await rl.question(c.bold("You: "))).trim();
  if (!message) throw new Error("Nothing to send.");

  const agent = await resolveAgent(agentRef);
  const environmentId = await resolveEnv();
  const resources = [];
  for (const path of multiFlag("file")) {
    const f = await upload(path);
    resources.push({ type: "file", file_id: f.id, mount_path: `/mnt/session/uploads/${f.filename}` });
    console.log(c.dim(`Uploaded ${path} → /mnt/session/uploads/${f.filename}`));
  }
  const budget = flag("budget");
  const session = await call<Json>("/v1/sessions", {
    json: {
      agent: agent.id,
      environment_id: environmentId,
      title: flag("title") ?? `CLI: ${message.slice(0, 60)}`,
      budget: budget ? { type: "limit", max_list_cost: { amount: String(Math.round(Number(budget) * 100)), currency: "USD" } } : undefined,
      resources: resources.length ? resources : undefined,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
    },
  });
  const sid = String(session.id);
  console.log(c.dim(`Session ${sid} · ${agent.name} · ${(agent.model as Json).id} · Console: http://localhost:5173/sessions/${sid}`));
  console.log(c.dim("Ctrl-C interrupts the agent.\n"));

  const send = (events: unknown[]) => call(`/v1/sessions/${sid}/events`, { json: { events } });
  const abort = new AbortController();
  let interrupting = false;
  process.on("SIGINT", () => {
    if (interrupting) process.exit(130);
    interrupting = true;
    console.log(c.yellow("\nInterrupting… (Ctrl-C again to quit)"));
    void send([{ type: "user.interrupt" }]).catch(() => process.exit(130));
  });

  const toolUses = new Map<string, Ev>();
  const threadNames = new Map<string, string>();
  // Sub-agent output is indented and labelled with the sub-agent's name.
  const who = (e: Ev) => (e.session_thread_id ? threadNames.get(String(e.session_thread_id)) ?? "Sub-agent" : null);
  const pad = (e: Ev) => (e.session_thread_id ? "    " : "");
  let exitCode = 0;
  try {
    for await (const e of stream(sid, abort.signal)) {
      switch (e.type) {
        case "agent.thinking":
          console.log(c.dim(`… ${clip(text(e) || String(e.thinking ?? ""), 300)}`));
          break;
        case "agent.message":
          console.log(`${pad(e)}${c.bold(c.cyan(`${who(e) ?? "Agent"}:`))} ${text(e)}`);
          break;
        case "session.thread_created":
          threadNames.set(String(e.session_thread_id), String(e.agent_name));
          break;
        case "agent.thread_message_sent":
          console.log(c.cyan(`↳ delegated to ${e.to_agent_name}: ${clip(text(e), 200)}`));
          break;
        case "agent.thread_message_received":
          console.log(c.cyan(`↩ ${e.from_agent_name} replied: ${clip(text(e), 200)}`));
          break;
        case "agent.tool_use":
        case "agent.custom_tool_use":
          toolUses.set(e.id, e);
          console.log(pad(e) + c.yellow(`→ ${who(e) ? `[${who(e)}] ` : ""}${e.name}: ${clip(describeInput(e.input), 200)}`) + (e.evaluated_permission === "ask" ? c.dim(" (needs approval)") : ""));
          break;
        case "agent.tool_result":
          console.log(pad(e) + c.dim(`  ${e.is_error ? c.red("✖") : "✓"} ${clip(text(e).trim().replace(/\n/g, "\n    "), 400)}`));
          break;
        case "session.error":
          console.log(c.red(`✖ ${(e.error as Json | undefined)?.message ?? "Error"}`));
          break;
        case "session.status_idle": {
          const stop = e.stop_reason as { type: string; event_ids?: string[] };
          if (stop.type === "requires_action") {
            const replies = [];
            for (const id of stop.event_ids ?? []) {
              const use = toolUses.get(id);
              if (use?.type === "agent.custom_tool_use") {
                console.log(c.red(`The agent called the custom tool "${use.name}", which needs your app to answer. Open the session in the Console or use the SDK.`));
                exitCode = 3;
                abort.abort();
                break;
              }
              const allow = autoYes || /^y(es)?$/i.test((await rl.question(c.bold(`Allow ${use?.name ?? "tool"}: ${describeInput(use?.input)}? [y/N] `))).trim());
              replies.push({ type: "user.tool_confirmation", tool_use_id: id, result: allow ? "allow" : "deny", ...(allow ? {} : { deny_message: "Denied from the CLI" }) });
            }
            if (replies.length) await send(replies);
          } else if (stop.type === "end_turn") {
            interrupting = false;
            const next = interactive ? (await rl.question(c.bold("\nYou (empty to quit): "))).trim() : "";
            if (next) await send([{ type: "user.message", content: [{ type: "text", text: next }] }]);
            else abort.abort();
          } else {
            console.log(stop.type === "budget_reached" ? c.yellow("Budget reached. Raise it in the Console to continue.") : c.red(`Stopped: ${stop.type}`));
            exitCode = stop.type === "budget_reached" ? 2 : 1;
            abort.abort();
          }
          break;
        }
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  } finally {
    rl.close();
  }
  const final = await call<Json>(`/v1/sessions/${sid}`);
  const usage = final.usage as Json;
  console.log(c.dim(`\n${c.green("●")} ${sid} · cost $${Number(usage.cost_usd).toFixed(4)} · ${usage.input_tokens}+${usage.cache_read_input_tokens} in / ${usage.output_tokens} out tokens`));
  process.exitCode = exitCode;
  process.exit(exitCode);
}
