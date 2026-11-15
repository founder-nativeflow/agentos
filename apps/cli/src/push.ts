/**
 * `agentos remote …` and `agentos push`: copy an agent version (and optionally its
 * environment and a deployment) from this AgentOS to another one, e.g. AgentOS Cloud.
 *
 *   agentos remote add <name> <url> [--key-stdin]   API key from stdin or AGENTOS_REMOTE_KEY
 *   agentos remote list | remove <name>
 *   agentos push <agent id|name> --to <remote> [--version N] [--env <id|name>]…
 *                [--deployment <id>] [--activate] [--dry-run]
 *
 * Rules: secrets are never copied (vaults are matched by display name on the target);
 * pushed objects carry `agentos.source` metadata so pushing again updates them; an
 * unchanged agent creates no new version; new deployments arrive paused unless --activate.
 * Everything is checked before the first write.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, signSession } from "../../api/src/lib/config.ts";
import { AGENTOS_HOME } from "../../api/src/lib/paths.ts";

type Json = Record<string, any>;
const REMOTES = resolve(AGENTOS_HOME, "remotes.json");
const SOURCE = "agentos.source";
const SOURCE_VERSION = "agentos.source_version";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/* ----------------------------------------------------------------- remotes */

interface Remote { url: string; api_key: string }
function loadRemotes(): Record<string, Remote> {
  return existsSync(REMOTES) ? (JSON.parse(readFileSync(REMOTES, "utf8")) as { remotes: Record<string, Remote> }).remotes : {};
}
function saveRemotes(r: Record<string, Remote>) {
  mkdirSync(dirname(REMOTES), { recursive: true });
  writeFileSync(REMOTES, JSON.stringify({ remotes: r }, null, 2), { mode: 0o600 });
  chmodSync(REMOTES, 0o600);
}
const hint = (k: string) => `${k.slice(0, 8)}…${k.slice(-4)}`;

async function readStdin(): Promise<string> {
  let d = "";
  for await (const chunk of process.stdin) d += chunk;
  return d.trim();
}

/* -------------------------------------------------------------------- http */

class Api {
  constructor(readonly name: string, readonly base: string, private headers: Record<string, string>) {}

  async call<T = Json>(path: string, init: { method?: string; json?: unknown; body?: FormData } = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: init.method ?? (init.json !== undefined || init.body ? "POST" : "GET"),
        headers: { ...this.headers, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      });
    } catch {
      throw new Error(`Can't reach ${this.name} at ${this.base}`);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as Json | null;
      throw new Error(`${this.name}: ${body?.error?.message ?? `${path} failed (${res.status})`}`);
    }
    return (await res.json()) as T;
  }

  async bytes(path: string): Promise<Blob> {
    const res = await fetch(`${this.base}${path}`, { headers: this.headers });
    if (!res.ok) throw new Error(`${this.name}: download ${path} failed (${res.status})`);
    return res.blob();
  }

  /** All pages of a CMA list. */
  async all(path: string): Promise<Json[]> {
    const out: Json[] = [];
    let page: string | null = null;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const r: { data: Json[]; next_page: string | null } = await this.call(`${path}${sep}limit=100${page ? `&page=${page}` : ""}`);
      out.push(...r.data);
      page = r.next_page;
    } while (page);
    return out;
  }
}

function localApi(): Api {
  const base = (process.env.AGENTOS_URL ?? "http://localhost:4000").replace(/\/$/, "");
  if (process.env.AGENTOS_API_KEY) return new Api("local", base, { "x-api-key": process.env.AGENTOS_API_KEY });
  const cfg = loadConfig();
  if (!cfg) throw new Error("No AGENTOS_API_KEY set and AgentOS isn't initialised here. Run `agentos init` or export AGENTOS_API_KEY.");
  return new Api("local", base, { cookie: `agentos_session=${signSession(cfg.admin.username, cfg.session_secret, 3600)}` });
}

/* -------------------------------------------------------------------- plan */

type Step = { kind: "create" | "update" | "unchanged" | "warn" | "upload"; what: string; detail: string; run?: () => Promise<void> };

const AGENT_FIELDS = ["name", "description", "system", "model", "tools", "mcp_servers", "skills", "multiagent"] as const;
const stable = (v: unknown): string => JSON.stringify(v, (_k, val) =>
  val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val);
const withoutVersionTag = (m: Json = {}) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== SOURCE_VERSION));

