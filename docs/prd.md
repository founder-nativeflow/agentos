# PRD: AgentOS (managed agents · OpenRouter models · local ↔ cloud)

**Status:** Draft v0.5 · **Date:** 2026-11-11 · **Owner:** TBD
**Screenshots:** the 34 reference screenshots of the Anthropic Console aren't in this repository (they show a private account); ask the product owner for them.

---

## 0. Decisions in this version

| Topic | Decision |
|---|---|
| Name | **AgentOS** |
| API standard | **Follow the Anthropic Managed Agents API.** Same `/v1` resources, request and response shapes, event types, ID prefixes, errors and pagination, so the official Anthropic SDKs work against AgentOS by changing the base URL. AgentOS-only features live under `/v1/x/…` (§6A). |
| Frontend stack | React + TypeScript · shadcn/ui · Radix UI · Tailwind CSS · Lucide React · Recharts · React Router (single-page app built with Vite) |
| What we build | A managed agent platform with Anthropic Managed Agents (CMA) parity: agents, environments, sessions, tools, MCP, skills, multi-agent, memory, outcomes, deployments, vaults, observability |
| Where agents run | **Local and Cloud, same product.** Every session and deployment has a **Runs on: Local / Cloud** switch. A local agent can be **pushed to the cloud** in one step. |
| Models | **OpenRouter is the model provider.** One **OpenRouter API key** setting unlocks every OpenRouter model in the model picker. |
| Backend | **Supabase**: Postgres, Auth, Storage, Realtime, Vault, Queues, Cron. Locally the **Supabase CLI runs the same stack in Docker**. |
| Cloud compute | **Railway** for the always-on services (Console, runtime, workers). **Per-session sandboxes go through a provider interface**: E2B recommended, Railway Sandboxes evaluated in Phase 0, Docker locally. **Blacksmith isn't suitable today** (see §7). |
| Differentiators | Any model, real local mode, pipelines, governance (agent RBAC, scoped credentials, immutable audit), live observability |
| Licence & business model | **MIT** open-source core (local AgentOS: Console, API, runtime, CLI). Revenue from **AgentOS Cloud**, the paid hosted version |
| Build approach | **From scratch** (SandBase/OpenMA used only as references) |
| Local login | **Required.** Admin username and password created on first run |
| API tracking | Start on the current CMA beta (`managed-agents-2026-04-01`); re-check the API periodically and update the conformance suite |

---

## 1. Summary

Build a platform where anyone can define an agent once (model, instructions, tools, MCP servers, skills, sub-agents), run it **on their own machine**, and, when ready, **push it to the cloud** to run on schedules, webhooks or API calls. The same YAML definition, Console UI and API work in both places.

It matches CMA's capabilities, observed hands-on in §2 with screenshots, and fixes its gaps:
- Anthropic-only models
- Cloud-only orchestration
- Workspace-wide credentials
- No agent RBAC
- No pipelines
- Observability that refreshes only every ~3 h

### 1.1 Licence and monetisation
- **MIT licence** for everything needed to run AgentOS yourself: Console, API, runtime, CLI, local sandboxes, Supabase migrations.
- **AgentOS Cloud (paid, hosted)** is the business. What customers pay for is what's hard to run themselves:
  - managed sandboxes (microVMs) and autoscaling;
  - always-on deployments and schedules;
  - multi-tenant orgs and teams;
  - backups, uptime and support;
  - usage billing;
  - push-to-cloud from local;
  - laptop/VPC workers connected to a managed control plane.
- **What stays private (not in the MIT repo):**
  - billing and metering;
  - cloud provisioning and infrastructure code;
  - abuse protection;
  - the hosted multi-tenant admin.

  Optionally, enterprise governance (SSO, advanced audit export) can also stay cloud-only. Keeping these in a **separate private repo** means the MIT repo stays fully useful locally without giving away the hosted business.
- **Risk to know:** MIT allows anyone, including a cloud provider, to host AgentOS commercially. Mitigations:
  - register the **AgentOS trademark**, so forks can't use the name;
  - make the hosted experience clearly better;
  - ship fast.

### 1.2 Local login
- On first run, `agentos init` asks for an **admin username and password**. It creates the admin in the local Supabase Auth (password hashed) and a default workspace.
- The Console needs that login.
- SDK and API access uses **API keys** created by the admin in Settings → API keys (`x-api-key`, as in CMA).
- `agentos admin reset-password` from the machine itself recovers a lost password.
- The admin can add more local users later (Phase 2+).

---

## 2. Reference: what Anthropic Managed Agents does (observed 2026-11-11)

