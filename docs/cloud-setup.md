# AgentOS cloud setup

AgentOS Cloud runs the same code as local mode on hosted services:

| Piece | Service | Notes |
|---|---|---|
| Database, Auth, secrets | **Supabase** (cloud project) | Same schema as local; secrets in Supabase Vault |
| API + runtime | **Railway** (`deploy/api.Dockerfile`) | `AGENTOS_SANDBOX_PROVIDER=e2b` |
| Console | **Railway** (`deploy/console.Dockerfile`) | Caddy serves the build and proxies `/v1` to the API |
| Egress proxy | **Railway** (`deploy/egress.Dockerfile`) | Allow-lists + secret injection for cloud sandboxes |
| Sandboxes | **E2B** | Firecracker microVMs; one per session |

## 1. Create the accounts and keys

Your keys go in `.agentos/cloud.env`, which git ignores. Never paste them into a chat, an issue or a commit.

```bash
pnpm agentos cloud init      # creates .agentos/cloud.env from cloud.env.example
```

1. **E2B**: sign up at e2b.dev → Dashboard → **API Keys** → create a key → `E2B_API_KEY`.
2. **Supabase**: create a project at supabase.com (pick the region closest to your users).
   - The `<ref>` in `supabase.com/dashboard/project/<ref>` → `SUPABASE_PROJECT_REF`.
   - **Connect** → **Session pooler** connection string (fill in your DB password) → `SUPABASE_DB_URL`.
   - **Project Settings → API**: Project URL → `SUPABASE_URL`, `anon` key → `SUPABASE_ANON_KEY`, `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`.
   - **Database → Extensions**: make sure `supabase_vault` is enabled (it is by default).
3. **Railway**: sign up at railway.com → **Account Settings → Tokens** → create an **account** token → `RAILWAY_TOKEN`.

Then check everything:

```bash
pnpm agentos cloud check
```

It verifies each key against the real service and never prints secret values.

## 2. Try E2B sandboxes from your machine

With only `E2B_API_KEY` set, you can run the local API with cloud sandboxes:

```bash
AGENTOS_SANDBOX_PROVIDER=e2b E2B_API_KEY=… pnpm --filter @agentos/api dev
```

Sessions then show **Runs on: cloud**. Unrestricted and limited networking work through E2B's own
allow-list. Vault secrets (`environment_variable` credentials) on E2B need the egress proxy deployed
(step 3), because E2B sandboxes can't reach the proxy on your laptop.

## 3. Deploy (in progress)

The deploy step (`agentos cloud deploy`) will:

1. apply `supabase/migrations` to the Supabase project,
2. create a Railway project with three services (`api`, `console`, `egress`) from `deploy/railway/*.json`,
3. set their variables (`DATABASE_URL`, `E2B_API_KEY`, `AGENTOS_AUTH=supabase` with `SUPABASE_URL` /
   `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`, egress admin secret and CA, `API_URL`, …),
4. give the Console a public domain and the egress proxy a public TCP proxy (`AGENTOS_EGRESS_PUBLIC_ADDR`).

Images can be built and checked locally first:

```bash
docker build -f deploy/api.Dockerfile -t agentos-api .
docker build -f deploy/console.Dockerfile -t agentos-console .
docker build -f deploy/egress.Dockerfile -t agentos-egress .
```

## Sign-in and workspaces (built; tested against local Supabase Auth)

Hosted AgentOS uses Supabase Auth (`AGENTOS_AUTH=supabase`): people sign up with email, each gets a
workspace, and admins add teammates as admin, developer (build and run agents) or viewer (read-only).
API keys belong to a workspace and are stored hashed in the database. SDK users pick a workspace with
the `anthropic-workspace-id` header, as with Anthropic Managed Agents.

Try it locally (no cloud account needed):

```bash
AGENTOS_TEST_AUTH=supabase pnpm test:conformance
```

## How networking works in the cloud

| Environment networking | Vault secrets? | Sandbox egress |
|---|---|---|
| unrestricted | no | E2B default (internet) |
| limited | no | E2B allow-list (`allowOut` = allowed hosts, everything else denied) |
| any | yes | Only the AgentOS egress proxy is reachable; it applies the allow-list and injects secrets, exactly as locally |
