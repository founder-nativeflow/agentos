/**
 * agentos backup  [--out <dir>] [--include-secrets]
 * agentos restore <backup-dir> --yes
 *
 * A backup is a folder (default .agentos/backups/agentos-<timestamp>/) with:
 *   agentos.sql    pg_dump of the `agentos` schema: agents and versions, environments, sessions
 *                  and events, deployments, vault/credential metadata, workspaces, API key hashes
 *   files/         uploaded files and session outputs (local storage)
 *   config.json    the local admin login, API key hashes and local OpenRouter key (local mode)
 *   secrets.json   only with --include-secrets: decrypted Vault secrets (credential values,
 *                  workspace OpenRouter keys). Without it, restored vault credentials keep their
 *                  metadata but must be re-entered when restored into a different database.
 *   manifest.json  what's inside, and when it was taken
 * Everything is written with owner-only permissions (0600 / 0700).
 *
 * The database is reached through the local Supabase container (supabase_db_agentos) when it
 * is running, otherwise with pg_dump / psql on PATH and DATABASE_URL.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENTOS_HOME, FILES_DIR } from "../../api/src/lib/paths.ts";
import { CONFIG_PATH } from "../../api/src/lib/config.ts";

const CONTAINER = process.env.AGENTOS_DB_CONTAINER ?? "supabase_db_agentos";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
/** Columns that hold vault.secrets ids. */
const SECRET_REFS = [
  ["credentials", "secret_id"],
  ["provider_settings", "key_secret_id"],
  ["webhook_endpoints", "secret_id"],
  ["workspaces", "openrouter_secret_id"],
] as const;

function useContainer(): boolean {
  const r = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}