function flags(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => a === `--${name}` && process.argv[i + 1] && out.push(process.argv[i + 1]!));
  return out;
}
const flag = (name: string) => flags(name)[0];
const has = (name: string) => process.argv.includes(`--${name}`);

async function findBy(api: Api, list: string, ref: string, label: string): Promise<Json> {
  if (/^[a-z]+_01/.test(ref)) return api.call(`${list}/${ref}`);
  const hits = (await api.all(list)).filter((x) => String(x.name ?? x.display_name).toLowerCase() === ref.toLowerCase());
  if (hits.length === 1) return hits[0]!;
  throw new Error(hits.length ? `Several ${label}s are named "${ref}"; use the id` : `No ${label} named "${ref}" on ${api.name}`);
}

function cloudEnvConfig(cfg: Json): Json {
  // A local Docker environment becomes a cloud one; networking and packages carry over.
  return { ...cfg, type: "cloud" };
}

async function push(): Promise<void> {
  const ref = process.argv[3];
  const remoteName = flag("to");
  if (!ref || !remoteName) {
    console.log("Usage: agentos push <agent id|name> --to <remote> [--version N] [--env <id|name>] [--deployment <id>] [--activate] [--dry-run]");
    process.exitCode = 1;
    return;
  }
  const remote = loadRemotes()[remoteName];
  if (!remote) throw new Error(`No remote named "${remoteName}". Add one: agentos remote add ${remoteName} <url>`);
  const src = localApi();
  const dst = new Api(remoteName, remote.url, { "x-api-key": remote.api_key });
  const dry = has("dry-run");
  const steps: Step[] = [];

  /* ---- agent */
  const base = await findBy(src, "/v1/agents", ref, "agent");
  const version = flag("version") ? Number(flag("version")) : base.version;
  const agent = await src.call(`/v1/agents/${base.id}?version=${version}`);
  const spec: Json = Object.fromEntries(AGENT_FIELDS.map((k) => [k, agent[k]]));
  spec.metadata = { ...withoutVersionTag(agent.metadata), [SOURCE]: agent.id, [SOURCE_VERSION]: String(agent.version) };
  if (Object.keys(spec.metadata).length > 16) throw new Error("The agent has too many metadata keys to add push tracking (max 16)");

  const existing = (await dst.all("/v1/agents")).find((a) => a.metadata?.[SOURCE] === agent.id);
  const target: { id: string | null; version: number | null } = { id: existing?.id ?? null, version: existing?.version ?? null };
  if (!existing) {
    steps.push({ kind: "create", what: "agent", detail: `${agent.name} (local v${agent.version})`, run: async () => {
      const created = await dst.call("/v1/agents", { json: spec });
      target.id = created.id;
      target.version = created.version;
    } });
  } else {
    const changed = AGENT_FIELDS.some((k) => stable(existing[k]) !== stable(spec[k])) ||
      stable(withoutVersionTag(existing.metadata)) !== stable(withoutVersionTag(spec.metadata));
    if (changed) {
      steps.push({ kind: "update", what: "agent", detail: `${agent.name}: ${remoteName} v${existing.version} → v${existing.version + 1} (from local v${agent.version})`, run: async () => {
        const updated = await dst.call(`/v1/agents/${existing.id}`, { json: { ...spec, version: existing.version } });
        target.version = updated.version;
      } });
    } else {
      steps.push({ kind: "unchanged", what: "agent", detail: `${agent.name} (${remoteName} v${existing.version})` });
    }
  }

  /* ---- MCP credentials (never copied: checked) */
  const servers = (agent.mcp_servers ?? []) as Array<{ name: string; url: string }>;
  if (servers.length) {
    const vaults = await dst.all("/v1/vaults");
    const creds = (await Promise.all(vaults.map((v) => dst.all(`/v1/vaults/${v.id}/credentials`)))).flat();
    for (const s of servers) {
      const ok = creds.some((cr) => cr.auth?.type === "static_bearer" && String(cr.auth.mcp_server_url).replace(/\/+$/, "") === s.url.replace(/\/+$/, ""));
      steps.push(ok
        ? { kind: "unchanged", what: "credential", detail: `MCP ${s.name}: a ${remoteName} vault has a token for ${s.url}` }
        : { kind: "warn", what: "credential", detail: `MCP ${s.name}: no token for ${s.url} on ${remoteName}; add a static_bearer credential to a vault there (secrets are never copied)` });
    }
  }

  /* ---- deployment (reads first: it decides which environment and files are needed) */
  const deplId = flag("deployment");
  const localDepl = deplId ? await src.call(`/v1/deployments/${deplId}`) : null;
  if (localDepl && localDepl.agent.id !== agent.id) throw new Error(`Deployment ${deplId} runs a different agent (${localDepl.agent.id})`);

  /* ---- environments */
  const envRefs = new Set(flags("env"));
  if (localDepl) envRefs.add(localDepl.environment_id);
  const envMap = new Map<string, string | null>(); // local env id → target env id (null until created)
  const dstEnvs = envRefs.size ? await dst.all("/v1/environments") : [];
  for (const r of envRefs) {
    const env = await findBy(src, "/v1/environments", r, "environment");
    const want = { name: env.name, description: env.description, config: cloudEnvConfig(env.config), metadata: { ...env.metadata, [SOURCE]: env.id } };
    const match = dstEnvs.find((e) => e.metadata?.[SOURCE] === env.id) ?? dstEnvs.find((e) => e.name === env.name);
    if (!match) {
      envMap.set(env.id, null);
      steps.push({ kind: "create", what: "environment", detail: env.name, run: async () => {
        envMap.set(env.id, (await dst.call("/v1/environments", { json: want })).id);
      } });
    } else {
      envMap.set(env.id, match.id);
      const changed = stable(match.config) !== stable(want.config) || match.description !== want.description || match.metadata?.[SOURCE] !== env.id;
      steps.push(changed
        ? { kind: "update", what: "environment", detail: env.name, run: async () => void (await dst.call(`/v1/environments/${match.id}`, { json: want })) }
        : { kind: "unchanged", what: "environment", detail: env.name });
    }
  }

  if (localDepl) {
    // Vaults: matched by display name; missing ones stop the push before any write.
    const localVaults = await Promise.all((localDepl.vault_ids as string[]).map((id) => src.call(`/v1/vaults/${id}`)));
    const dstVaults = localVaults.length ? await dst.all("/v1/vaults") : [];
    const vaultIds: string[] = [];
    for (const v of localVaults) {
      const m = dstVaults.find((x) => x.display_name === v.display_name);
      if (!m) throw new Error(`The deployment uses vault "${v.display_name}", which doesn't exist on ${remoteName}. Create it there (with its credentials), then push again.`);
      vaultIds.push(m.id);
      steps.push({ kind: "unchanged", what: "vault", detail: `${v.display_name} → ${remoteName} vault ${m.id} (secrets stay where they are)` });
    }
    const dstDepls = await dst.all("/v1/deployments");
    const match = dstDepls.find((d) => d.metadata?.[SOURCE] === localDepl.id);
    // Files: uploaded to the target, unless the target deployment already has the same file
    // (same mount path, name and size) from an earlier push.
    const resources: Json[] = [];
    for (const r of localDepl.resources as Json[]) {
      const meta = await src.call(`/v1/files/${r.file_id}`);
      const entry: Json = { type: "file", file_id: "", mount_path: r.mount_path ?? null };
      resources.push(entry);
      const prior = (match?.resources as Json[] | undefined)?.find((x) => (x.mount_path ?? null) === (r.mount_path ?? null));
      const priorMeta = prior ? await dst.call(`/v1/files/${prior.file_id}`).catch(() => null) : null;
      if (priorMeta && priorMeta.filename === meta.filename && priorMeta.size_bytes === meta.size_bytes) {
        entry.file_id = priorMeta.id;
        steps.push({ kind: "unchanged", what: "file", detail: `${meta.filename} (already on ${remoteName})` });
        continue;
      }
      steps.push({ kind: "upload", what: "file", detail: `${meta.filename} (${meta.size_bytes} bytes)`, run: async () => {
        const form = new FormData();
        form.append("file", await src.bytes(`/v1/files/${r.file_id}/content`), meta.filename);
        entry.file_id = (await dst.call("/v1/files", { body: form })).id;
      } });
    }
    const build = (): Json => ({
      name: localDepl.name,
      description: localDepl.description,
      agent: { type: "agent", id: target.id, version: target.version },
      environment_id: envMap.get(localDepl.environment_id),
      initial_events: localDepl.initial_events,
      schedule: localDepl.schedule ? { type: "cron", expression: localDepl.schedule.expression, timezone: localDepl.schedule.timezone } : null,
      budget: localDepl.budget,
      vault_ids: vaultIds,
      resources,
      metadata: { ...localDepl.metadata, [SOURCE]: localDepl.id },
    });
    if (!match) {
      steps.push({ kind: "create", what: "deployment", detail: `${localDepl.name}${has("activate") ? " (active)" : " (paused: start it with --activate or in the Console)"}`, run: async () => {
        const created = await dst.call("/v1/deployments", { json: build() });
        if (!has("activate")) await dst.call(`/v1/deployments/${created.id}/pause`, { json: {} });
      } });
    } else if (
      // Unchanged only if the agent isn't about to get a new version and nothing else differs.
      !has("activate") && !steps.some((x) => x.what === "agent" && x.run) && target.version === match.agent.version &&
      resources.every((x) => x.file_id) &&
      stable({ ...build(), agent: null, metadata: null }) === stable({
        name: match.name, description: match.description, agent: null, environment_id: match.environment_id,
        initial_events: match.initial_events, schedule: match.schedule ? { type: "cron", expression: match.schedule.expression, timezone: match.schedule.timezone } : null,
        budget: match.budget, vault_ids: match.vault_ids, resources: match.resources, metadata: null,
      })
    ) {
      steps.push({ kind: "unchanged", what: "deployment", detail: `${localDepl.name} (${match.status})` });
    } else {
      steps.push({ kind: "update", what: "deployment", detail: `${localDepl.name} (pinned to the pushed version; status stays ${match.status})`, run: async () => {
        await dst.call(`/v1/deployments/${match.id}`, { json: build() });
        if (has("activate") && match.status === "paused") await dst.call(`/v1/deployments/${match.id}/unpause`, { json: {} });
      } });
    }
    if (localDepl.x_webhook?.enabled) {
      steps.push({ kind: "warn", what: "webhook", detail: `webhook tokens aren't copied; enable one on ${remoteName}: POST /v1/deployments/{id}/webhook` });
    }
  }

  /* ---- print + apply */
  const icon = { create: c.green("+"), update: c.yellow("~"), unchanged: c.dim("="), warn: c.red("!"), upload: c.green("↑") };
  console.log(`${c.bold(dry ? "Plan" : "Pushing")} ${agent.name} v${agent.version} → ${c.cyan(remoteName)} ${c.dim(`(${remote.url})`)}`);
  // Environments and files first (deployments need them), then the agent, then the deployment.
  const order = ["environment", "file", "agent", "credential", "vault", "deployment", "webhook"];
  const ordered = [...steps].sort((a, b) => order.indexOf(a.what) - order.indexOf(b.what));
  for (const s of ordered) console.log(`  ${icon[s.kind]} ${s.what.padEnd(12)} ${s.kind === "unchanged" ? c.dim(s.detail) : s.detail}`);
  if (dry) {
    console.log(c.dim("\nDry run: nothing was changed."));
    return;
  }
  for (const s of ordered) if (s.run) await s.run();
  const changes = ordered.filter((s) => s.run).length;
  console.log(changes ? c.green(`\n✔ Pushed (${changes} change${changes === 1 ? "" : "s"}). ${remoteName} agent ${target.id} v${target.version}`) : c.dim("\nNothing to push: already up to date."));
}

