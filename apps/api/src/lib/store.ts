import postgres from "postgres";
import type { Agent, CredentialAuth, Environment, FileMetadata, Session, SessionEvent, SessionThread, Vault, VaultCredential } from "@agentos/types";

/**
 * Storage backed by Supabase Postgres (schema `agentos`).
 * Locally this is the Supabase CLI's Postgres; in the cloud, the Supabase project.
 * Every row is scoped to a workspace (`AGENTOS_WORKSPACE`, default `ws_default`).
 */
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

type Json = postgres.JSONValue;
const asJson = (v: unknown) => v as Json;

/** A file row: CMA metadata plus where the bytes live (relative to AGENTOS_HOME). */
export type StoredFile = FileMetadata & { storage_path: string };

export class Store {
  readonly sql: postgres.Sql;

  constructor(
    readonly workspaceId = process.env.AGENTOS_WORKSPACE ?? "ws_default",
    url = DATABASE_URL,
  ) {
    this.sql = postgres(url, { max: 10, onnotice: () => {}, transform: { undefined: null } });
  }

  async init(): Promise<void> {
    await this.sql`insert into agentos.workspaces (id, name) values (${this.workspaceId}, ${this.workspaceId})
                   on conflict (id) do nothing`;
  }

  /* ---------------------------------------------------------------- agents */

  agents = {
    insert: async (agent: Agent): Promise<void> => {
      const { id, version, created_at, updated_at, archived_at, ...spec } = agent;
      await this.sql.begin(async (tx) => {
        await tx`
          insert into agentos.agents (id, workspace_id, latest_version, created_at, updated_at, archived_at)
          values (${id}, ${this.workspaceId}, ${version}, ${created_at}, ${updated_at}, ${archived_at})
          on conflict (id) do update set latest_version = excluded.latest_version, updated_at = excluded.updated_at`;
        await tx`
          insert into agentos.agent_versions (agent_id, version, spec, created_at)
          values (${id}, ${version}, ${tx.json(asJson(spec))}, ${updated_at})`;
      });
    },

    get: async (id: string): Promise<Agent | null> => {
      const rows = await this.sql`
        select a.id, a.created_at, a.archived_at, v.version, v.spec, v.created_at as updated_at
        from agentos.agents a join agentos.agent_versions v on v.agent_id = a.id and v.version = a.latest_version
        where a.id = ${id} and a.workspace_id = ${this.workspaceId}`;
      return rows[0] ? toAgent(rows[0]) : null;
    },

    getVersion: async (id: string, version: number): Promise<Agent | null> => {
      const rows = await this.sql`
        select a.id, a.created_at, a.archived_at, v.version, v.spec, v.created_at as updated_at
        from agentos.agents a join agentos.agent_versions v on v.agent_id = a.id
        where a.id = ${id} and v.version = ${version} and a.workspace_id = ${this.workspaceId}`;
      return rows[0] ? toAgent(rows[0]) : null;
    },

    versions: async (id: string): Promise<Agent[]> => {
      const rows = await this.sql`
        select a.id, a.created_at, a.archived_at, v.version, v.spec, v.created_at as updated_at
        from agentos.agents a join agentos.agent_versions v on v.agent_id = a.id
        where a.id = ${id} and a.workspace_id = ${this.workspaceId}
        order by v.version desc`;
      return rows.map(toAgent);
    },

    list: async ({ includeArchived }: { includeArchived: boolean }): Promise<Agent[]> => {
      const rows = await this.sql`
        select a.id, a.created_at, a.archived_at, v.version, v.spec, v.created_at as updated_at
        from agentos.agents a join agentos.agent_versions v on v.agent_id = a.id and v.version = a.latest_version
        where a.workspace_id = ${this.workspaceId} ${includeArchived ? this.sql`` : this.sql`and a.archived_at is null`}
        order by a.created_at desc`;
      return rows.map(toAgent);
    },

    archive: async (id: string, at: string): Promise<void> => {
      await this.sql`update agentos.agents set archived_at = ${at} where id = ${id} and workspace_id = ${this.workspaceId}`;
    },
  };

