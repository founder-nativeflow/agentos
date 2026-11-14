# AgentOS

Managed agents you can run **on your own machine** or **in the cloud**, powered by **any OpenRouter model**, with an API that follows the **Anthropic Managed Agents API** standard, so the official Anthropic SDKs work against it.

> Status: **Phase 2 in progress** (Phase 1, the local MVP, is complete). Agents, environments and sessions run locally: the agent loop calls your OpenRouter model, tools run in a Docker sandbox per session, and you can watch, approve and steer it live in the Console. Phase 1's exit test passes against a real OpenRouter model (`qwen/qwen3-coder`) through the official Anthropic SDK. See the PRD (`../managed-agents-prd.md`) for the full plan.

## What works today
| Area | Status |
|---|---|
| `/v1/agents` (create, list, get, update → new version, archive, versions) | ✅ CMA-compatible, tested with the official Anthropic SDK |
| CMA error envelope, request IDs, `page`/`next_page` pagination, `x-api-key` / `Authorization: Bearer` | ✅ |
| OpenRouter model catalog (`/v1/x/models`) and key settings (`/v1/x/providers/openrouter`) | ✅ |
| `/v1/environments` (create, list, get, update, archive, delete); local Docker hosting | ✅ |
| `/v1/sessions` (create with `initial_events`, list, get, update title/metadata/budget, archive, delete) | ✅ CMA-compatible |
| Session events: send (`user.message`, `user.tool_confirmation`, `user.custom_tool_result`, `user.interrupt`), list, SSE stream with replay | ✅ |
| Agent loop runs on [`@truefoundry/trueforge-core`](https://github.com/truefoundry/trueforge) (MIT, pinned) behind an adapter: state saved per session (survives restarts), context compaction (`agent.thread_context_compacted`), exact OpenRouter cost via a loopback proxy. `AGENTOS_RUNTIME=classic` selects the original loop | ✅ |
| Sub-agents: CMA `multiagent_20261001` inline sub-agents run as session threads (`/v1/sessions/{id}/threads`, thread events, approvals inside sub-agents, per-thread usage); Console shows delegations, a Threads tab and each thread's transcript. Predefined agents, advisor and workflows: not yet (400) | ✅ |
| Agent loop features: OpenRouter model calls with fallbacks and an output cap (`model.max_tokens`, default 8192), built-in tools (bash, read, write, edit, glob, grep, web_fetch), custom tools, permission policies (allow / ask / deny), budgets (`budget_reached`), interrupts, crash recovery | ✅ |
| `/v1/files` (upload, list incl. `scope_id`/`ids`, metadata, download, delete); files attached to sessions via `resources`; session outputs listed as session-scoped files | ✅ CMA-compatible |
| `/v1/vaults` + credentials (`static_bearer` for MCP servers, `environment_variable`); secret values stored in Supabase Vault, never returned | ✅ CMA-compatible |
| MCP servers on agents (`mcp_servers` + `mcp_toolset`, Streamable HTTP): tools listed per session, bearer token from the session's vaults, `agent.mcp_tool_use` / `agent.mcp_tool_result` events, approvals (default `always_ask`) | ✅ |
| Egress proxy: `limited` environments reach only their `allowed_hosts` (+ package registries if allowed), via an internal Docker network whose only exit is the proxy; `environment_variable` credentials appear in the sandbox as placeholders and the proxy injects the real value (headers, optionally body) only for the credential's hosts, decrypting HTTPS with a per-install AgentOS CA | ✅ |
| Docker sandbox per session (no network unless the environment allows it; packages installed on start; outputs in `/mnt/session/outputs`) | ✅ |
| Local admin login (required) + API keys (create/revoke in Settings or the CLI) | ✅ (config file; moves to Supabase Auth with Phase 2) |
| Console: login, Overview, Agents, agent detail (with its sessions), Models, Environments, Sessions (attach files), live session view (transcript, approvals, composer, interrupt, budget, cost, events, tools, outputs), Files, Credential vaults, Settings (OpenRouter key, API keys); MCP servers in Create agent; vault picker in Create session | ✅ |
| Supabase schema (all resources, RLS) | ✅ applied to local Supabase |
| `web_search` tool | ⏳ Not available yet |
| Cloud deploy (Railway, Supabase cloud), cloud sandboxes (E2B), Supabase Auth + workspaces, laptop workers, local/cloud switch (`push`/`pull`) | ⏳ Phase 2 (needs cloud accounts) |
| `mcp_oauth` credentials, memory, deployments, skills | ⏳ Phase 3; unbuilt resources | ⏳ Answer `404 not_found_error` "not implemented yet (planned: Phase N)" |

## Requirements
Node 20+, pnpm 9 (`corepack prepare pnpm@9.15.4 --activate`), Docker (for local Supabase and session sandboxes), the Supabase CLI.

## Quick start
```bash
pnpm install
pnpm agentos init        # creates the admin login and your first API key (shown once)
pnpm agentos dev         # local Supabase + API on :4000 + Console on :5173
```
Open http://localhost:5173 and sign in. In **Settings**, add your OpenRouter API key.

Use the official SDK against AgentOS:
```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "http://localhost:4000", apiKey: process.env.AGENTOS_API_KEY });
const agent = await client.beta.agents.create({ name: "Researcher", model: "qwen/qwen3-coder", system: "Be concise." });
const env = await client.beta.environments.create({ name: "local", config: { type: "local" } });
const session = await client.beta.sessions.create({ agent: agent.id, environment_id: env.id });
await client.beta.sessions.events.send(session.id, {
  events: [{ type: "user.message", content: [{ type: "text", text: "List the files in /mnt/session" }] }],
});
for await (const event of await client.beta.sessions.events.stream(session.id)) {
  console.log(event.type);
  if (event.type === "session.status_idle") break;
}
```

## CLI
| Command | What it does |
|---|---|
| `pnpm agentos init [--username U --password-stdin] [--force]` | Create the local admin and first API key |
| `pnpm agentos dev [--no-db]` | Start Supabase (unless `--no-db`), the API and the Console |
| `pnpm agentos status` | Show admin, API keys (hints only) and OpenRouter status |
| `pnpm agentos run <agent> "<message>" [--env ID] [--budget 1.50] [--file PATH]… [--yes] [--interactive]` | Start a session and follow it live in the terminal; asks before tools that need approval (`--yes` allows them), Ctrl-C interrupts |
| `pnpm agentos keys create <name>` | Create another API key |
| `pnpm agentos admin reset-password` | Reset the admin password (signs everyone out) |

## Repository layout
```
apps/api            Hono API: CMA-compatible /v1 + AgentOS extensions under /v1/x
apps/console        React + TypeScript (Vite), shadcn/ui, Radix, Tailwind, Lucide, Recharts, React Router
apps/cli            `agentos` CLI
packages/types      Shared CMA-compatible types (used by API and Console)
supabase/           Supabase config + migrations
tests/conformance   Official Anthropic SDK run against AgentOS
```

## Tests
```bash
pnpm typecheck
bash tests/conformance/runtime-scenarios.sh   # restart keeps context, budget resume, sub-agent approval across a restart, compaction
AGENTOS_RUNTIME=classic pnpm test:conformance # the same SDK suite on the original loop
pnpm test:conformance    # throwaway API on :4100 + a scripted mock model on :4199; a test MCP server on :4198 and an HTTP/HTTPS echo server on :4197/:4196; runs the SDK tests (31)
```

## Configuration (runtime)
| Variable | Default | Meaning |
|---|---|---|
| `AGENTOS_RUNTIME` | `trueforge` | `classic` = AgentOS's original loop (fallback) |
| `AGENTOS_COMPACTION` | on | `off` disables context compaction |
| `AGENTOS_COMPACTION_THRESHOLD_TOKENS` | from the model's context length | Compact when the context exceeds this |
| `AGENTOS_MAX_OUTPUT_TOKENS` | `8192` | Default output cap per model call |

## Licence
MIT. The agent loop uses `@truefoundry/trueforge-core` (MIT, © TrueFoundry). AgentOS Cloud (the hosted, paid version) is built on this core.
