/**
 * `agentos cloud …`: cloud credentials (.agentos/cloud.env) and checks.
 *   agentos cloud init    create .agentos/cloud.env from cloud.env.example
 *   agentos cloud check   verify each key works (never prints secret values)
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { Sandbox } from "e2b";
import { AGENTOS_HOME, REPO_ROOT } from "../../api/src/lib/paths.ts";

export const CLOUD_ENV = resolve(AGENTOS_HOME, "cloud.env");

/** Parses KEY=value lines (no shell expansion). */
export function loadCloudEnv(): Record<string, string> {
  if (!existsSync(CLOUD_ENV)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(CLOUD_ENV, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const skip = (s: string) => console.log(`  \x1b[2m– ${s}\x1b[0m`);

function init() {
  if (existsSync(CLOUD_ENV)) {
    console.log(`${CLOUD_ENV} already exists. Edit it, then run \`pnpm agentos cloud check\`.`);
    return;
  }
  copyFileSync(resolve(REPO_ROOT, "cloud.env.example"), CLOUD_ENV);
  console.log(`Created ${CLOUD_ENV}. Fill in your keys (see docs/cloud-setup.md), then run \`pnpm agentos cloud check\`.`);
}

async function checkE2B(env: Record<string, string>): Promise<boolean> {
  if (!env.E2B_API_KEY) return (skip("E2B: E2B_API_KEY not set"), false);
  try {
    const running = await Sandbox.list({ apiKey: env.E2B_API_KEY }).nextItems();
    ok(`E2B: key works (${running.length} sandbox${running.length === 1 ? "" : "es"} running)`);
    return true;
  } catch (err) {
    bad(`E2B: ${(err as Error).message.split("\n")[0]}`);
    return false;
  }
}

async function checkSupabase(env: Record<string, string>): Promise<boolean> {
  let good = true;
  if (!env.SUPABASE_DB_URL) {
    skip("Supabase database: SUPABASE_DB_URL not set");
    good = false;
  } else {
    const sql = postgres(env.SUPABASE_DB_URL, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      const [v] = await sql`select current_setting('server_version') as version`;
      ok(`Supabase database: connected (Postgres ${String(v!.version).split(" ")[0]})`);
      const ext = await sql`select extname from pg_extension where extname = 'supabase_vault'`;
      if (ext.length) ok("Supabase Vault: available");
      else (bad("Supabase Vault: extension not enabled (Database → Extensions → supabase_vault)"), (good = false));
      const schema = await sql`select 1 from information_schema.schemata where schema_name = 'agentos'`;
      if (schema.length) ok("AgentOS schema: present");
      else skip("AgentOS schema: not created yet (the deploy step applies the migrations)");
    } catch (err) {
      bad(`Supabase database: ${(err as Error).message}`);
      good = false;
    } finally {
      await sql.end({ timeout: 2 }).catch(() => {});
    }
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    skip("Supabase API: SUPABASE_URL / SUPABASE_ANON_KEY not set");
    good = false;
  } else {
    try {
      const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/settings`, { headers: { apikey: env.SUPABASE_ANON_KEY } });
      if (res.ok) ok("Supabase Auth: reachable with the anon key");
      else (bad(`Supabase Auth: HTTP ${res.status}`), (good = false));
    } catch (err) {
      bad(`Supabase Auth: ${(err as Error).message}`);
      good = false;
    }
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) (skip("Supabase service role key: not set"), (good = false));
  else if (env.SUPABASE_URL) {
    const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users?per_page=1`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    }).catch(() => null);
    if (res?.ok) ok("Supabase service role key: valid");
    else (bad(`Supabase service role key: rejected${res ? ` (HTTP ${res.status})` : ""}`), (good = false));
  }
  return good;
}

async function checkRailway(env: Record<string, string>): Promise<boolean> {
  if (!env.RAILWAY_TOKEN) return (skip("Railway: RAILWAY_TOKEN not set"), false);
  try {
    const res = await fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RAILWAY_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "query { me { name email workspaces { id name } } }" }),
    });
    const body = (await res.json()) as { data?: { me?: { name?: string; workspaces?: Array<{ name: string }> } }; errors?: Array<{ message: string }> };
    if (body.data?.me) {
      const ws = body.data.me.workspaces?.map((w) => w.name).join(", ") || "none";
      ok(`Railway: token works (workspaces: ${ws})`);
      return true;
    }
    bad(`Railway: ${body.errors?.[0]?.message ?? `HTTP ${res.status}`} (use an account token, not a project token)`);
    return false;
  } catch (err) {
    bad(`Railway: ${(err as Error).message}`);
    return false;
  }
}

async function check() {
  if (!existsSync(CLOUD_ENV)) {
    console.log("No cloud credentials yet. Run `pnpm agentos cloud init`, fill in the file, then check again.");
    process.exitCode = 1;
    return;
  }
  const env = loadCloudEnv();
  console.log(`Checking ${CLOUD_ENV}\n`);
  const results = [await checkE2B(env), await checkSupabase(env), await checkRailway(env)];
  console.log(results.every(Boolean) ? "\nAll set." : "\nSome checks failed or were skipped; see above.");
  process.exitCode = results.every(Boolean) ? 0 : 1;
}

export async function cloudCommand(sub?: string): Promise<void> {
  if (sub === "init") return init();
  if (sub === "check") return check();
  console.log("Usage: agentos cloud <init | check>");
}