function pg(tool: "pg_dump" | "psql", args: string[], input?: string): string {
  const r = useContainer()
    ? spawnSync("docker", ["exec", "-i", CONTAINER, tool, "-U", "postgres", "-d", "postgres", ...args], { input, encoding: "utf8", maxBuffer: 1 << 30 })
    : spawnSync(tool, [DATABASE_URL, ...args], { input, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error) throw new Error(`${tool} is not available (${r.error.message}). Start local Supabase or install the PostgreSQL client tools.`);
  if (r.status !== 0) throw new Error(`${tool} failed: ${r.stderr.trim().split("\n").slice(-5).join("\n")}`);
  return r.stdout;
}
const sql = (query: string) => pg("psql", ["-v", "ON_ERROR_STOP=1", "-qtA", "-c", query]);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function writePrivate(path: string, data: string) {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function backupCommand() {
  const argv = process.argv.slice(3);
  const outIdx = argv.indexOf("--out");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = resolve(outIdx >= 0 ? argv[outIdx + 1]! : join(AGENTOS_HOME, "backups", `agentos-${stamp}`));
  const withSecrets = argv.includes("--include-secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  console.log(`Backing up to ${dir}`);
  const dump = pg("pg_dump", ["--schema=agentos", "--no-owner", "--no-privileges"]);
  writePrivate(join(dir, "agentos.sql"), dump);
  const counts = JSON.parse(
    sql(`select json_build_object(
      'workspaces', (select count(*) from agentos.workspaces), 'agents', (select count(distinct id) from agentos.agents),
      'sessions', (select count(*) from agentos.sessions), 'deployments', (select count(*) from agentos.deployments),
      'files', (select count(*) from agentos.files), 'credentials', (select count(*) from agentos.credentials))`).trim(),
  ) as Record<string, number>;
  console.log(`  ✓ database (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")})`);

  if (existsSync(FILES_DIR)) {
    cpSync(FILES_DIR, join(dir, "files"), { recursive: true });
    console.log("  ✓ stored files");
  }
  if (existsSync(CONFIG_PATH)) {
    writePrivate(join(dir, "config.json"), readFileSync(CONFIG_PATH, "utf8"));
    console.log("  ✓ local config");
  }

  let secrets = 0;
  if (withSecrets) {
    const refs = SECRET_REFS.map(([t, c]) => `select ${c} as id from agentos.${t} where ${c} is not null`).join(" union ");
    const rows = sql(`select coalesce(json_agg(json_build_object('id', s.id, 'name', s.name, 'description', s.description, 'secret', s.decrypted_secret)), '[]')
      from vault.decrypted_secrets s where s.id in (${refs})`).trim();
    secrets = (JSON.parse(rows) as unknown[]).length;
    writePrivate(join(dir, "secrets.json"), rows);
    console.log(`  ✓ ${secrets} Vault secrets (decrypted — keep this backup somewhere safe)`);
  } else {
    console.log("  · Vault secrets not included (add --include-secrets to export credential values)");
  }
  writePrivate(join(dir, "manifest.json"), JSON.stringify({ format: 1, created_at: new Date().toISOString(), counts, secrets_included: withSecrets, secrets }, null, 2));
  console.log(`Done. Restore with: pnpm agentos restore ${dir} --yes`);
}

export async function restoreCommand(dirArg: string | undefined) {
  if (!dirArg) throw new Error("Usage: agentos restore <backup-dir> --yes");
  const dir = resolve(dirArg);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { created_at: string; counts: Record<string, number> };
  if (!process.argv.includes("--yes")) {
    console.log(`This replaces ALL AgentOS data in the database with the backup from ${manifest.created_at}`);
    console.log(`(${Object.entries(manifest.counts).map(([k, v]) => `${v} ${k}`).join(", ")}). Stop the API first, then re-run with --yes.`);
    process.exit(1);
  }
  // Remember the Vault secrets the current data uses; the ones nothing uses after the restore are removed.
  const refsOf = () => SECRET_REFS.map(([t, c]) => `select ${c} as id from agentos.${t} where ${c} is not null`).join(" union ");
  const hasSchema = sql("select count(*) from information_schema.schemata where schema_name = 'agentos'").trim() === "1";
  const before = hasSchema ? sql(`select coalesce(json_agg(id), '[]') from (${refsOf()}) r`).trim() : "[]";
  sql("drop schema if exists agentos cascade;");
  pg("psql", ["-v", "ON_ERROR_STOP=1", "-q"], readFileSync(join(dir, "agentos.sql"), "utf8"));
  console.log("  ✓ database");

  const secretsPath = join(dir, "secrets.json");
  if (existsSync(secretsPath)) {
    const secrets = JSON.parse(readFileSync(secretsPath, "utf8")) as Array<{ id: string; name: string | null; description: string | null; secret: string }>;
    for (const s of secrets) {
      const fresh = sql(`select vault.create_secret(${lit(s.secret)}, ${s.name ? lit(`${s.name}:restored:${Date.now()}`) : "null"}, ${lit(s.description ?? "")})`).trim();
      for (const [t, c] of SECRET_REFS) sql(`update agentos.${t} set ${c} = ${lit(fresh)} where ${c} = ${lit(s.id)}`);
    }
    console.log(`  ✓ ${secrets.length} Vault secrets`);
  } else {
    // Without exported secrets, references only work if the original rows still exist in this Vault.
    const missing = sql(`select count(*) from (${refsOf()}) r
      where not exists (select 1 from vault.secrets s where s.id = r.id)`).trim();
    if (Number(missing)) console.log(`  · ${missing} credential values were not in the backup; re-enter them in Vaults / Settings`);
  }

  const orphaned = sql(`delete from vault.secrets where id in (select value::uuid from json_array_elements_text(${lit(before)}::json))
    and id not in (${refsOf()}) returning id`).trim().split("\n").filter(Boolean).length;
  if (orphaned) console.log(`  · removed ${orphaned} Vault secrets the replaced data used`);

  if (existsSync(join(dir, "files"))) {
    cpSync(join(dir, "files"), FILES_DIR, { recursive: true });
    console.log("  ✓ stored files");
  }
  if (existsSync(join(dir, "config.json"))) {
    writePrivate(CONFIG_PATH, readFileSync(join(dir, "config.json"), "utf8"));
    console.log("  ✓ local config");
  }
  console.log("Restored. Start the API again.");
}