Observed in two workspaces, including hands-on test runs (about $0.60 in total). (Screenshots are referenced by file name; they're kept outside the repository.)

### 2.1 Overview, Create and templates
*[Screenshot: Overview (01-overview.jpg)]*
*Overview: sessions (30 days), error rate, active agents, sessions per day by agent, median active time per agent, agent table.*

*[Screenshot: Create (02-create-templates.jpg)]*
*Create: "describe your agent" box plus 12 templates tagged Outcome-optimizing, Recurring, Dynamic workflow, or by connectors used.*

*[Screenshot: Template (03-template-incident-commander.jpg)]*
*A template is a full agent YAML (plus an optional outcome rubric) with its MCP servers listed.*

**Guided builder flow** (hands-on): describe the agent → the AI writes YAML in a side panel → **Create agent / Keep refining** → choose or create an environment → vault step (skipped when no MCP) → test session (default $5 budget, suggested first message) → **Integrate** (generated cURL/SDK code with real IDs, or schedule) → **Export as code** (files for `ant apply`) / **Copy Anthropic Code prompt**. Each API call is shown in the chat.

### 2.2 Agents
*[Screenshot: Agents list (04-agents-list.jpg)]*
*[Screenshot: Agent config (05-agent-config-general.jpg)]*
*Agent detail: tabs Configuration · Sessions · Deployments · Observability; version picker; Rendered/Raw; Start session.*

*[Screenshot: Tool permissions (06-agent-tools-permissions.jpg)]*
*Built-in toolset (bash, read, write, edit, glob, grep, web_fetch, web_search). Each tool: Auto / Always allow / Always ask / Off.*

*[Screenshot: MCP picker (07-mcp-connector-picker.jpg)]*
*MCP connector catalog (Google Drive, Gmail, Notion, Slack, Linear…) or any URL. Each server lists its tools with per-tool permissions and a Connect (OAuth) step.*

*[Screenshot: Model picker (08-model-picker.jpg)]*
*Model picker: Anthropic models only, with Effort and Fast-speed options. **Our version lists every OpenRouter model instead.***

*[Screenshot: Multiagent (09-agent-multiagent.jpg)]*
*Multiagent: Workflows / Subagents (ad-hoc "define its own agents" + saved agents) / Advisor (stronger model).*

*[Screenshot: Raw YAML (10-agent-raw-yaml.jpg)]*
*The whole agent is one YAML document. Multi-agent schema: `workflows|subagents: {inline_agents, predefined_agents[]}`, `advisor: {model}`.*

*[Screenshot: Observability (11-agent-observability.jpg)]*
*[Screenshot: Observability tools (12-agent-observability-tools.jpg)]*
*Per-agent observability (refreshed ~every 3 h): sessions, error rate, tokens, activity by version, p50/p90/p95 turns / active time / tokens, tool usage, stop reasons.*

Custom tools are a name, a description and a JSON input schema; the client executes them and returns the result (the session pauses with `requires_action` until it does).

### 2.3 Environments
*[Screenshot: Environment create (13-environment-create.jpg)]*
*[Screenshot: Environment networking (14-environment-networking-packages.jpg)]*
*Hosting Cloud / Self-hosted (fixed at creation). Networking Unrestricted / Limited (package managers, MCP servers, up to 16 allowed hosts). Packages: pip, npm, apt, cargo, gem, go. Sandbox kernel suggests Firecracker microVMs.*

### 2.4 Sessions (the most important screens)
*[Screenshot: Sessions list (15-sessions-list.jpg)]*
*List: status, agent, **cost / budget**, tokens in/out (hover: cache read / cache write / uncached / output), created by (user or **Deployment**). ~97% of input tokens are cache reads, so caching drives cost.*

*[Screenshot: Create session (16-create-session-dialog.jpg)]*
*Create session: agent, environment, vaults, budget, resources (memory store with access mode + instructions, files, GitHub repos). Note: the memory store was **pre-filled from a previous form**, a carry-over bug to avoid.*

*[Screenshot: Transcript (17-session-transcript.jpg)]*
*Transcript with search and a timeline minimap; tool calls with durations; "Thought for 1.7s"; message box for live sessions.*

*[Screenshot: Inspector: Session (18-session-inspector-session.jpg)]*
*Session tab: IDs, agent, environment, vaults, deployment, **cost-over-time chart vs budget**, usage (input, output, cache read, cache write, active time), **metadata** (e.g. `run_id`).*

*[Screenshot: Inspector: Events (19-session-inspector-events.jpg)]*
*Events tab: raw stream, filter by type, Copy / Download. Types: `session.status_*`, `session.thread_status_*`, `session.usage`, `user.message`, `user.custom_tool_result`, `span.model_request_start|end`, `agent.thinking`, `agent.message`, `agent.tool_use|tool_result`, `agent.mcp_tool_use|result`, `agent.custom_tool_use`.*

*[Screenshot: Inspector: Tools (20-session-inspector-tools.jpg)]*
*Tools tab: per tool permission, calls, failed, p50; completed / failed / denied / interrupted; time executing vs waiting on you.*

*[Screenshot: Inspector: Resources (21-session-inspector-resources.jpg)]*
*Resources tab: `/mnt/session/outputs/*`, mounted memory (`/mnt/memory/<store>/`, changed files flagged "Modified"), uploads; add a resource to a live session.*

*[Screenshot: Threads (22-session-multiagent-threads.jpg)]*
*Multi-agent: one timeline lane per thread; Threads tab with status, context and **cost per thread**; subagent prompts shown inline; advisor output "Content withheld".*

*[Screenshot: Workflow run (23-session-workflow-run.jpg)]*
*Workflow run card (`wrun_…`): goal, phases → threads, tokens, time, Completed.*

*[Screenshot: Outcome grading (24-session-outcome-grading.jpg)]*
*Outcome: an independent grader checks each rubric item (met/unmet with evidence) per iteration; the Session tab shows Result, Iteration, Completed and Explanation.*

*[Screenshot: Actions (25-session-actions-menu.jpg)]*
*Actions: Send interrupt, Define outcome, Edit budget, Archive.*

*[Screenshot: session assistant (26-session-assistant.jpg)]*
*Session assistant: a session debugger with presets (errors, performance, flow trace, improvements). It cost ~$0.29 for one analysis.*

**Approvals** (hands-on): `always_ask` tools pause with inline Approve / Deny; a denied call is labelled and the agent continues. **Interrupt** stops mid-turn and marks the in-flight call "Interrupted".

### 2.5 Deployments
*[Screenshot: Deployment schedule (27-deployment-schedule.jpg)]*
*Deployment: agent + **pinned version** + environment + initial message + budget + trigger (Manual / Schedule: every minute, hour, daily, weekdays, weekly, custom cron, timezone, next-5-runs) + vaults + resources. Pause / Archive.*

*[Screenshot: Deployment runs (28-deployment-runs.jpg)]*
*Runs: run ID, started, trigger, status, agent version, linked session.*

### 2.6 Memory, vaults, resources, settings
*[Screenshot: Memory (29-memory-store.jpg)]*
*Memory store: a file tree people can edit; each file shows ID, size, updated, **Updated by (session ID)**. The Console shows no version history, but the API has `memory_versions` (list, retrieve, redact).*

*[Screenshot: Vault (30-vault-credentials.jpg)]*
*[Screenshot: Credential types (31-vault-credential-types.jpg)]*
*Vaults are workspace-wide. Credential types: MCP OAuth, Bearer token (bound to an MCP URL), Environment variable (the agent never sees the value). Teams create **one vault per run** to isolate credentials.*

*[Screenshot: Resources (32-resources-overview.jpg)]*
*Resources: Files, versioned Skills (upload up to 8 MB), Webhooks, App integrations (App Attest).*

*[Screenshot: Webhook events (33-webhook-events.jpg)]*
*38 webhook event types: session, thread, outcome, budget, vault, credential (incl. `refresh_failed`), agent, deployment, deployment_run, environment, memory_store.*

*[Screenshot: Capabilities (34-org-capabilities.jpg)]*
*Org-wide switches only: web search/fetch (domain lists), Managed Agents on/off. People roles: Admin / Developer only (not screenshotted; contains emails). API keys act as a user or service account, with cost per key.*

### 2.7 Gaps we exploit
| CMA today | Our answer |
|---|---|
| Anthropic models only | **Every OpenRouter model**, chosen per agent, sub-agent and advisor |
| Orchestration only in Anthropic's cloud (self-hosted = tool execution only) | **Full local mode** + one-click **push to cloud** + Local/Cloud switch |
| Agent chaining left to the client (files re-uploaded between sessions) | **Pipelines** with typed hand-offs |
| Vaults shared workspace-wide | Credentials scoped to agent, run and tenant |
| Roles: Admin/Developer; org-wide toggles | Roles for people **and agents**; policies |
| Observability refreshes ~3 h | Live metrics via Realtime + OpenTelemetry |
| Advisor output hidden; memory history only in the API (`memory_versions`), not shown in the Console | Full audit of every model output; memory version history and diff in the UI |
| Forms silently reuse previous resources | Explicit, reviewable configuration |

---

## 3. Goals, non-goals, users

**Goals**
1. CMA feature parity (§2).
2. OpenRouter-powered model choice.
3. Same experience local and cloud, with frictionless promotion.
4. Supabase-native backend.
5. Low cost per session.

**Non-goals (v1)**
- Our own models.
- A drag-and-drop workflow builder.
- Mobile apps.

**Users**
- **Agent builder:** builds and tests locally.
- **Operator:** runs deployments in the cloud.
- **Admin:** keys, members, governance.
- **App developer:** calls agents via the API.

---

## 4. Core concepts and data model (Supabase Postgres)

| Table | Key columns | Notes |
|---|---|---|
| `orgs`, `workspaces`, `members` | role | Supabase Auth users; RLS on `workspace_id` everywhere |
| `provider_settings` | workspace_id, provider='openrouter', key_secret_id, status, last_checked | Key stored in **Supabase Vault**; only the runtime can read it |
| `models_cache` | id, name, context_length, pricing, supported_parameters, modalities, updated_at | Synced from OpenRouter `/api/v1/models` |
| `agents`, `agent_versions` | slug, version, spec (JSONB = the YAML), created_by | Immutable versions; slug is stable across local/cloud |
| `environments` | hosting (`local_docker`, `cloud_sandbox`, `worker`), image, packages, networking | |
| `sessions` | agent_version_id, environment_id, **runs_on** (`local`, `cloud`, `worker:<id>`), status, budget_usd, cost_usd, metadata | |
| `session_events` | session_id, seq, type, payload, created_at | Append-only, partitioned by month; streamed via Realtime broadcast |
| `threads`, `workflow_runs` | session_id, parent_thread, agent spec, status, cost, context_tokens | Multi-agent |
| `tool_calls` | session_id, thread_id, tool, permission, decision, duration_ms, status | Feeds the Tools tab and observability |
| `outcomes`, `outcome_evaluations` | rubric, max_iterations, iteration, verdict, per-criterion results | |
| `memory_stores`, `memory_files`, `memory_file_versions` | path, content_ref (Storage), updated_by_session | Versioned (CMA isn't) |
| `vaults`, `credentials` | type (`mcp_oauth`, `bearer`, `env_var`), secret_id (Vault), bound_hosts, **scope** (agent/run/tenant) | |
| `skills`, `skill_versions` | storage path, SKILL.md | |
| `deployments`, `deployment_runs` | agent_version, trigger (manual/cron/webhook), cron, tz, paused, **runs_on** | Cron via Supabase Cron → Queue |
| `pipelines`, `pipeline_runs`, `pipeline_stages` | stages[], hand-off mapping | New |
| `workers` | id, owner, kind (`laptop`, `vpc`), last_seen, capabilities | Local machines registered to the cloud |
| `webhook_endpoints`, `webhook_deliveries` | events[], secret, status | |
| `audit_log` | actor (user/agent/system), action, target, hash, prev_hash | Hash-chained |

Files, outputs, memory content, skills and screenshots go in **Supabase Storage** buckets. Job queue: **Supabase Queues (pgmq)**.

---

## 5. Models: OpenRouter

### 5.1 Settings → Model provider
- **OpenRouter API key** field with **Test connection**. The key is validated against OpenRouter and saved to Supabase Vault (cloud) or the OS keychain / `.env.local` (local).
- Optional extras: default provider-routing preferences (allowed and blocked providers, data policy), a monthly spend alert, and an optional per-agent key override.
- Status card: key valid, credits remaining (if exposed), last sync.

### 5.2 Model catalog
- Synced from **`GET https://openrouter.ai/api/v1/models`** (public) into `models_cache`, refreshed hourly and on demand.
- Each model carries pricing, context window, modalities and `supported_parameters`.
- The picker shows every model, with filters: **Supports tools** (the default for agents, using `supported_parameters=tools`), provider, price, context, free models.
- It shows a price per 1M tokens and the context size for each model, plus a warning when a model lacks tool calling.
- Used for: the agent's main model, **fallback models** (ordered list), **sub-agent default model**, **advisor model** and **outcome grader model**.

### 5.3 Runtime behaviour
- One **Model Gateway** module calls OpenRouter's OpenAI-compatible chat completions with `tools`, streaming, and usage accounting. It records input, output, cached and reasoning tokens and the cost returned in usage, so cost per session and thread is exact.
- **Tool-call repair:** validate tool JSON against the schema, retry once with an error message, then fall back to the next model in the list.
- **Prompt caching:** use it wherever OpenRouter supports it for the chosen provider. CMA showed ~97% of input tokens are cache reads, so the agent loop keeps a stable prefix (system prompt + tool list first). *Verify cache support per provider in Phase 0, because it varies.*
- **Effort/reasoning** maps to OpenRouter's reasoning parameters where the model supports them.

---

## 6. Local ↔ Cloud architecture

### 6.1 One product, two places
```
                LOCAL (laptop)                                CLOUD
  ┌──────────────────────────────────────┐     ┌──────────────────────────────────────┐
  │ agentos CLI (`agentos dev`)          │     │ Console (React SPA)     ── Railway   │
  │  ├─ Console  localhost:4000          │     │ API + Runtime workers   ── Railway   │
  │  ├─ Runtime (same code as cloud)     │     │ Supabase (cloud project)             │
  │  ├─ Supabase local (CLI, Docker)     │     │  Postgres · Auth · Storage · Realtime │
  │  └─ Sandboxes: Docker per session    │     │  Vault · Queues · Cron               │
  └──────────────┬───────────────────────┘     │ Sandboxes: E2B / Railway Sandboxes   │
                 │  `agentos push` / Deploy     └──────────────────┬───────────────────┘
                 └────────────────► agent YAML, envs, skills ─────┘
                 ◄──── optional: laptop registers as a WORKER (outbound only) ────
                             Both call OpenRouter for models
```

### 6.2 How the switch works
1. **Agent definitions are portable files.** Each agent is a YAML file with a stable **slug** (`agents/<slug>/agent.yaml`, plus `environment.yaml` and skills). They are identical locally and in the cloud and live in git.
2. **Push to cloud:** `agentos push` or the Console's **Deploy to cloud** button uploads the agent version, environment, skills and (optionally) memory stores to the cloud workspace and creates a new cloud version.
   - Secrets are **never copied**. The push lists the credentials the agent needs and asks you to map each one to a cloud vault entry.
   - It shows a **diff** before applying.
3. **Runs on: Local / Cloud** is a field on every session and deployment.
   - **Standalone local mode:** everything runs on the laptop, offline except for OpenRouter.
   - **Cloud-connected mode:** the laptop registers as a **worker** (outbound connection only). In the cloud Console you can then choose **Runs on: Cloud** or **Runs on: My laptop** per session or deployment. The control plane, history and observability stay in the cloud; tool execution happens where you chose.
4. **Pull from cloud:** `agentos pull` brings cloud agent versions back down for local editing.
5. **Same runtime binary** in all modes. Only two things differ: the sandbox provider (Docker vs E2B/Railway) and the Supabase URL.

### 6.3 Services
| Service | Role | Local | Cloud |
|---|---|---|---|
| Console | React + TypeScript SPA (Vite), shadcn/ui + Radix + Tailwind, Lucide icons, Recharts, React Router; talks only to the `/v1` API | Static files served by the local API server | Railway static service (or any CDN) |
| API | Node + TypeScript (Hono), REST + SSE, the CMA-compatible `/v1` (§6A) | same process, port 4000 | Railway |
| Runtime workers | Agent loop, Model Gateway, tool router, MCP client, multi-agent threads, outcome grader, compaction, budgets | same process | Railway, autoscaled replicas, consuming Supabase Queues |
| Scheduler | Cron → queue | Supabase Cron (local) | Supabase Cron |
| Egress proxy | Injects credentials into outbound calls; host allow-list | in runtime | in runtime |
| Sandbox | Runs bash/files/code for one session | Docker container | E2B microVM (or Railway Sandbox) |
| Storage/events | Postgres, Storage, Realtime | Supabase local | Supabase cloud |

---

## 6A. AgentOS API: the Anthropic Managed Agents standard

### 6A.1 Principle
AgentOS implements the **Anthropic Managed Agents API** as its public contract. Code written for CMA works against AgentOS by changing only the base URL and key:

```ts
const client = new Anthropic({ baseURL: "http://localhost:4000", apiKey: process.env.AGENTOS_API_KEY });
const agent = await client.beta.agents.create({ name: "Researcher", model: "qwen/qwen3-coder", system: "…",
  tools: [{ type: "agent_toolset_20260401" }] });
```

The same applies locally (`http://localhost:4000`) and in the cloud (`https://api.<agentos-domain>`). The Console itself uses this API; there is no private back door.

### 6A.2 Conventions copied from CMA
- **Auth headers:** `x-api-key` or `Authorization: Bearer`. `anthropic-version` and `anthropic-beta` (`managed-agents-2026-04-01`, `agent-memory-2026-07-22`) are accepted and validated as CMA does, so SDKs that send them work.
- **ID prefixes:** `agent_`, `env_`, `sesn_`, `sevt_`, `vlt_`, `vcrd_`, `memstore_`, `mem_`, `memver_`, `depl_`, `drun_`, `file_`, `skill_`, `wrun_`, `req_` (request IDs).
- **Updates are `POST /v1/<resource>/{id}`**, except memories, which use `PATCH`. Archive is `POST …/archive` and is terminal. Agents and threads have archive but no delete.
- **Pagination:** `limit`, `page` → `next_page` (and `prev_page` on sessions).
- **Errors:** `{"type":"error","error":{"type":"invalid_request_error","message":"…"},"request_id":"req_…"}` with the same status codes: 400, 401, 403, 404, 409, 413, 429 (with `retry-after`), 500, 529.
- **Limits:** the same field limits as CMA (e.g. 16 metadata pairs, 20 MCP servers, 50 initial events). Rate limits are configurable per deployment of AgentOS.

### 6A.3 Endpoints (CMA-compatible)
| Resource | Endpoints |
|---|---|
| Agents | `GET/POST /v1/agents` · `GET/POST /v1/agents/{id}` (optional `version` for optimistic concurrency → 409) · `POST /v1/agents/{id}/archive` · `GET /v1/agents/{id}/versions` |
| Environments | `GET/POST /v1/environments` · `GET/POST/DELETE /v1/environments/{id}` · `POST …/archive` · self-hosted work: `GET …/work/stats`, `POST …/work/{work_id}/stop` + worker poll |
| Sessions | `GET/POST /v1/sessions` · `GET/POST/DELETE /v1/sessions/{id}` · `POST …/archive` |
| Events | `GET /v1/sessions/{id}/events` · `POST /v1/sessions/{id}/events` · `GET /v1/sessions/{id}/events/stream` (SSE, optional `event_deltas[]`) |
| Threads | `GET /v1/sessions/{id}/threads` · `GET …/threads/{tid}` · `POST …/threads/{tid}/archive` · `GET …/threads/{tid}/events` · `GET …/threads/{tid}/stream` |
| Session resources | `GET/POST /v1/sessions/{id}/resources` · `GET/POST/DELETE …/resources/{rid}` (`file`, `github_repository`; `memory_store` at create) |
| Deployments | `POST /v1/deployments` · `POST /v1/deployments/{id}` · `…/pause` · `…/unpause` · `…/archive` · `…/run` |
| Deployment runs | `GET /v1/deployment_runs?deployment_id=…` · `GET /v1/deployment_runs/{id}` (error types: `environment_archived`, `agent_archived`, `vault_not_found`, `session_rate_limited`, `service_unavailable`) |
| Vaults / credentials | `GET/POST /v1/vaults` · `GET/POST/DELETE /v1/vaults/{id}` · `…/archive` · `/v1/vaults/{id}/credentials` (+ `{cid}`, `archive`, `mcp_oauth_validate`) |
| Memory | `/v1/memory_stores` (CRUD + archive) · `/v1/memory_stores/{id}/memories` (create, get, `PATCH` update with `content_sha256` precondition, delete) · `/v1/memory_stores/{id}/memory_versions` (list, get, `redact`) |
| Files | `POST/GET /v1/files` · `GET/DELETE /v1/files/{id}` · `GET /v1/files/{id}/content` |
| Skills | `POST/GET /v1/skills` · `GET/DELETE /v1/skills/{id}` · `/v1/skills/{id}/versions` (+ `{version}`) |

**Request bodies follow CMA exactly:** CreateAgent (model, system, tools, skills, mcp_servers, multiagent, metadata), CreateSession (agent as string / pinned / `agent_with_overrides`, environment_id, resources, `initial_events`, vault_ids, `budget.max_list_cost` in cents, metadata), CreateEnvironment (`config.type`, networking, packages), CreateDeployment (`schedule: {type: cron, expression, timezone}`), SendEvents (`user.message`, `user.custom_tool_result`, `user.tool_confirmation`, `user.interrupt`, `user.define_outcome`, `system.message`).

**Event types emitted** match CMA:
- **Session:** `session.status_*`, `session.thread_status_*`, `session.usage`, `session.error`.
- **Spans:** `span.model_request_start|end`, `span.outcome_evaluation_*`.
- **Agent:** `agent.message`, `agent.thinking`, `agent.tool_use|tool_result`, `agent.mcp_tool_use|mcp_tool_result`, `agent.custom_tool_use`.
- **Workflows:** `workflow_run.*`.
- **Webhooks:** the 38 event types (§2.6).

### 6A.4 Where AgentOS differs (documented, minimal)
| Area | CMA | AgentOS |
|---|---|---|
| `model` | Anthropic model IDs | **OpenRouter model slugs** (e.g. `google/gemini-4-hydrogen`, `qwen/qwen3-coder`). The object form also accepts `fallbacks: [slug…]` and `provider: {order, allow, deny, data_collection}` (OpenRouter routing). `effort` maps to OpenRouter reasoning settings where supported. |
| Advisor / grader / sub-agent models | Anthropic models only | Any OpenRouter slug |
| Environment `config.type` | `cloud`, `self_hosted` | `cloud`, `self_hosted`, **`local`** (Docker on the machine running AgentOS) |
| Session placement | n/a | Extension field `runs_on: "local" | "cloud" | "worker:<id>"` on sessions and deployments |
| Model-specific features | Some features (e.g. `system.message`) are limited to certain Anthropic models | Allowed for every model; quality depends on the model |

### 6A.5 AgentOS extensions (`/v1/x/…`)
| Endpoint | Purpose |
|---|---|
| `GET/PUT /v1/x/providers/openrouter` · `POST …/test` | Set or validate the OpenRouter key (stored in Vault or keychain), routing defaults, spend alert |
| `GET /v1/x/models` · `POST /v1/x/models/sync` | Cached OpenRouter catalog (filters: `supports_tools`, price, context) |
| `POST /v1/x/push` · `POST /v1/x/pull` | Promote agents, environments and skills between local and cloud (dry-run diff, secret mapping) |
| `GET/POST /v1/x/workers` | Register and list local or VPC workers |
| `/v1/x/pipelines`, `/v1/x/pipeline_runs` | Pipelines (Phase 4) |
| `/v1/x/observability/*`, `/v1/x/audit` | Live metrics, audit log |

### 6A.6 Compatibility guarantee
A **conformance test suite** runs the official Anthropic TypeScript and Python SDKs (Managed Agents methods) against AgentOS in CI, locally and against the cloud. Each endpoint is marked Supported, Partial or Not yet, with reasons, in a generated compatibility table (the approach SandBase uses). A release can't ship if the table drifts from the code.

---

## 7. Cloud compute: what to use

| Option | What it is | Fit for **services** (Console, API, workers) | Fit for **per-session sandboxes** (untrusted code) |
|---|---|---|---|
| **Railway** | App platform (containers), plus newer **Sandboxes** (create / exec / checkpoint / fork / destroy, on every plan) | **Yes, recommended.** Simple deploys, autoscaling, cron, logs | **Possible.** Evaluate in Phase 0. Its own docs warn about blast radius with networked sandboxes, and the hypervisor isn't specified publicly |
| **E2B** | Firecracker microVM sandboxes, pause/resume, open source (self-hostable), SDKs | No | **Yes, recommended default.** Strong isolation, made for agents, and its open-source self-host keeps parity with VPC installs |
| **Fly.io Machines / Sprites** | Firecracker microVMs on demand, persistent workspaces | Possible | Good alternative, especially for long-lived workspaces |
| **Vercel Sandbox / Cloudflare Sandbox / Modal / Northflank** | microVM or gVisor sandboxes | – | Alternatives. Cloudflare has 1–3 s cold starts; Modal uses gVisor |
| **Blacksmith** | Faster **GitHub Actions runners**; "Testboxes" (beta, run via GitHub Actions) and "Sandboxes" (coming soon) for coding agents | No | **Not today.** It's built around CI. Revisit when Sandboxes are generally available |

**Recommendation:**
- **Railway** for all always-on services.
- **Supabase** for data, auth and events.
- A **`SandboxProvider` interface** with Docker (local), **E2B** (cloud default) and **Railway Sandboxes** (an option if Phase 0 shows good enough isolation and startup time, giving a single vendor).

Most comparisons found are written by vendors, so benchmark start time, cost per sandbox-minute and isolation ourselves in Phase 0.

---

## 8. UI (Console) screens

**Stack:**

| Layer | Technology |
|---|---|
| Framework | React + TypeScript (Vite build) |
| Components | **shadcn/ui** (buttons, dialogs, forms, tables, cards, tabs, dropdowns, sheets, toasts) |
| Primitives | Radix UI |
| Styling | Tailwind CSS (light and dark themes) |
| Icons | Lucide React |
| Charts | Recharts (sessions over time, cost-over-time, active time, tool usage, context usage, p50/p90/p95) |
| Routing | React Router |

**Supporting libraries (proposed):**
- TanStack Query for API data and caching.
- An SSE client for live session events.
- CodeMirror for the Raw YAML, JSON schema and memory editors.
- React Hook Form + Zod, with types generated from the API schema.

The UI mirrors CMA (§2) plus our additions (**bold**).

**Routes (React Router):** `/overview`, `/create`, `/agents`, `/agents/:id/(config|sessions|deployments|observability)`, `/sessions`, `/sessions/:id?inspector=(session|events|tools|resources|threads)`, `/deployments`, `/deployments/:id/(config|runs)`, `/environments`, `/memory`, `/memory/:id`, `/vaults`, `/vaults/:id`, `/skills`, `/files`, `/webhooks`, `/workers`, `/pipelines`, `/settings/(provider|members|keys|telemetry|governance)`.

| Area | Screens |
|---|---|
| Home / Overview | KPIs, sessions over time, active time per agent, **Local vs Cloud split**, **spend by model** |
| Create | Describe-your-agent builder (uses an OpenRouter model), templates, blank agent |
| Agents | List; detail tabs Configuration (Rendered/Raw YAML, versions, **diff between versions**), Sessions, Deployments, Observability (**live**); **Deploy to cloud** button; **model picker = OpenRouter catalog** |
| Tools | Built-in tools with Auto / Allow / Ask / Off; MCP servers (catalog + URL + Connect); custom tools (JSON schema) |
| Skills | Upload (zip / SKILL.md / folder), versions |
| Multiagent | Workflows, Subagents (ad-hoc + saved), Advisor (any OpenRouter model) |
| Environments | **Hosting: Local Docker / Cloud sandbox / Worker**, networking, packages |
| Sessions | List (cost/budget, tokens incl. cache, **Runs on** badge); detail = transcript + timeline lanes + inspector (Session, Events, Tools, Resources, Threads) + Actions (interrupt, outcome, budget, archive) + **Ask AI** |
| Deployments | Trigger (manual / cron / **webhook**), pinned version, **Runs on switch**, runs list, pause |
| **Pipelines** | Stage graph, hand-off mapping, run view across sessions |
| Memory | File tree, editor, **version history + diff** |
| Credential vaults | MCP OAuth, Bearer, Env var; **scope to agent / run** |
| **Workers** | Registered laptops / VPC workers, status, capabilities |
| Settings | **Model provider (OpenRouter key, routing prefs, catalog sync)**, members & roles, API keys, webhooks, OpenTelemetry, **governance & audit** |

---

## 9. Functional requirements (summary)

Priority: **P0** = MVP · **P1** = cloud GA · **P2** = later.

| ID | Requirement | P |
|---|---|---|
| MD-1 | OpenRouter key setting (validate, store in Vault or keychain), model catalog sync, tool-capable filter | P0 |
| MD-2 | Per-agent model + fallbacks; sub-agent, advisor and grader models from the catalog; usage and cost from OpenRouter | P0 |
| MD-3 | Tool-call validation and repair; prompt-cache-friendly prompts | P0 |
| AG-1 | Agents CRUD, immutable versions, Rendered/Raw YAML, version diff | P0 |
| AG-2 | Agents as files (`agents/<slug>/…`), `agentos init/dev/apply/push/pull` CLI | P0 |
| EN-1 | SandboxProvider: Docker (local), E2B (cloud), Railway Sandboxes (option), worker | P0 / P1 |
| EN-2 | Networking limited/unrestricted + allowed hosts; packages; resource limits | P0 |
| TL-1 | Built-in tools (bash, read, write, edit, glob, grep, web_fetch, web_search) | P0 |
| TL-2 | Per-tool Auto / Allow / Ask / Off with Approve/Deny UI | P0 |
| TL-3 | Custom tools (JSON schema, `requires_action`) | P0 |
| MC-1 | MCP servers by URL + bearer; MCP OAuth Connect + refresh | P1 |
| SE-1 | Sessions: create, message, interrupt, budget (+ edit), metadata, resources, outputs folder | P0 |
| SE-2 | Append-only events + live stream (Realtime) + replay; full event taxonomy (§2.4) | P0 |
| SE-3 | Session viewer: transcript, timeline lanes, inspector tabs, cost chart, cache breakdown | P0 / P1 |
| SE-4 | Ask AI session debugger | P2 |
| RO-1 | **Runs on** Local / Cloud / Worker for sessions and deployments | P1 |
| RO-2 | **Push / pull** with diff and secret mapping; worker registration | P1 |
| MA-1 | Subagents (ad-hoc + saved), Workflow runs (phases), Advisor; per-thread cost/context | P1 |
| OU-1 | Outcomes: rubric, independent grader, iterations, verdict with evidence | P1 |
| ME-1 | Memory stores mounted at `/mnt/memory/<store>/`, read-only or read-write, **versioned** | P1 |
| DP-1 | Deployments: pinned version, manual/cron/webhook triggers, runs, pause | P1 |
| PL-1 | Pipelines: chained agents, typed hand-offs, one run ID, resume a failed stage | P2 |
| VA-1 | Vaults & credentials (MCP OAuth, bearer, env var) with egress injection; scoped | P1 |
| OB-1 | Live per-agent observability; OpenTelemetry export; webhooks (all lifecycle events) | P1 |
| GV-1 | Org/workspace roles; agent roles & policies; hash-chained audit | P2 |

---

## 10. Phased build plan

Rough estimates for a team of 2–3 engineers. Each phase ends in something usable.

### Phase 0: Foundations and spikes (1–2 weeks)
- **Backend:**
  - Monorepo (pnpm): `apps/console/` (React + Vite + shadcn/ui), `apps/api/` (Hono, `/v1`), `packages/runtime/` (agent loop), `packages/sdk-types/` (CMA-compatible types shared by API and UI), `apps/cli/` (`agentos`), `supabase/` (migrations).
  - Console shell: layout, sidebar, routes, theme, shadcn/ui components installed.
  - CMA API contract captured as an OpenAPI spec; conformance-test harness using the official Anthropic SDKs.
  - Supabase schema v0 (§4) with RLS.
  - Local stack via `supabase start`.
- **Spikes:**
  1. **OpenRouter:** tool-calling reliability and prompt caching on 5 candidate models (e.g. one Anthropic model, one GPT, Qwen, DeepSeek, Llama), measuring task success, cost and latency on 10 agent tasks.
  2. **Sandboxes:** Docker vs E2B vs Railway Sandboxes on start time, cost per minute, isolation, file upload/download.
- **Exit:** chosen default models list; chosen cloud sandbox; schema reviewed.

### Phase 1: Local MVP (3–4 weeks)
- **Backend / runtime:**
  - Agent loop with the OpenRouter Model Gateway.
  - Built-in tools in Docker sandboxes; permissions (allow / ask / deny) with approvals; custom tools.
  - Budgets and cost tracking.
  - Event log + Realtime stream; outputs to Storage.
- **API:** CMA-compatible `/v1` for agents (+ versions), environments, sessions, events (+ SSE stream), files; `/v1/x/providers/openrouter` and `/v1/x/models`.
- **CLI:** `agentos init`, `agentos dev` (starts Supabase local + API/runtime + Console on localhost:4000), `agentos run`.
- **Exit test:** the official Anthropic SDK creates an agent and a session against `localhost:4000` using an OpenRouter model.
- **UI:**
  - **Login screen** (admin username + password from `agentos init`).
  - Settings → **API keys**.
  - Settings → **Model provider** (OpenRouter key, Test, catalog).
  - Agents list and detail (Rendered/Raw, versions) with the **OpenRouter model picker**.
  - Environments (local Docker).
  - Sessions list and **session viewer** (transcript, Session / Events / Tools / Resources tabs, cost chart, Actions: interrupt, edit budget).
- **Exit:** build an agent locally on any OpenRouter model, run it, approve a tool, see cost and events. This is the local equivalent of the CMA test runs in §2.

### Phase 2: Cloud + Local/Cloud switch (3–4 weeks)
- **Backend:**
  - Deploy the Console, API and runtime workers to **Railway**; Supabase cloud project.
  - Auth, orgs and workspaces with RLS.
  - Cloud sandbox provider (**E2B** or Railway Sandboxes per Phase 0).
  - Vaults (Supabase Vault) and the egress proxy.
  - MCP servers (URL + bearer).
- **Switch:**
  - `agentos push` / **Deploy to cloud** (diff + secret mapping) and `agentos pull`.
  - **Worker registration** for laptops; the **Runs on** field on sessions.
- **UI:** login, workspace switcher, Credential vaults, Workers page, "Runs on" badge and selector, Deploy-to-cloud dialog.
- **Exit:** the same agent runs locally and in the cloud; a cloud session can be sent to "My laptop".

### Phase 3: CMA parity (4–5 weeks)
- **Backend:**
  - Memory stores (versioned).
  - Deployments (Supabase Cron → queue; manual / cron / webhook triggers; pause; runs).
  - Outcomes (grader on a chosen model).
  - Multi-agent: subagents, workflow runs, advisor.
  - Skills upload; MCP OAuth Connect; outbound webhooks.
- **UI:**
  - Memory screens (tree, editor, versions).
  - Deployments (schedule builder, next runs, runs list) with the **Runs on** switch.
  - Threads tab and timeline lanes; workflow run card; outcome grading card; Skills; Webhooks; live per-agent Observability.
- **Exit:** every CMA flow in §2 works on our platform, local and cloud.

### Phase 4: Differentiators (4+ weeks)
- **Pipelines:** stage graph, hand-offs, resume.
- **Governance:** member roles, agent roles and policies, scoped credentials, hash-chained audit and export.
- **Ask AI** session debugger; guided builder; templates gallery; OpenTelemetry export; version diff.

### Phase 5: Hosted GA
- Billing (sandbox minutes plus model pass-through or bring-your-own key).
- Quotas and abuse protection.
- Status page and SLAs.
- Security review, then SOC 2.

---

## 11. Non-functional requirements
| Area | Target |
|---|---|
| Parity | The same agent YAML produces the same behaviour locally and in the cloud |
| Isolation | One sandbox per session; microVMs in the cloud; default-deny egress; secrets never in the sandbox |
| Latency | Session start < 3 s warm / < 15 s cold; first event < 1 s after the model starts streaming |
| Reliability | Sessions survive worker restarts (resume from the event log); idempotent tool calls |
| Cost | Prompt-cache-friendly loop; per-session and per-thread cost visible live |
| Observability | Live metrics; OpenTelemetry; webhooks |

---

## 12. Risks and open questions
| Risk | Mitigation |
|---|---|
| Open models are weaker at long tool-using tasks | Phase 0 benchmark; recommend models per task; fallbacks; Anthropic and OpenAI models also available via OpenRouter |
| Prompt caching varies by OpenRouter provider, so cost may be higher than CMA | Measure in Phase 0; pin providers that cache; show cache ratio in the UI |
| Supabase Realtime throughput for busy sessions | Use broadcast channels, batch small events, store first and stream second |
| Railway Sandboxes isolation is not publicly specified | Default to E2B; keep the provider interface |
| Blacksmith sandboxes not GA | Re-evaluate later |
| Hosting untrusted code (abuse, cost) | microVMs, egress default-deny, quotas, budgets mandatory on free tier |

**Decided:**
- Name: **AgentOS**.
- API: **follow CMA's `/v1`** (§6A).
- Frontend stack: §8.
- Models: OpenRouter.
- Local mode: yes, with a **required admin login** (username + password, §1.2).
- Licence: **MIT**; monetised through the hosted **AgentOS Cloud** (§1.1).
- Build: **from scratch** (SandBase/OpenMA as reference only).
- CMA API: start on the current beta and **re-check periodically** (suggested monthly: diff the official SDK release notes, then update the conformance suite and compatibility table).

**Open questions:** none blocking Phase 0.

---

## Appendix A. Test resources left in the NativeFlow Console
Agents `cma-eval-guided`, `cma-eval-multiagent`; environment `cma-eval-env`; memory store `cma-eval-memory`; deployment `cma-eval-deployment` (paused); 4 test sessions. Archive them when no longer needed.

## Appendix B. Sources
- OpenRouter models API: https://openrouter.ai/docs/guides/overview/models · https://www.openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md
- Railway sandboxes: https://docs.railway.com/guides/code-execution-sandboxes · https://docs.railway.com/guides/agents-in-sandboxes
- Blacksmith: https://www.blacksmith.sh/sandboxes · https://docs.blacksmith.sh/blacksmith-testbox/overview
- Sandbox comparisons (vendor-authored; verify): https://northflank.com/blog/best-microvm-sandboxes-for-ai-coding-agents · https://upstash.com/blog/ai-agent-sandbox-providers-compared-2026 · https://blaxel.ai/blog/railway-alternatives
