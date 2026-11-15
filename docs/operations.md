# Operations and security

What an operator needs to run AgentOS for other people: model keys, limits, the security defaults,
backups and moving agents between installs. Cloud hosting itself is in
[`cloud-setup.md`](cloud-setup.md).

## Model keys (bring your own OpenRouter key)

| Mode | Where the key comes from |
|---|---|
| Local (`AGENTOS_AUTH=local`) | `OPENROUTER_API_KEY`, else the key saved in Settings (local config file) |
| Cloud (`AGENTOS_AUTH=supabase`) | the workspace's own key (Settings → Model provider, admins only), kept encrypted in Supabase Vault; else the operator's `OPENROUTER_API_KEY` as a shared platform key |

A workspace key is never returned by the API (only a hint like `sk-or-…a1b2`). Changing it takes
effect on each session's next turn. Deleting a workspace deletes its key from Vault. Leave
`OPENROUTER_API_KEY` unset in the cloud if every workspace must pay for its own usage: sessions in
a workspace without a key then stop with a `billing_error`.

## Rate limits and quotas

In memory, per API process. If you run several API replicas, the effective limit is per replica;
a shared store (Redis) is the upgrade path. `0` turns a limit off.

| Variable | Cloud default | Local default | What it limits |
|---|---|---|---|
| `AGENTOS_RATE_LIMIT_RPM` | 600 | off | requests per minute per API key or user |
| `AGENTOS_MAX_RUNNING_SESSIONS` | 10 | off | sessions running at once per workspace (new turns get `429 rate_limit_error`; deployment runs record it as the run's error) |
| `AGENTOS_WEBHOOK_RPM` | 60 | off | deployment webhook calls per minute per client IP |
| `AGENTOS_LOGIN_MAX_FAILURES` | 10 | 10 | failed sign-ins per 15 minutes, per account and per IP |
| `AGENTOS_AUTH_MAX_FAILURES` | 100 | off | invalid API keys / tokens per 15 minutes per IP |

Every 429 carries a `retry-after` header. The Anthropic SDK retries those automatically.

## Security defaults

| Area | Behaviour | Settings |
|---|---|---|
| CORS | No cross-origin browser access unless listed. The Console is same-origin (served behind the same host in the cloud, proxied by Vite locally). Local mode also allows `http://localhost:5173`. | `AGENTOS_CORS_ORIGINS=https://a.example,https://b.example` |
| Cookies | HttpOnly, SameSite=Lax; `Secure` over HTTPS, in production, or when forced | `AGENTOS_SECURE_COOKIES=1`; `AGENTOS_TRUST_PROXY=1` behind a TLS-terminating proxy (also makes rate limits use `X-Forwarded-For`) |
| Headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy: no-referrer`, a deny-all CSP and HSTS on API responses | — |
| Body size | JSON bodies up to 10 MB; uploads up to 100 MB | `AGENTOS_MAX_BODY_BYTES`, `AGENTOS_MAX_UPLOAD_BYTES` |
| SSRF | `web_fetch` (runs on the API host) and MCP server URLs can't reach loopback, private, link-local (cloud metadata) or other internal addresses; every redirect hop is checked again, and against the environment's allowed hosts | on in cloud mode; `AGENTOS_ALLOW_PRIVATE_NETWORKS=1` turns it off there, `AGENTOS_BLOCK_PRIVATE_NETWORKS=1` turns it on locally |
| Secrets | credential values and workspace model keys are in Supabase Vault; the API never returns them; sandboxes see placeholders that the egress proxy swaps for real values only on the credential's hosts | — |
| Roles | admin / developer / viewer per workspace; viewers are read-only; only admins manage members, API keys and the model key | — |
| Webhooks | a per-deployment secret token, compared in constant time; rotating it revokes the old one | — |

Known gaps, tracked for v1.x: the SSRF check resolves DNS before connecting, so a host that
changes its DNS answer between the check and the request (DNS rebinding) isn't fully covered; rate
limits aren't shared across replicas; sandboxes in `unrestricted` networking mode can reach
whatever the Docker host can reach (use `limited` networking for untrusted agents).

## Backups

```bash
pnpm agentos backup                      # → .agentos/backups/agentos-<timestamp>/
pnpm agentos backup --include-secrets    # also exports decrypted Vault secrets (keep it safe)
pnpm agentos backup --out /some/folder
pnpm agentos restore <folder> --yes      # replaces ALL AgentOS data; stop the API first
```

A backup holds `agentos.sql` (the whole `agentos` schema), `files/` (stored uploads and outputs),
`config.json` (local login and key hashes) and a `manifest.json`; everything is owner-only (0600).

- Without `--include-secrets`, restoring into the **same** database keeps credential values (they
  stay in Vault). Restoring into a **different** database without them leaves credentials and
  workspace model keys to be re-entered; the restore says how many.
- With `--include-secrets`, restore re-creates each secret in the target's Vault and relinks it.
- The database is reached through the local Supabase container when it's running, otherwise with
  `pg_dump` / `psql` on PATH and `DATABASE_URL` (for a hosted database).
- Hosted Supabase also has its own daily backups and point-in-time recovery on paid plans; use
  `agentos backup` in addition, before upgrades and migrations.

Suggested routine: a daily `agentos backup` from cron, kept for 14 days, and one with
`--include-secrets` stored in a password manager or encrypted storage after credential changes.

## Moving agents between installs (push and pull)

```bash
pnpm agentos remote add cloud https://agentos.example.com --key-stdin   # paste an API key of the target workspace
pnpm agentos push "Daily reporter" --to cloud --deployment depl_01… --dry-run
pnpm agentos push "Daily reporter" --to cloud --deployment depl_01… [--activate]
pnpm agentos pull "Daily reporter" --from cloud --deployment depl_01…
```

- Only what changed moves; an unchanged agent doesn't get a new version.
- A round trip updates the original: pulling back an agent that was pushed from here updates the
  local agent rather than creating a copy (and the same for environments and deployments).
- Environments switch type (`local` ↔ `cloud`); networking rules and packages carry over.
- Secrets and webhook tokens never move. Vaults are matched by name; a missing one stops the
  transfer before anything is written.
- New deployments arrive **paused** unless `--activate`, so a schedule never fires in two places
  by accident.