  /* ---------------------------------------------------------- environments */

  environments = {
    insert: async (env: Environment): Promise<void> => {
      await this.sql`
        insert into agentos.environments (id, workspace_id, name, description, config, metadata, created_at, updated_at, archived_at)
        values (${env.id}, ${this.workspaceId}, ${env.name}, ${env.description}, ${this.sql.json(asJson(env.config))},
                ${this.sql.json(asJson(env.metadata))}, ${env.created_at}, ${env.updated_at}, ${env.archived_at})`;
    },
    update: async (env: Environment): Promise<void> => {
      await this.sql`
        update agentos.environments set name = ${env.name}, description = ${env.description},
          config = ${this.sql.json(asJson(env.config))}, metadata = ${this.sql.json(asJson(env.metadata))},
          updated_at = ${env.updated_at}, archived_at = ${env.archived_at}
        where id = ${env.id} and workspace_id = ${this.workspaceId}`;
    },
    get: async (id: string): Promise<Environment | null> => {
      const rows = await this.sql`select * from agentos.environments where id = ${id} and workspace_id = ${this.workspaceId}`;
      return rows[0] ? toEnvironment(rows[0]) : null;
    },
    list: async ({ includeArchived }: { includeArchived: boolean }): Promise<Environment[]> => {
      const rows = await this.sql`
        select * from agentos.environments where workspace_id = ${this.workspaceId}
        ${includeArchived ? this.sql`` : this.sql`and archived_at is null`} order by created_at desc`;
      return rows.map(toEnvironment);
    },
    remove: async (id: string): Promise<void> => {
      await this.sql`delete from agentos.environments where id = ${id} and workspace_id = ${this.workspaceId}`;
    },
  };

  /* -------------------------------------------------------------- sessions */

  sessions = {
    insert: async (s: Session): Promise<void> => {
      await this.sql`
        insert into agentos.sessions (id, workspace_id, agent_id, agent_version, environment_id, deployment_id, title, status,
          runs_on, vault_ids, budget_cents, usage, metadata, agent_snapshot, stop_reason, stats, resources, created_at, updated_at, archived_at)
        values (${s.id}, ${this.workspaceId}, ${s.agent.id}, ${s.agent.version}, ${s.environment_id}, ${s.deployment_id}, ${s.title},
          ${s.status}, ${s.runs_on}, ${s.vault_ids}, ${s.budget ? Number(s.budget.max_list_cost.amount) : null},
          ${this.sql.json(asJson(s.usage))}, ${this.sql.json(asJson(s.metadata))}, ${this.sql.json(asJson(s.agent))},
          ${s.stop_reason ? this.sql.json(asJson(s.stop_reason)) : null}, ${this.sql.json(asJson(s.stats))},
          ${this.sql.json(asJson(s.resources))}, ${s.created_at}, ${s.updated_at}, ${s.archived_at})`;
    },
    update: async (s: Session): Promise<void> => {
      await this.sql`
        update agentos.sessions set title = ${s.title}, status = ${s.status},
          budget_cents = ${s.budget ? Number(s.budget.max_list_cost.amount) : null},
          usage = ${this.sql.json(asJson(s.usage))}, metadata = ${this.sql.json(asJson(s.metadata))},
          stop_reason = ${s.stop_reason ? this.sql.json(asJson(s.stop_reason)) : null},
          stats = ${this.sql.json(asJson(s.stats))}, updated_at = ${s.updated_at}, archived_at = ${s.archived_at}
        where id = ${s.id} and workspace_id = ${this.workspaceId}`;
    },
    get: async (id: string): Promise<Session | null> => {
      const rows = await this.sql`select * from agentos.sessions where id = ${id} and workspace_id = ${this.workspaceId}`;
      return rows[0] ? toSession(rows[0]) : null;
    },
    list: async (f: { includeArchived: boolean; agentId?: string }): Promise<Session[]> => {
      const rows = await this.sql`
        select * from agentos.sessions where workspace_id = ${this.workspaceId}
        ${f.includeArchived ? this.sql`` : this.sql`and archived_at is null`}
        ${f.agentId ? this.sql`and agent_id = ${f.agentId}` : this.sql``}
        order by created_at desc limit 500`;
      return rows.map(toSession);
    },
    remove: async (id: string): Promise<void> => {
      await this.sql`delete from agentos.sessions where id = ${id} and workspace_id = ${this.workspaceId}`;
    },
    /** Agent-loop state (trueforge-core snapshot); null when none saved. */
    getRuntimeState: async (id: string): Promise<unknown> => {
      const rows = await this.sql`select runtime_state from agentos.sessions where id = ${id} and workspace_id = ${this.workspaceId}`;
      return rows[0]?.runtime_state ?? null;
    },
    saveRuntimeState: async (id: string, state: unknown): Promise<void> => {
      await this.sql`update agentos.sessions set runtime_state = ${state === null ? null : this.sql.json(asJson(state))}
        where id = ${id} and workspace_id = ${this.workspaceId}`;
    },
    /** Sessions left "running" by a previous process (crash/restart). */
    listRunning: async (): Promise<Session[]> => {
      const rows = await this.sql`select * from agentos.sessions where workspace_id = ${this.workspaceId} and status = 'running'`;
      return rows.map(toSession);
    },
  };

