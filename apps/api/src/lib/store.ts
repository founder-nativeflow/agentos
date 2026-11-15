import postgres from "postgres";
import type { BuilderChat, Workflow, WorkflowRun } from "@agentos/types";
import type { Agent, CredentialAuth, Deployment, DeploymentRun, Environment, FileMetadata, Session, SessionEvent, SessionThread, Vault, VaultCredential } from "@agentos/types";

/**
 * Storage backed by Supabase Postgres (schema `agentos`).
 * Locally this is the Supabase CLI's Postgres; in the cloud, the Supabase project.
 * Every row is scoped to a workspace (`AGENTOS_WORKSPACE`, default `ws_default`).
 */
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

type Json = postgres.JSONValue;
const asJson = (v: unknown) => v as Json;

export type WorkspaceRole = "admin" | "developer" | "viewer";

/** A file row: CMA metadata plus where the bytes live (relative to AGENTOS_HOME). */
export type StoredFile = FileMetadata & { storage_path: string };

export class Store {
  readonly sql: postgres.Sql;

  constructor(
    readonly workspaceId = process.env.AGENTOS_WORKSPACE ?? "ws_default",
    url: string | postgres.Sql = DATABASE_URL,
  ) {
    this.sql = typeof url === "string" ? postgres(url, { max: 10, onnotice: () => {}, transform: { undefined: null } }) : url;
  }

  /** The same database, scoped to another workspace (shares the connection pool). */
  scoped(workspaceId: string): Store {
    return workspaceId === this.workspaceId ? this : new Store(workspaceId, this.sql);
  }

  /** Workspace that owns a session (unscoped lookup, for the runtime). */
  async workspaceOfSession(sessionId: string): Promise<string | null> {
    const rows = await this.sql`select workspace_id from agentos.sessions where id = ${sessionId}`;
    return (rows[0]?.workspace_id as string | undefined) ?? null;
  }