/* -------------------------------------------------------------------- CLI */

export async function remoteCommand(sub?: string, name?: string, url?: string): Promise<void> {
  const remotes = loadRemotes();
  if (sub === "add" && name && url) {
    const api_key = has("key-stdin") ? await readStdin() : (process.env.AGENTOS_REMOTE_KEY ?? "");
    if (!api_key) throw new Error("Provide the remote's API key with --key-stdin or AGENTOS_REMOTE_KEY");
    const base = url.replace(/\/$/, "");
    await new Api(name, base, { "x-api-key": api_key }).call("/v1/agents?limit=1"); // verify before saving
    remotes[name] = { url: base, api_key };
    saveRemotes(remotes);
    console.log(`✔ Remote "${name}" → ${base} (key ${hint(api_key)}), saved to ${REMOTES}`);
    return;
  }
  if (sub === "list") {
    const names = Object.keys(remotes);
    if (!names.length) console.log("No remotes. Add one: agentos remote add cloud https://your-agentos.example.com --key-stdin");
    for (const n of names) console.log(`${n.padEnd(12)} ${remotes[n]!.url}  ${c.dim(`key ${hint(remotes[n]!.api_key)}`)}`);
    return;
  }
  if (sub === "remove" && name) {
    if (!remotes[name]) throw new Error(`No remote named "${name}"`);
    delete remotes[name];
    saveRemotes(remotes);
    console.log(`✔ Removed remote "${name}"`);
    return;
  }
  console.log("Usage: agentos remote <add <name> <url> [--key-stdin] | list | remove <name>>");
}

export const pushCommand = push;