  /* --------------------------------------------------------------- threads */

  threads = {
    insert: async (t: SessionThread): Promise<void> => {
      await this.sql`
        insert into agentos.threads (id, session_id, parent_thread, workflow_run_id, name, agent_snapshot, status, status_detail,
          usage, stats, cost_usd, created_at, updated_at, archived_at)
        values (${t.id}, ${t.session_id}, ${t.parent_thread_id}, ${t.workflow_run_id}, ${t.agent.name}, ${this.sql.json(asJson(t.agent))},
          ${t.status}, ${t.stop_reason ? this.sql.json(asJson(t.stop_reason)) : null}, ${this.sql.json(asJson(t.usage))},
          ${this.sql.json(asJson(t.stats))}, ${Number(t.usage.cost_usd)}, ${t.created_at}, ${t.updated_at}, ${t.archived_at})`;
    },
    update: async (t: SessionThread): Promise<void> => {
      await this.sql`
        update agentos.threads set status = ${t.status}, status_detail = ${t.stop_reason ? this.sql.json(asJson(t.stop_reason)) : null},
          usage = ${this.sql.json(asJson(t.usage))}, stats = ${this.sql.json(asJson(t.stats))}, cost_usd = ${Number(t.usage.cost_usd)},
          updated_at = ${t.updated_at}, archived_at = ${t.archived_at}
        where id = ${t.id}`;
    },
    get: async (sessionId: string, id: string): Promise<SessionThread | null> => {
      const rows = await this.sql`
        select t.* from agentos.threads t join agentos.sessions s on s.id = t.session_id
        where t.id = ${id} and t.session_id = ${sessionId} and s.workspace_id = ${this.workspaceId}`;
      return rows[0] ? toThread(rows[0]) : null;
    },
    list: async (sessionId: string): Promise<SessionThread[]> => {
      const rows = await this.sql`
        select t.* from agentos.threads t join agentos.sessions s on s.id = t.session_id
        where t.session_id = ${sessionId} and s.workspace_id = ${this.workspaceId} order by t.created_at`;
      return rows.map(toThread);
    },
  };

  /* ---------------------------------------------------------------- vaults */

