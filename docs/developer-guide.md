# Developer guide

How AgentOS is put together, how to run it, and how to change it safely. For product intent read
[`prd.md`](prd.md). For running it for other people read [`operations.md`](operations.md) and
[`cloud-setup.md`](cloud-setup.md).

## 1. Set up

Requirements: Node 20+, pnpm 9 (`corepack prepare pnpm@9.15.4 --activate`), Docker Desktop (or
another Docker engine), and the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
pnpm install
pnpm db:start                 # local Supabase in Docker (Postgres on :54322, Auth on :54321)
pnpm agentos init             # admin login + first API key (shown once)
pnpm agentos dev --no-db      # API on :4000, Console on :5173
```

Open http://localhost:5173, sign in, and add an OpenRouter key in **Settings → Model provider**.
Without a real key you can still run everything against the scripted mock model the tests use:

```bash
MOCK_PORT=4199 node tests/conformance/mock-openrouter.mjs &
OPENROUTER_BASE_URL=http://localhost:4199 OPENROUTER_API_KEY=mock pnpm dev:api
# then use the model id "mock/model"
```

Many test scripts read `.agentos/dev-credentials` (git-ignored) with three lines:
`AGENTOS_ADMIN_USERNAME=…`, `AGENTOS_ADMIN_PASSWORD=…`, `AGENTOS_API_KEY=…`. Make it from your own
`agentos init` output. Never commit it.

## 2. Repository map

```
apps/api/src
  index.ts                 Hono app: middleware (request id, CORS, security headers, body limit), routes, startup
  routes/                  one file per CMA resource (agents, environments, sessions, files, vaults, deployments)
    x.ts                   AgentOS extensions under /v1/x: auth, workspaces, members, providers, models, API keys
    planned.ts             CMA resources not built yet → 404 "not implemented yet (planned: Phase N)"
  lib/
    store.ts               all SQL (postgres.js); Store.scoped(workspace) shares one pool
    scope.ts               AsyncLocalStorage: the current request's workspace-scoped store
    auth.ts                requireAuth / requireAdmin; local mode vs Supabase Auth mode; cookies
    supabase-auth.ts       GoTrue REST client (sign in, sign up, refresh, users)
    limits.ts              rate limits and quotas (in memory, per process)
    net-guard.ts           SSRF guard for web_fetch and MCP URLs
    provider-keys.ts       which OpenRouter key a session uses (workspace BYOK / platform / local)
    errors.ts              CMA error envelope
  runtime/
    runner.ts              SessionRuntime: one loop per session, events in/out, recovery after restart
    trueforge/engine.ts    adapter onto @truefoundry/trueforge-core (threads, sub-agents, compaction, cost)
    trueforge/openrouter-proxy.ts  loopback proxy: exact OpenRouter cost, fallbacks, provider routing
    model.ts               the classic loop's OpenRouter client (AGENTOS_RUNTIME=classic)
    tools.ts               built-in tools (bash, read, write, edit, glob, grep, web_fetch)
    sandbox.ts / e2b.ts    sandboxes: Docker per session locally, E2B in the cloud
    mcp.ts                 MCP client (Streamable HTTP), bearer tokens from vaults
    deployments.ts         cron scheduler and deployment runs
    session-service.ts     session creation shared by the API and deployments
  egress/                  egress proxy (allowed hosts, secret injection) and its container manager