  /** Sessions left "running" in any workspace (crash/restart recovery). */
  async runningSessionsAllWorkspaces(): Promise<Array<{ id: string; workspace_id: string }>> {
    const rows = await this.sql`select id, workspace_id from agentos.sessions where status = 'running'`;
    return rows.map((r) => ({ id: r.id as string, workspace_id: r.workspace_id as string }));
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
    countRunning: async (): Promise<number> => {
      const [r] = await this.sql`select count(*)::int as n from agentos.sessions where workspace_id = ${this.workspaceId} and status = 'running' and archived_at is null`;
      return Number(r?.n ?? 0);
    },
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

  /* ------------------------------------------- workspace settings (scoped) */

  workspaceSettings = {
    openRouter: async (): Promise<{ hint: string | null; status: string | null; checked_at: string | null; configured: boolean }> => {
      const rows = await this.sql`
        select openrouter_secret_id, openrouter_hint, openrouter_status, openrouter_checked_at from agentos.workspaces where id = ${this.workspaceId}`;
      const r = rows[0];
      return {
        configured: Boolean(r?.openrouter_secret_id),
        hint: (r?.openrouter_hint as string | null) ?? null,
        status: (r?.openrouter_status as string | null) ?? null,
        checked_at: iso(r?.openrouter_checked_at),
      };
    },
    setOpenRouter: async (key: string, hint: string, status: string): Promise<void> => {
      await this.sql.begin(async (tx) => {
        const [row] = await tx`select openrouter_secret_id from agentos.workspaces where id = ${this.workspaceId} for update`;
        if (row?.openrouter_secret_id) {
          await tx`select vault.update_secret(${row.openrouter_secret_id}, ${key})`;
        } else {
          const [s] = await tx`select vault.create_secret(${key}, ${`agentos:openrouter:${this.workspaceId}`}, 'AgentOS workspace OpenRouter key') as id`;
          await tx`update agentos.workspaces set openrouter_secret_id = ${s!.id} where id = ${this.workspaceId}`;
        }
        await tx`update agentos.workspaces set openrouter_hint = ${hint}, openrouter_status = ${status}, openrouter_checked_at = now() where id = ${this.workspaceId}`;
      });
    },
    setOpenRouterStatus: async (status: string): Promise<void> => {
      await this.sql`update agentos.workspaces set openrouter_status = ${status}, openrouter_checked_at = now() where id = ${this.workspaceId}`;
    },
    clearOpenRouter: async (): Promise<void> => {
      await this.sql`delete from vault.secrets where id = (select openrouter_secret_id from agentos.workspaces where id = ${this.workspaceId})`;
      await this.sql`update agentos.workspaces set openrouter_secret_id = null, openrouter_hint = null, openrouter_status = null, openrouter_checked_at = null where id = ${this.workspaceId}`;
    },
    /** Decrypted key, for model calls only. */
    openRouterKey: async (): Promise<string | null> => {
      const rows = await this.sql`
        select s.decrypted_secret from agentos.workspaces w join vault.decrypted_secrets s on s.id = w.openrouter_secret_id where w.id = ${this.workspaceId}`;
      return (rows[0]?.decrypted_secret as string | undefined) ?? null;
    },
  };

  /* ------------------------------------------------- workspaces (unscoped) */

  workspaces = {
    membershipsOf: async (userId: string): Promise<Array<{ id: string; name: string; role: WorkspaceRole }>> => {
      const rows = await this.sql`
        select w.id, w.name, m.role from agentos.workspace_members m join agentos.workspaces w on w.id = m.workspace_id
        where m.user_id = ${userId} order by w.created_at`;
      return rows.map((r) => ({ id: r.id as string, name: r.name as string, role: r.role as WorkspaceRole }));
    },
    create: async (id: string, name: string, ownerUserId: string): Promise<void> => {
      await this.sql.begin(async (tx) => {
        await tx`insert into agentos.workspaces (id, name) values (${id}, ${name})`;
        await tx`insert into agentos.workspace_members (workspace_id, user_id, role) values (${id}, ${ownerUserId}, 'admin')`;
      });
    },
    members: async (workspaceId: string): Promise<Array<{ user_id: string; role: WorkspaceRole; created_at: string }>> => {
      const rows = await this.sql`select user_id, role, created_at from agentos.workspace_members where workspace_id = ${workspaceId} order by created_at`;
      return rows.map((r) => ({ user_id: r.user_id as string, role: r.role as WorkspaceRole, created_at: iso(r.created_at)! }));
    },
    emails: async (userIds: string[]): Promise<Map<string, string>> => {
      if (!userIds.length) return new Map();
      const rows = await this.sql`select id, email from auth.users where id = any(${userIds}::uuid[])`;
      return new Map(rows.map((r) => [String(r.id), String(r.email ?? "")]));
    },
    setMember: async (workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> => {
      await this.sql`
        insert into agentos.workspace_members (workspace_id, user_id, role) values (${workspaceId}, ${userId}, ${role})
        on conflict (workspace_id, user_id) do update set role = excluded.role`;
    },
    removeMember: async (workspaceId: string, userId: string): Promise<void> => {
      await this.sql`delete from agentos.workspace_members where workspace_id = ${workspaceId} and user_id = ${userId}`;
    },
  };

  /** API keys stored in the database (Supabase Auth mode). Only hashes are stored. */
  apiKeys = {
    insert: async (k: { id: string; name: string; key_hash: string; hint: string; created_by: string | null }): Promise<void> => {
      await this.sql`
        insert into agentos.api_keys (id, workspace_id, name, key_hash, hint, created_by)
        values (${k.id}, ${this.workspaceId}, ${k.name}, ${k.key_hash}, ${k.hint}, ${k.created_by})`;
    },
    list: async (): Promise<Array<{ id: string; name: string; hint: string; created_at: string; last_used_at: string | null }>> => {
      const rows = await this.sql`
        select id, name, hint, created_at, last_used_at from agentos.api_keys
        where workspace_id = ${this.workspaceId} and revoked_at is null order by created_at`;
      return rows.map((r) => ({ id: r.id as string, name: r.name as string, hint: r.hint as string, created_at: iso(r.created_at)!, last_used_at: iso(r.last_used_at) }));
    },
    revoke: async (id: string): Promise<boolean> => {
      const rows = await this.sql`
        update agentos.api_keys set revoked_at = now() where id = ${id} and workspace_id = ${this.workspaceId} and revoked_at is null returning id`;
      return rows.length > 0;
    },
    /** Unscoped: the key decides the workspace. */
    findByHash: async (hash: string): Promise<{ id: string; workspace_id: string; created_by: string | null } | null> => {
      const rows = await this.sql`select id, workspace_id, created_by from agentos.api_keys where key_hash = ${hash} and revoked_at is null`;
      if (!rows[0]) return null;
      void this.sql`update agentos.api_keys set last_used_at = now() where id = ${rows[0].id}`.catch(() => {});
      return { id: rows[0].id as string, workspace_id: rows[0].workspace_id as string, created_by: (rows[0].created_by as string | null) ?? null };
    },
  };

  /* ------------------------------------------------------------- workflows */

  workflows = {
    insert: async (w: Workflow): Promise<void> => {
      const { id, version, created_at, updated_at, archived_at, type: _t, ...spec } = w;
      await this.sql.begin(async (tx) => {
        await tx`
          insert into agentos.workflows (id, workspace_id, latest_version, created_at, updated_at, archived_at)
          values (${id}, ${this.workspaceId}, ${version}, ${created_at}, ${updated_at}, ${archived_at})
          on conflict (id) do update set latest_version = excluded.latest_version, updated_at = excluded.updated_at`;
        await tx`insert into agentos.workflow_versions (workflow_id, version, spec, created_at) values (${id}, ${version}, ${tx.json(asJson(spec))}, ${updated_at})`;
      });
    },
    get: async (id: string, version?: number): Promise<Workflow | null> => {
      const r = version
        ? await this.sql`
            select w.id, w.created_at, w.archived_at, v.version, v.spec, v.created_at as updated_at
            from agentos.workflows w join agentos.workflow_versions v on v.workflow_id = w.id
            where w.id = ${id} and v.version = ${version} and w.workspace_id = ${this.workspaceId}`
        : await this.sql`
            select w.id, w.created_at, w.archived_at, v.version, v.spec, v.created_at as updated_at
            from agentos.workflows w join agentos.workflow_versions v on v.workflow_id = w.id and v.version = w.latest_version
            where w.id = ${id} and w.workspace_id = ${this.workspaceId}`;
      return r[0] ? toWorkflow(r[0]) : null;
    },
    list: async ({ includeArchived }: { includeArchived: boolean }): Promise<Workflow[]> => {
      const rows = await this.sql`
        select w.id, w.created_at, w.archived_at, v.version, v.spec, v.created_at as updated_at
        from agentos.workflows w join agentos.workflow_versions v on v.workflow_id = w.id and v.version = w.latest_version
        where w.workspace_id = ${this.workspaceId} and (${includeArchived} or w.archived_at is null)
        order by w.created_at desc`;
      return rows.map(toWorkflow);
    },
    versions: async (id: string): Promise<Workflow[]> => {
      const rows = await this.sql`
        select w.id, w.created_at, w.archived_at, v.version, v.spec, v.created_at as updated_at
        from agentos.workflows w join agentos.workflow_versions v on v.workflow_id = w.id
        where w.id = ${id} and w.workspace_id = ${this.workspaceId} order by v.version desc`;
      return rows.map(toWorkflow);
    },
    /** Positions only: saved into the current version without making a new one. */
    saveLayout: async (id: string, version: number, nodes: Workflow["nodes"]): Promise<void> => {
      await this.sql`
        update agentos.workflow_versions v set spec = jsonb_set(v.spec, '{nodes}', ${this.sql.json(asJson(nodes))})
        from agentos.workflows w where w.id = v.workflow_id and w.workspace_id = ${this.workspaceId} and v.workflow_id = ${id} and v.version = ${version}`;
    },
    archive: async (id: string, at: string): Promise<void> => {
      await this.sql`update agentos.workflows set archived_at = ${at} where id = ${id} and workspace_id = ${this.workspaceId}`;
    },
  };

  workflowRuns = {
    insert: async (r: WorkflowRun): Promise<void> => {
      await this.sql`
        insert into agentos.workflow_executions (id, workspace_id, workflow_id, workflow_version, status, input, output, error, steps, cost_usd, trigger, created_at, ended_at)
        values (${r.id}, ${this.workspaceId}, ${r.workflow_id}, ${r.workflow_version}, ${r.status}, ${r.input}, ${r.output},
          ${r.error ? this.sql.json(asJson(r.error)) : null}, ${this.sql.json(asJson(r.steps))}, ${r.cost_usd}, ${this.sql.json(asJson(r.trigger))},
          ${r.created_at}, ${r.ended_at})`;
    },
    update: async (r: WorkflowRun): Promise<void> => {
      await this.sql`
        update agentos.workflow_executions set status = ${r.status}, output = ${r.output}, error = ${r.error ? this.sql.json(asJson(r.error)) : null},
          steps = ${this.sql.json(asJson(r.steps))}, cost_usd = ${r.cost_usd}, ended_at = ${r.ended_at}
        where id = ${r.id} and workspace_id = ${this.workspaceId}`;
    },
    get: async (id: string): Promise<WorkflowRun | null> => {
      const rows = await this.sql`select * from agentos.workflow_executions where id = ${id} and workspace_id = ${this.workspaceId}`;
      return rows[0] ? toWorkflowRun(rows[0]) : null;
    },
    list: async (f: { workflowId?: string; limit?: number }): Promise<WorkflowRun[]> => {
      const rows = await this.sql`
        select * from agentos.workflow_executions where workspace_id = ${this.workspaceId}
          and (${f.workflowId ?? null}::text is null or workflow_id = ${f.workflowId ?? null})
        order by created_at desc limit ${f.limit ?? 200}`;
      return rows.map(toWorkflowRun);
    },
    /** Runs left "running" by a previous process (all workspaces). */
    failInterrupted: async (): Promise<number> => {
      const rows = await this.sql`
        update agentos.workflow_executions set status = 'failed', ended_at = now(),
          error = '{"type":"api_error","message":"The API restarted while this run was in progress"}'::jsonb
        where status = 'running' returning id`;
      return rows.length;
    },
  };

  builderChats = {
    upsert: async (b: BuilderChat): Promise<void> => {
      await this.sql`
        insert into agentos.builder_chats (id, workspace_id, title, model, messages, plan, applied, created_at, updated_at)
        values (${b.id}, ${this.workspaceId}, ${b.title}, ${b.model}, ${this.sql.json(asJson(b.messages))}, ${b.plan ? this.sql.json(asJson(b.plan)) : null},
          ${b.applied ? this.sql.json(asJson(b.applied)) : null}, ${b.created_at}, ${b.updated_at})
        on conflict (id) do update set title = excluded.title, model = excluded.model, messages = excluded.messages, plan = excluded.plan,
          applied = excluded.applied, updated_at = excluded.updated_at`;
    },
    get: async (id: string): Promise<BuilderChat | null> => {
      const rows = await this.sql`select * from agentos.builder_chats where id = ${id} and workspace_id = ${this.workspaceId}`;
      return rows[0] ? toBuilderChat(rows[0]) : null;
    },
    list: async (): Promise<BuilderChat[]> => {
      const rows = await this.sql`select * from agentos.builder_chats where workspace_id = ${this.workspaceId} order by updated_at desc limit 100`;
      return rows.map(toBuilderChat);
    },
    delete: async (id: string): Promise<void> => {
      await this.sql`delete from agentos.builder_chats where id = ${id} and workspace_id = ${this.workspaceId}`;
    },
  };

  /* ----------------------------------------------------------- deployments */

  deployments = {
    insert: async (d: Deployment, webhookHash: string | null = null): Promise<void> => {
      await this.sql`
        insert into agentos.deployments (id, workspace_id, name, description, agent_id, agent_version, environment_id, initial_events,
          schedule, session_config, runs_on, status, paused_reason, metadata, webhook_token_hash, created_at, updated_at, archived_at)
        values (${d.id}, ${this.workspaceId}, ${d.name}, ${d.description}, ${d.agent.id}, ${d.agent.version}, ${d.environment_id},
          ${this.sql.json(asJson(d.initial_events))}, ${d.schedule ? this.sql.json(asJson({ type: "cron", expression: d.schedule.expression, timezone: d.schedule.timezone })) : null},
          ${this.sql.json(asJson({ vault_ids: d.vault_ids, resources: d.resources, budget: d.budget }))}, 'cloud', ${d.status},
          ${d.paused_reason ? this.sql.json(asJson(d.paused_reason)) : null}, ${this.sql.json(asJson(d.metadata))}, ${webhookHash},
          ${d.created_at}, ${d.updated_at}, ${d.archived_at})`;
    },
    update: async (d: Deployment): Promise<void> => {
      await this.sql`
        update agentos.deployments set name = ${d.name}, description = ${d.description}, agent_id = ${d.agent.id}, agent_version = ${d.agent.version},
          environment_id = ${d.environment_id}, initial_events = ${this.sql.json(asJson(d.initial_events))},
          schedule = ${d.schedule ? this.sql.json(asJson({ type: "cron", expression: d.schedule.expression, timezone: d.schedule.timezone })) : null},
          session_config = ${this.sql.json(asJson({ vault_ids: d.vault_ids, resources: d.resources, budget: d.budget }))},
          status = ${d.status}, paused_reason = ${d.paused_reason ? this.sql.json(asJson(d.paused_reason)) : null},
          metadata = ${this.sql.json(asJson(d.metadata))}, updated_at = ${d.updated_at}, archived_at = ${d.archived_at}
        where id = ${d.id} and workspace_id = ${this.workspaceId}`;
    },
    setWebhookHash: async (id: string, hash: string | null): Promise<void> => {
      await this.sql`update agentos.deployments set webhook_token_hash = ${hash} where id = ${id} and workspace_id = ${this.workspaceId}`;
    },
    get: async (id: string): Promise<Deployment | null> => {
      const rows = await this.sql`select * from agentos.deployments where id = ${id} and workspace_id = ${this.workspaceId}`;
      return rows[0] ? toDeployment(rows[0]) : null;
    },
    list: async (f: { includeArchived: boolean; agentId?: string; status?: string }): Promise<Deployment[]> => {
      const rows = await this.sql`
        select * from agentos.deployments where workspace_id = ${this.workspaceId}
        ${f.includeArchived ? this.sql`` : this.sql`and archived_at is null`}
        ${f.agentId ? this.sql`and agent_id = ${f.agentId}` : this.sql``}
        ${f.status ? this.sql`and status = ${f.status}` : this.sql``}
        order by created_at desc limit 500`;
      return rows.map(toDeployment);
    },
    /** Unscoped: active scheduled deployments in every workspace (for the scheduler). */
    scheduledAllWorkspaces: async (): Promise<Array<{ deployment: Deployment; workspace_id: string }>> => {
      const rows = await this.sql`
        select * from agentos.deployments where schedule is not null and archived_at is null and status = 'active'`;
      return rows.map((r) => ({ deployment: toDeployment(r), workspace_id: r.workspace_id as string }));
    },
    /** Unscoped: deployment + workspace + webhook hash, for the public webhook endpoint. */
    forWebhook: async (id: string): Promise<{ workspace_id: string; hash: string | null } | null> => {
      const rows = await this.sql`select workspace_id, webhook_token_hash from agentos.deployments where id = ${id}`;
      return rows[0] ? { workspace_id: rows[0].workspace_id as string, hash: (rows[0].webhook_token_hash as string | null) ?? null } : null;
    },
    markScheduledRun: async (id: string, at: string): Promise<void> => {
      await this.sql`update agentos.deployments set last_scheduled_run_at = ${at} where id = ${id}`;
    },
  };

  deploymentRuns = {
    /** Returns false if a run for this (deployment, scheduled_at) already exists. */
    insert: async (r: DeploymentRun): Promise<boolean> => {
      const scheduledAt = r.trigger_context.type === "schedule" ? r.trigger_context.scheduled_at : null;
      const rows = await this.sql`
        insert into agentos.deployment_runs (id, deployment_id, trigger, session_id, error, agent, scheduled_at, created_at)
        values (${r.id}, ${r.deployment_id}, ${this.sql.json(asJson(r.trigger_context))}, ${r.session_id},
          ${r.error ? this.sql.json(asJson(r.error)) : null}, ${this.sql.json(asJson(r.agent))}, ${scheduledAt}, ${r.created_at})
        on conflict do nothing returning id`;
      return rows.length > 0;
    },
    complete: async (id: string, sessionId: string | null, error: DeploymentRun["error"]): Promise<void> => {
      await this.sql`update agentos.deployment_runs set session_id = ${sessionId}, error = ${error ? this.sql.json(asJson(error)) : null} where id = ${id}`;
    },
    get: async (id: string): Promise<DeploymentRun | null> => {
      const rows = await this.sql`
        select r.* from agentos.deployment_runs r join agentos.deployments d on d.id = r.deployment_id
        where r.id = ${id} and d.workspace_id = ${this.workspaceId}`;
      return rows[0] ? toDeploymentRun(rows[0]) : null;
    },
    list: async (f: { deploymentId?: string; hasError?: boolean; triggerType?: string; createdGte?: string; createdLte?: string; createdGt?: string; createdLt?: string }): Promise<DeploymentRun[]> => {
      const rows = await this.sql`
        select r.* from agentos.deployment_runs r join agentos.deployments d on d.id = r.deployment_id
        where d.workspace_id = ${this.workspaceId}
        ${f.deploymentId ? this.sql`and r.deployment_id = ${f.deploymentId}` : this.sql``}
        ${f.hasError === true ? this.sql`and r.error is not null` : f.hasError === false ? this.sql`and r.error is null` : this.sql``}
        ${f.triggerType ? this.sql`and r.trigger->>'type' = ${f.triggerType}` : this.sql``}
        ${f.createdGte ? this.sql`and r.created_at >= ${f.createdGte}` : this.sql``}
        ${f.createdLte ? this.sql`and r.created_at <= ${f.createdLte}` : this.sql``}
        ${f.createdGt ? this.sql`and r.created_at > ${f.createdGt}` : this.sql``}
        ${f.createdLt ? this.sql`and r.created_at < ${f.createdLt}` : this.sql``}
        order by r.created_at desc limit 1000`;
      return rows.map(toDeploymentRun);
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

function toWorkflow(r: postgres.Row): Workflow {
  const spec = r.spec as Omit<Workflow, "type" | "id" | "version" | "created_at" | "updated_at" | "archived_at">;
  return {
    type: "workflow",
    id: r.id,
    version: r.version,
    ...spec,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    archived_at: iso(r.archived_at),
  };
}

function toWorkflowRun(r: postgres.Row): WorkflowRun {
  return {
    type: "workflow_run",
    id: r.id,
    workflow_id: r.workflow_id,
    workflow_version: r.workflow_version,
    status: r.status,
    input: r.input,
    output: r.output ?? null,
    error: r.error ?? null,
    steps: r.steps ?? {},
    cost_usd: Number(r.cost_usd ?? 0).toFixed(6),
    trigger: r.trigger,
    created_at: iso(r.created_at)!,
    ended_at: iso(r.ended_at),
  };
}

function toBuilderChat(r: postgres.Row): BuilderChat {
  return {
    type: "builder_chat",
    id: r.id,
    title: r.title,
    model: r.model,
    messages: r.messages ?? [],
    plan: r.plan ?? null,
    applied: r.applied ?? null,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

function toDeployment(r: postgres.Row): Deployment {
  const cfg = (r.session_config ?? {}) as { vault_ids?: string[]; resources?: Deployment["resources"]; budget?: Deployment["budget"] };
  return {
    type: "deployment",
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    agent: { type: "agent", id: r.agent_id, version: r.agent_version },
    environment_id: r.environment_id,
    vault_ids: cfg.vault_ids ?? [],
    resources: cfg.resources ?? [],
    initial_events: r.initial_events ?? [],
    budget: cfg.budget ?? null,
    schedule: r.schedule ? { ...r.schedule, last_run_at: iso(r.last_scheduled_run_at) } : null,
    status: r.status === "paused" ? "paused" : "active",
    paused_reason: r.paused_reason ?? null,
    metadata: r.metadata ?? {},
    x_webhook: { enabled: Boolean(r.webhook_token_hash) },
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    archived_at: iso(r.archived_at),
  };
}

function toDeploymentRun(r: postgres.Row): DeploymentRun {
  return {
    type: "deployment_run",
    id: r.id,
    deployment_id: r.deployment_id,
    agent: r.agent,
    trigger_context: r.trigger,
    session_id: r.session_id ?? null,
    error: r.error ?? null,
    created_at: iso(r.created_at)!,
  };
}