  vaults = {
    insert: async (v: Vault): Promise<void> => {
      await this.sql`
        insert into agentos.vaults (id, workspace_id, name, metadata, created_at, updated_at, archived_at)
        values (${v.id}, ${this.workspaceId}, ${v.display_name}, ${this.sql.json(asJson(v.metadata))}, ${v.created_at}, ${v.updated_at}, ${v.archived_at})`;
    },
    update: async (v: Vault): Promise<void> => {
      await this.sql`
        update agentos.vaults set name = ${v.display_name}, metadata = ${this.sql.json(asJson(v.metadata))},
          updated_at = ${v.updated_at}, archived_at = ${v.archived_at}
        where id = ${v.id} and workspace_id = ${this.workspaceId}`;
    },
    get: async (id: string): Promise<Vault | null> => {
      const rows = await this.sql`select * from agentos.vaults where id = ${id} and workspace_id = ${this.workspaceId}`;
      return rows[0] ? toVault(rows[0]) : null;
    },
    list: async (includeArchived: boolean): Promise<Vault[]> => {
      const rows = await this.sql`
        select * from agentos.vaults where workspace_id = ${this.workspaceId}
        ${includeArchived ? this.sql`` : this.sql`and archived_at is null`} order by created_at desc`;
      return rows.map(toVault);
    },
    remove: async (id: string): Promise<void> => {
      // Secrets first: credentials cascade with the vault, vault.secrets do not.
      await this.sql`
        delete from vault.secrets where id in (
          select c.secret_id from agentos.credentials c join agentos.vaults v on v.id = c.vault_id
          where v.id = ${id} and v.workspace_id = ${this.workspaceId} and c.secret_id is not null)`;
      await this.sql`delete from agentos.vaults where id = ${id} and workspace_id = ${this.workspaceId}`;
    },
  };

  /** Credentials. Secret values go to Supabase Vault; rows keep only the secret's id. */
  credentials = {
    insert: async (c: VaultCredential, secret: string): Promise<void> => {
      await this.sql.begin(async (tx) => {
        const [row] = await tx`select vault.create_secret(${secret}, ${`agentos:${c.id}`}, ${`AgentOS credential ${c.id}`}) as id`;
        await tx`
          insert into agentos.credentials (id, vault_id, name, auth_type, secret_id, config, metadata, created_at, updated_at, archived_at)
          values (${c.id}, ${c.vault_id}, ${c.display_name}, ${c.auth.type}, ${row!.id}, ${tx.json(asJson(c.auth))},
            ${tx.json(asJson(c.metadata))}, ${c.created_at}, ${c.updated_at}, ${c.archived_at})`;
      });
    },
    /** Saves non-secret fields; pass `secret` to rotate the stored value. */
    update: async (c: VaultCredential, secret?: string): Promise<void> => {
      await this.sql.begin(async (tx) => {
        if (secret !== undefined) {
          await tx`select vault.update_secret(secret_id, ${secret}) from agentos.credentials where id = ${c.id} and secret_id is not null`;
        }
        await tx`
          update agentos.credentials set name = ${c.display_name}, config = ${tx.json(asJson(c.auth))},
            metadata = ${tx.json(asJson(c.metadata))}, updated_at = ${c.updated_at}, archived_at = ${c.archived_at}
          where id = ${c.id}`;
      });
    },
    get: async (vaultId: string, id: string): Promise<VaultCredential | null> => {
      const rows = await this.sql`
        select c.* from agentos.credentials c join agentos.vaults v on v.id = c.vault_id
        where c.id = ${id} and c.vault_id = ${vaultId} and v.workspace_id = ${this.workspaceId}`;
      return rows[0] ? toCredential(rows[0]) : null;
    },
    list: async (vaultIds: string[], includeArchived: boolean): Promise<VaultCredential[]> => {
      if (!vaultIds.length) return [];
      const rows = await this.sql`
        select c.* from agentos.credentials c join agentos.vaults v on v.id = c.vault_id
        where c.vault_id = any(${vaultIds}) and v.workspace_id = ${this.workspaceId}
        ${includeArchived ? this.sql`` : this.sql`and c.archived_at is null`}
        order by c.created_at desc`;
      return rows.map(toCredential);
    },
    /** Archiving purges the secret value; the record stays for audit. */
    purgeSecret: async (id: string): Promise<void> => {
      await this.sql`delete from vault.secrets where id = (select secret_id from agentos.credentials where id = ${id})`;
      await this.sql`update agentos.credentials set secret_id = null where id = ${id}`;
    },
    remove: async (id: string): Promise<void> => {
      await this.sql`delete from vault.secrets where id = (select secret_id from agentos.credentials where id = ${id})`;
      await this.sql`delete from agentos.credentials where id = ${id}`;
    },
    /** Decrypted secret, for the runtime only (MCP auth, egress injection). Never sent to clients. */
    secret: async (id: string): Promise<string | null> => {
      const rows = await this.sql`
        select s.decrypted_secret from agentos.credentials c join vault.decrypted_secrets s on s.id = c.secret_id
        where c.id = ${id} and c.archived_at is null`;
      return (rows[0]?.decrypted_secret as string | undefined) ?? null;
    },
    touch: async (id: string): Promise<void> => {
      await this.sql`update agentos.credentials set last_used_at = now() where id = ${id}`;
    },
  };