apps/console/src           React + Vite Console (pages/, components/, lib/api.ts)
apps/cli/src               `agentos` CLI: init, dev, run, cloud, remote, push, pull, backup, restore
packages/types             CMA-compatible TypeScript types shared by API and Console
supabase/migrations        the only way the schema changes (see §5)
tests/conformance          the official Anthropic SDK against AgentOS, plus scenario scripts
deploy/                    Dockerfiles, Railway config, Caddyfile for the hosted version
```

## 3. The two rules that matter most

1. **The `/v1` surface follows Anthropic Managed Agents (CMA).** If the official Anthropic SDK can
   call it, its shape must match CMA: field names, defaults, error envelope, pagination. Anything
   AgentOS-only goes under `/v1/x/…` or is prefixed `x_` on an object. The conformance suite runs
   the real SDK (`@anthropic-ai/sdk` 1.3.0) to keep us honest.
2. **Every query is workspace-scoped.** Routes get the store with `c.get("store")` (already scoped
   by `requireAuth`); background work uses `storeScope`. Never query `agentos.*` tables without a
   `workspace_id` condition unless the code is explicitly cross-workspace (scheduler, recovery).

## 4. How a session turn runs

1. `POST /v1/sessions/{id}/events` stores the events and wakes `SessionRuntime` (`runner.ts`).
   A `user.message` first passes the running-sessions quota (`limits.ts`).
2. The runner resolves the agent version, environment, sandbox, vault credentials and MCP tools,
   then hands the turn to the TrueForge engine (`trueforge/engine.ts`).
3. The engine restores the session's thread state from `sessions.runtime_state`, sends new events
   to the orchestrator and maps every TrueForge event to CMA events (`agent.message`,
   `agent.tool_use`, `span.model_request_*`, `session.usage`, thread events for sub-agents).
4. Model calls go through the loopback OpenRouter proxy with the workspace's key, which records the
   exact cost OpenRouter reports. Budgets stop the turn with `budget_reached`.
5. State is saved after every step, so an API restart resumes where it left off.

`user.interrupt` aborts the turn's `AbortController`; tools must honour the signal (including an
already-aborted one, see `run()` in `sandbox.ts`).

## 5. Changing the database

- Add a new file `supabase/migrations/<timestamp>_<name>.sql`. Never edit a migration that's been
  committed. Use `if not exists` where you can.
- Apply locally with `supabase migration up --local`; `pnpm db:reset` rebuilds from scratch.
- Secrets go in Supabase Vault (`vault.create_secret`), never in a plain column. If you add a
  column that holds a `vault.secrets` id, add it to `SECRET_REFS` in `apps/cli/src/backup.ts`.

## 6. Tests

| Command | What it covers | Time |
|---|---|---|
| `pnpm typecheck` | API, Console, CLI, types | ~20 s |
| `pnpm test:conformance` | the SDK suite (41 tests) in local mode: throwaway API, mock model, mock MCP server, echo servers | ~2 min |
| `AGENTOS_TEST_AUTH=supabase pnpm test:conformance` | the same suite in Supabase Auth mode, plus users, workspaces, roles, BYOK | ~2 min |
| `AGENTOS_RUNTIME=classic pnpm test:conformance` | the suite on the original loop | ~2 min |
| `bash tests/conformance/runtime-scenarios.sh` | restart keeps context, budget resume, approvals across restarts, compaction | ~1 min |
| `bash tests/conformance/push-scenario.sh` | `agentos push` and `pull` between two instances | ~1 min |
| `bash tests/conformance/security-scenario.sh` | rate limits, quotas, sign-in throttling, SSRF guard, CORS, headers, body limit | ~1 min |
| `bash tests/conformance/backup-scenario.sh` | `agentos backup` / `restore` round trip (stop the API on :4000 first) | ~30 s |

All of them use throwaway workspaces and clean up after themselves. They need local Supabase and
Docker running. `tests/conformance/mock-openrouter.mjs` is the scripted model: a message containing
a trigger phrase ("use bash", "slow", "use subagent", "fetch url …") produces the matching tool call.
Add a trigger there when a new test needs new model behaviour.

Before you open a pull request: `pnpm typecheck` and both conformance modes must pass, plus the
scenario script for the area you touched. CI (`.github/workflows/ci.yml`) runs the same commands.

## 7. Conventions

- TypeScript strict; ES modules; `zod` validates every request body.
- Errors: throw `ApiError` / `badRequest` / `notFound` / `conflict`; never return raw 500s on
  purpose. User-facing messages say what happened and what to do next.
- IDs: `newId("agent")` → `agent_01…` (CMA-style prefixes).
- Console: shadcn/ui components, TanStack Query for data, no new UI libraries without a reason.
- Commit messages: imperative summary line, then what changed and why.

## 8. Upgrading TrueForge

`@truefoundry/trueforge-core` is pinned to an exact version and only used through
`runtime/trueforge/engine.ts`. To upgrade: bump the version, run all suites above (the runtime
scenarios exercise persistence, which is the most fragile part), and read
[`spike-trueforge-core.md`](spike-trueforge-core.md) for what the adapter relies on.
`AGENTOS_RUNTIME=classic` is the fallback if an upgrade misbehaves in production.
