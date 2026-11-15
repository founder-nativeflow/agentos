# AgentOS

Managed agents you can run **on your own machine** or **in the cloud**, powered by **any OpenRouter model**, with an API that follows the **Anthropic Managed Agents API** standard, so the official Anthropic SDKs work against it.

> Status: **v1 feature-complete for self-hosting.** Agents, environments, sessions, sub-agents, deployments, files, vaults and MCP run locally (Docker sandboxes) or in cloud mode with Supabase Auth workspaces, per-workspace model keys, rate limits, backups and `push`/`pull` between installs. The hosted deployment (Railway + Supabase cloud + E2B) is scripted but not yet live.
>
> Docs: [PRD](docs/prd.md) · [Developer guide](docs/developer-guide.md) · [Operations and security](docs/operations.md) · [Cloud setup](docs/cloud-setup.md)

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
| Deployments (`/v1/deployments`, `/v1/deployment_runs`, CMA-compatible): a deployment pins an **agent version** with its environment, vaults, files, budget and task; triggers: run now, 5-field cron with time zone (exactly once per occurrence, safe with several API replicas), and a webhook with a secret token (AgentOS extension). Run history links each run to its session and cost; a broken reference (archived environment, missing vault…) pauses the deployment with the error. Console: Deployments page with schedule presets, version switcher, webhook setup and run history | ✅ |
| Sub-agents: CMA `multiagent_20261001` inline sub-agents run as session threads (`/v1/sessions/{id}/threads`, thread events, approvals inside sub-agents, per-thread usage); Console shows delegations, a Threads tab and each thread's transcript. Predefined agents, advisor and workflows: not yet (400) | ✅ |
| Agent loop features: OpenRouter model calls with fallbacks and an output cap (`model.max_tokens`, default 8192), built-in tools (bash, read, write, edit, glob, grep, web_fetch), custom tools, permission policies (allow / ask / deny), budgets (`budget_reached`), interrupts, crash recovery | ✅ |
| `/v1/files` (upload, list incl. `scope_id`/`ids`, metadata, download, delete); files attached to sessions via `resources`; session outputs listed as session-scoped files | ✅ CMA-compatible |
| `/v1/vaults` + credentials (`static_bearer` for MCP servers, `environment_variable`); secret values stored in Supabase Vault, never returned | ✅ CMA-compatible |
| MCP servers on agents (`mcp_servers` + `mcp_toolset`, Streamable HTTP): tools listed per session, bearer token from the session's vaults, `agent.mcp_tool_use` / `agent.mcp_tool_result` events, approvals (default `always_ask`) | ✅ |
| Egress proxy: `limited` environments reach only their `allowed_hosts` (+ package registries if allowed), via an internal Docker network whose only exit is the proxy; `environment_variable` credentials appear in the sandbox as placeholders and the proxy injects the real value (headers, optionally body) only for the credential's hosts, decrypting HTTPS with a per-install AgentOS CA | ✅ |
| Docker sandbox per session (no network unless the environment allows it; packages installed on start; outputs in `/mnt/session/outputs`) | ✅ |
| Local admin login (required) + API keys (create/revoke in Settings or the CLI) | ✅ local mode (config file) |
| Cloud sign-in (`AGENTOS_AUTH=supabase`): Supabase Auth accounts with self-serve sign-up, workspaces (`wrkspc_…`) with admin / developer / viewer roles, members, workspace-bound API keys in the database, `anthropic-workspace-id` header like CMA; every request runs on a workspace-scoped store | ✅ |
| Console: login, Overview, Agents, agent detail (with its sessions), Models, Environments, Sessions (attach files), live session view (transcript, approvals, composer, interrupt, budget, cost, events, tools, outputs), Files, Credential vaults, Settings (OpenRouter key, API keys); MCP servers in Create agent; vault picker in Create session | ✅ |
| Supabase schema (all resources, RLS) | ✅ applied to local Supabase |
| `web_search` tool | ⏳ Not available yet |
| Bring your own OpenRouter key per workspace (cloud mode; encrypted in Supabase Vault, admins only), with an optional platform key as fallback | ✅ |
| Rate limits and quotas: requests per minute per key, running sessions per workspace, webhook calls, sign-in and bad-key throttling (`429` + `retry-after`) | ✅ |
| Security defaults: allow-listed CORS, Secure/HttpOnly cookies, security headers, body-size limit, SSRF guard for `web_fetch` and MCP URLs | ✅ |
| `agentos backup` / `restore` (database, files, config; secrets only on request); `agentos push` / `pull` between installs with round-trip detection | ✅ |
| E2B cloud sandboxes, Railway deploy files, `agentos cloud init/check` | ✅ built; ⏳ not yet deployed (needs the hosting accounts) |
| Laptop workers, MCP OAuth credentials | ⏳ v1.x |
| `mcp_oauth` credentials, memory, skills | ⏳ Phase 3; unbuilt resources | ⏳ Answer `404 not_found_error` "not implemented yet (planned: Phase N)" |

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
| `pnpm agentos remote add <name> <url> --key-stdin` · `remote list` · `remote remove <name>` | Other AgentOS installs (e.g. AgentOS Cloud) you can push to; the key is checked before it's saved (0600 file) |
| `pnpm agentos push <agent> --to <remote> [--version N] [--env <name>] [--deployment <id>] [--activate] [--dry-run]` | Copy an agent version to the remote, with its environment and a deployment if asked. Updates only what changed (an unchanged agent makes no new version); secrets are never copied (vaults are matched by name, and a missing one stops the push before any write); new deployments arrive paused unless `--activate` |
| `pnpm agentos pull <agent> --from <remote> [same flags as push]` | The reverse of push: copy a remote agent version (and environment, deployment, files) here. Pulling back something you pushed updates the original instead of making a copy |
| `pnpm agentos backup [--include-secrets] [--out DIR]` · `pnpm agentos restore DIR --yes` | Back up / restore the database, stored files and local config (see [operations](docs/operations.md#backups)) |
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
bash tests/conformance/push-scenario.sh       # agentos push and pull between two AgentOS instances
bash tests/conformance/security-scenario.sh   # rate limits, quotas, SSRF guard, CORS, headers, body limit
bash tests/conformance/backup-scenario.sh     # backup / restore round trip (stop the API on :4000 first)
bash tests/conformance/runtime-scenarios.sh   # restart keeps context, budget resume, sub-agent approval across a restart, compaction
AGENTOS_RUNTIME=classic pnpm test:conformance # the same SDK suite on the original loop
AGENTOS_TEST_AUTH=supabase pnpm test:conformance  # the whole suite in Supabase Auth mode (users, workspaces, DB keys)
pnpm test:conformance    # throwaway API on :4100 + a scripted mock model on :4199; a test MCP server on :4198 and an HTTP/HTTPS echo server on :4197/:4196; runs the SDK tests (41)
```

## Configuration (runtime)
| Variable | Default | Meaning |
|---|---|---|
| `AGENTOS_RUNTIME` | `trueforge` | `classic` = AgentOS's original loop (fallback) |
| `AGENTOS_AUTH` | `local` | `supabase` = Supabase Auth users and workspaces (needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) |
| `AGENTOS_SIGNUP` | on | `off` disables self-serve sign-up in Supabase mode |
| `AGENTOS_SCHEDULER` | on | `off` stops this API process from firing cron deployments |
| `AGENTOS_SCHEDULER_INTERVAL_MS` | `15000` | How often the scheduler checks for due runs |
| `AGENTOS_COMPACTION` | on | `off` disables context compaction |
| `AGENTOS_COMPACTION_THRESHOLD_TOKENS` | from the model's context length | Compact when the context exceeds this |
| `AGENTOS_MAX_OUTPUT_TOKENS` | `8192` | Default output cap per model call |
| Limits and security | see [docs/operations.md](docs/operations.md) | `AGENTOS_RATE_LIMIT_RPM`, `AGENTOS_MAX_RUNNING_SESSIONS`, `AGENTOS_CORS_ORIGINS`, `AGENTOS_TRUST_PROXY`, `AGENTOS_ALLOW_PRIVATE_NETWORKS`, … |

## Contributing
Read the [developer guide](docs/developer-guide.md). Before a pull request: `pnpm typecheck` and `pnpm test:conformance` in both auth modes must pass; CI runs them on every push.

## Licence
MIT. The agent loop uses `@truefoundry/trueforge-core` (MIT, © TrueFoundry). AgentOS Cloud (the hosted, paid version) is built on this core.
