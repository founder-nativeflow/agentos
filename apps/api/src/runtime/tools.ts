import type { Agent, AgentToolset, BuiltinToolName, CustomTool, PermissionPolicy } from "@agentos/types";
import type { Sandbox } from "./sandbox.js";

/** OpenAI-style function definition (what OpenRouter expects). */
export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const BUILTIN: Record<BuiltinToolName, ToolDef["function"]> = {
  bash: {
    name: "bash",
    description: "Run a bash command in the sandbox (working directory /workspace). Write deliverables to /mnt/session/outputs.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        timeout_ms: { type: "number", description: "Optional timeout, default 120000" },
      },
      required: ["command"],
    },
  },
  read: {
    name: "read",
    description: "Read a text file. Returns numbered lines.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "number", description: "First line (1-based)" },
        limit: { type: "number", description: "Number of lines" },
      },
      required: ["file_path"],
    },
  },
  write: {
    name: "write",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      type: "object",
      properties: { file_path: { type: "string" }, content: { type: "string" } },
      required: ["file_path", "content"],
    },
  },
  edit: {
    name: "edit",
    description: "Replace an exact string in a file. old_string must appear exactly once unless replace_all is true.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  glob: {
    name: "glob",
    description: "Find files by glob pattern, e.g. **/*.py.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string", description: "Directory, default /workspace" } },
      required: ["pattern"],
    },
  },
  grep: {
    name: "grep",
    description: "Search file contents with a regular expression. Returns matching lines with file and line number.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "File or directory, default /workspace" },
        glob: { type: "string", description: "Only files matching this glob" },
      },
      required: ["pattern"],
    },
  },
  web_fetch: {
    name: "web_fetch",
    description: "Fetch a URL and return its text content.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  web_search: {
    name: "web_search",
    description: "Search the web.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
};

/** web_search needs a search provider; it is offered from Phase 3. */
const UNAVAILABLE: BuiltinToolName[] = ["web_search"];

export interface ResolvedTool {
  kind: "builtin" | "custom" | "mcp";
  name: string;
  /** For MCP tools: the server and the tool's own name. */
  mcp?: { server: string; tool: string };
  def: ToolDef;
  policy: PermissionPolicy["type"];
}

/** Turns an agent's `tools` config into the tool list sent to the model. */
export function resolveTools(agent: Agent): ResolvedTool[] {
  const out: ResolvedTool[] = [];
  for (const t of agent.tools) {
    if (t.type === "agent_toolset_20260401") {
      const ts = t as AgentToolset;
      const defaultEnabled = ts.default_config?.enabled ?? true;
      const defaultPolicy = ts.default_config?.permission_policy?.type ?? "always_allow";
      for (const name of Object.keys(BUILTIN) as BuiltinToolName[]) {
        const cfg = ts.configs?.find((c) => c.name === name);
        const enabled = cfg?.enabled ?? defaultEnabled;
        if (!enabled || UNAVAILABLE.includes(name)) continue;
        out.push({ kind: "builtin", name, def: { type: "function", function: BUILTIN[name] }, policy: cfg?.permission_policy?.type ?? defaultPolicy });
      }
    } else if (t.type === "custom") {
      const ct = t as CustomTool;
      out.push({
        kind: "custom",
        name: ct.name,
        def: { type: "function", function: { name: ct.name, description: ct.description ?? "", parameters: ct.input_schema } },
        policy: "always_allow",
      });
    }
    // mcp_toolset tools are added per session by runtime/mcp.ts (they need a live connection).
  }
  return out;
}

/**
 * Permission decision. `auto` will use a risk classifier model (Phase 3);
 * until then it allows read-only tools and asks for anything that can change state.
 */