  /* ----------------------------------------------------------------- files */

  files = {
    insert: async (f: StoredFile): Promise<void> => {
      await this.sql`
        insert into agentos.files (id, workspace_id, filename, mime_type, size_bytes, storage_path, session_id, expires_at, downloadable, created_at)
        values (${f.id}, ${this.workspaceId}, ${f.filename}, ${f.mime_type}, ${f.size_bytes}, ${f.storage_path},
          ${f.scope?.id ?? null}, ${f.expires_at}, ${f.downloadable}, ${f.created_at})`;
    },
    get: async (id: string): Promise<StoredFile | null> => {
      const rows = await this.sql`select * from agentos.files where id = ${id} and workspace_id = ${this.workspaceId}`;
      return rows[0] ? toFile(rows[0]) : null;
    },
    list: async (f: { scopeId?: string; ids?: string[] }): Promise<StoredFile[]> => {
      const rows = await this.sql`
        select * from agentos.files where workspace_id = ${this.workspaceId}
        ${f.scopeId ? this.sql`and session_id = ${f.scopeId}` : this.sql``}
        ${f.ids ? this.sql`and id = any(${f.ids})` : this.sql``}
        order by created_at desc limit 1000`;
      return rows.map(toFile);
    },
    remove: async (id: string): Promise<void> => {
      await this.sql`delete from agentos.files where id = ${id} and workspace_id = ${this.workspaceId}`;
    },
    /** Registers (or refreshes) a session output as a session-scoped file. */
    upsertOutput: async (f: StoredFile): Promise<void> => {
      await this.sql`
        insert into agentos.files (id, workspace_id, filename, mime_type, size_bytes, storage_path, session_id, downloadable, created_at)
        values (${f.id}, ${this.workspaceId}, ${f.filename}, ${f.mime_type}, ${f.size_bytes}, ${f.storage_path}, ${f.scope!.id}, true, ${f.created_at})
        on conflict (session_id, storage_path) where session_id is not null
        do update set size_bytes = excluded.size_bytes`;
    },
  };

  /* ---------------------------------------------------------------- events */

  events = {
    append: async (sessionId: string, event: SessionEvent): Promise<number> => {
      const rows = await this.sql`
        insert into agentos.session_events (id, session_id, seq, thread_id, type, payload, processed_at)
        values (${event.id}, ${sessionId},
          (select coalesce(max(seq), 0) + 1 from agentos.session_events where session_id = ${sessionId}),
          ${(event.session_thread_id as string | null) ?? null}, ${event.type}, ${this.sql.json(asJson(event))}, ${event.processed_at})
        returning seq`;
      return Number(rows[0]!.seq);
    },
    markProcessed: async (sessionId: string, eventId: string, at: string): Promise<void> => {
      await this.sql`
        update agentos.session_events set processed_at = ${at},
          payload = jsonb_set(payload, '{processed_at}', to_jsonb(${at}::text))
        where session_id = ${sessionId} and id = ${eventId}`;
    },
    /** Events of one session thread (stored with its id in thread_id). */
    listThread: async (sessionId: string, threadId: string, afterSeq = 0): Promise<Array<{ seq: number; event: SessionEvent }>> => {
      const rows = await this.sql`
        select seq, payload from agentos.session_events
        where session_id = ${sessionId} and thread_id = ${threadId} and seq > ${afterSeq} order by seq`;
      return rows.map((r) => ({ seq: Number(r.seq), event: r.payload as SessionEvent }));
    },
    list: async (sessionId: string, afterSeq = 0): Promise<Array<{ seq: number; event: SessionEvent }>> => {
      const rows = await this.sql`
        select seq, payload from agentos.session_events where session_id = ${sessionId} and seq > ${afterSeq} order by seq`;
      return rows.map((r) => ({ seq: Number(r.seq), event: r.payload as SessionEvent }));
    },
    get: async (sessionId: string, eventId: string): Promise<SessionEvent | null> => {
      const rows = await this.sql`select payload from agentos.session_events where session_id = ${sessionId} and id = ${eventId}`;
      return (rows[0]?.payload as SessionEvent | undefined) ?? null;
    },
  };
}