export function evaluate(tool: ResolvedTool): "allow" | "ask" {
  if (tool.policy === "always_ask") return "ask";
  if (tool.policy === "always_allow") return "allow";
  const readOnly = ["read", "glob", "grep", "web_fetch"].includes(tool.name);
  return readOnly ? "allow" : "ask";
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface ToolOutput {
  text: string;
  isError: boolean;
}

/** Executes a built-in tool inside the session sandbox. */
export async function runBuiltin(
  name: string,
  input: Record<string, unknown>,
  sandbox: Sandbox,
  opts: { signal?: AbortSignal; allowedHosts?: string[] | null },
): Promise<ToolOutput> {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const signal = opts.signal;
  switch (name) {
    case "bash": {
      const r = await sandbox.exec(str("command"), { timeoutMs: Number(input.timeout_ms) || 120_000, signal });
      const body = [r.stdout, r.stderr && `[stderr]\n${r.stderr}`].filter(Boolean).join("\n").trim();
      if (r.timedOut) return { text: `${body}\n[timed out]`, isError: true };
      return { text: body || `(exit code ${r.exitCode}, no output)`, isError: r.exitCode !== 0 };
    }
    case "read": {
      const start = Math.max(Number(input.offset) || 1, 1);
      const count = Math.min(Number(input.limit) || 2000, 5000);
      const r = await sandbox.exec(
        `test -f ${q(str("file_path"))} && awk -v s=${start} -v n=${count} 'NR>=s && NR<s+n {printf "%d\\t%s\\n", NR, $0}' ${q(str("file_path"))}`,
        { signal },
      );
      if (r.exitCode !== 0) return { text: `File not found: ${str("file_path")}`, isError: true };
      return { text: r.stdout || "(empty file)", isError: false };
    }
    case "write": {
      const p = str("file_path");
      const r = await sandbox.exec(`mkdir -p "$(dirname ${q(p)})" && cat > ${q(p)}`, { stdin: str("content"), signal });
      return r.exitCode === 0 ? { text: `Wrote ${str("content").length} characters to ${p}`, isError: false } : { text: r.stderr, isError: true };
    }
    case "edit": {
      const p = str("file_path");
      const read = await sandbox.exec(`cat ${q(p)}`, { signal });
      if (read.exitCode !== 0) return { text: `File not found: ${p}`, isError: true };
      const oldS = str("old_string");
      const count = oldS ? read.stdout.split(oldS).length - 1 : 0;
      if (count === 0) return { text: "old_string was not found in the file", isError: true };
      if (count > 1 && !input.replace_all) return { text: `old_string appears ${count} times; make it unique or set replace_all`, isError: true };
      const updated = input.replace_all ? read.stdout.split(oldS).join(str("new_string")) : read.stdout.replace(oldS, str("new_string"));
      const w = await sandbox.exec(`cat > ${q(p)}`, { stdin: updated, signal });
      return w.exitCode === 0 ? { text: `Replaced ${input.replace_all ? count : 1} occurrence(s) in ${p}`, isError: false } : { text: w.stderr, isError: true };
    }
    case "glob": {
      const dir = str("path") || "/workspace";
      const r = await sandbox.exec(`cd ${q(dir)} 2>/dev/null && shopt -s globstar nullglob dotglob && for f in ${str("pattern").replace(/[^\w*?./\-[\]{},]/g, "")}; do echo "$PWD/$f"; done | head -500`, { signal });
      return { text: r.stdout.trim() || "No files matched", isError: false };
    }
    case "grep": {
      const target = str("path") || "/workspace";
      const include = str("glob") ? `--include=${q(str("glob"))}` : "";
      const r = await sandbox.exec(`grep -rnE ${include} -- ${q(str("pattern"))} ${q(target)} 2>/dev/null | head -300`, { signal });
      return { text: r.stdout.trim() || "No matches", isError: false };
    }
    case "web_fetch": {
      const url = str("url");
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return { text: "Invalid URL", isError: true };
      }
      const allowed = opts.allowedHosts;
      if (allowed && !allowed.some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h))) {
        return { text: `Blocked by environment networking: ${host} is not in allowed hosts`, isError: true };
      }
      const res = await fetch(url, { signal, headers: { "User-Agent": "AgentOS web_fetch" } }).catch((e: Error) => e);
      if (res instanceof Error) return { text: `Fetch failed: ${res.message}`, isError: true };
      const raw = await res.text();
      const text = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return { text: `HTTP ${res.status}\n${text.slice(0, 50_000)}`, isError: !res.ok };
    }
    default:
      return { text: `Tool ${name} is not available`, isError: true };
  }
}