/* ------------------------------------------------------------- row mappers */

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

function toAgent(r: postgres.Row): Agent {
  const spec = r.spec as Omit<Agent, "id" | "version" | "created_at" | "updated_at" | "archived_at">;
  return { ...spec, type: "agent", id: r.id, version: r.version, created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)!, archived_at: iso(r.archived_at) };
}

function toEnvironment(r: postgres.Row): Environment {
  return {
    type: "environment",
    id: r.id,
    name: r.name,
    description: r.description,
    config: r.config,
    metadata: r.metadata,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    archived_at: iso(r.archived_at),
  };
}

function toSession(r: postgres.Row): Session {
  return {
    type: "session",
    id: r.id,
    title: r.title,
    status: r.status,
    agent: r.agent_snapshot,
    environment_id: r.environment_id,
    vault_ids: r.vault_ids ?? [],
    budget: r.budget_cents == null ? null : { type: "limit", max_list_cost: { amount: String(r.budget_cents), currency: "USD" } },
    usage: r.usage,
    stats: r.stats,
    resources: r.resources ?? [],
    outcome_evaluations: [],
    metadata: r.metadata,
    deployment_id: r.deployment_id,
    runs_on: r.runs_on,
    stop_reason: r.stop_reason,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    archived_at: iso(r.archived_at),
  };
}

function toFile(r: postgres.Row): StoredFile {
  return {
    type: "file",
    id: r.id,
    filename: r.filename,
    mime_type: r.mime_type ?? "application/octet-stream",
    size_bytes: Number(r.size_bytes),
    created_at: iso(r.created_at)!,
    downloadable: r.downloadable && !(r.expires_at && new Date(r.expires_at).getTime() < Date.now()),
    expires_at: iso(r.expires_at),
    scope: r.session_id ? { type: "session", id: r.session_id } : null,
    storage_path: r.storage_path,
  };
}

/** Strips internal fields before a file goes over the wire. */
export function publicFile({ storage_path: _, ...f }: StoredFile): FileMetadata {
  return f;
}

function toVault(r: postgres.Row): Vault {
  return {
    type: "vault",
    id: r.id,
    display_name: r.name,
    metadata: r.metadata ?? {},
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    archived_at: iso(r.archived_at),
  };
}

function toCredential(r: postgres.Row): VaultCredential {
  return {
    type: "vault_credential",
    id: r.id,
    vault_id: r.vault_id,
    display_name: r.name,
    auth: r.config as CredentialAuth,
    metadata: r.metadata ?? {},
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    archived_at: iso(r.archived_at),
  };
}

function toThread(r: postgres.Row): SessionThread {
  return {
    type: "session_thread",
    id: r.id,
    session_id: r.session_id,
    parent_thread_id: r.parent_thread,
    workflow_run_id: r.workflow_run_id,
    agent: r.agent_snapshot,
    status: r.status,
    stop_reason: r.status_detail ?? null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cost_usd: "0", active_seconds: 0, ...(r.usage ?? {}) },
    stats: r.stats ?? {},
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    archived_at: iso(r.archived_at),
  };
}
