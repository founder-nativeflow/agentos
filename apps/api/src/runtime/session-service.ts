import type { Budget, InboundEvent, Metadata, Session, SessionResource } from "@agentos/types";
import { assertCanStartTurn } from "../lib/limits.js";
import { ApiError } from "../lib/errors.js";
import { newId, nowIso } from "../lib/ids.js";
import type { Store } from "../lib/store.js";
import type { SessionRuntime } from "./runner.js";
import { SANDBOX_PROVIDER } from "./sandbox.js";

/**
 * A problem with what a session refers to (archived agent, missing vault, …).
 * `setupType` is the CMA deployment-run error type, so deployment runs can record it.
 */
export class SessionSetupError extends ApiError {
  constructor(
    status: 400 | 404 | 409,
    readonly setupType: string,
    message: string,
  ) {
    super(status, status === 404 ? "not_found_error" : "invalid_request_error", message);
  }
}

export interface CreateSessionInput {
  agent: string | { type: "agent"; id: string; version?: number };
  environment_id: string;
  title?: string | null;
  vault_ids?: string[];
  budget?: Budget | null;
  metadata?: Metadata;
  resources?: Array<{ type: "file"; file_id: string; mount_path?: string | null }>;
  initial_events?: InboundEvent[];
  deployment_id?: string | null;
}

/**
 * Creates a session exactly as POST /v1/sessions does; used by the API, deployment runs
 * (manual, schedule) and webhooks.
 */
export async function createSession(store: Store, runtime: SessionRuntime, input: CreateSessionInput): Promise<Session> {
  const vaultIds = [...new Set(input.vault_ids ?? [])];
  for (const vid of vaultIds) {
    const v = await store.vaults.get(vid);
    if (!v) throw new SessionSetupError(404, "vault_not_found_error", `Vault ${vid} was not found`);
    if (v.archived_at) throw new SessionSetupError(409, "vault_archived_error", `Vault ${vid} is archived`);
  }

  const ref = typeof input.agent === "string" ? { id: input.agent } : input.agent;
  const agent = "version" in ref && ref.version ? await store.agents.getVersion(ref.id, ref.version) : await store.agents.get(ref.id);
  if (!agent) throw new SessionSetupError(404, "agent_not_found_error", `Agent ${ref.id}${"version" in ref && ref.version ? ` version ${ref.version}` : ""} was not found`);
  if (agent.archived_at) throw new SessionSetupError(409, "agent_archived_error", "Archived agents can't start new sessions");
  const env = await store.environments.get(input.environment_id);
  if (!env) throw new SessionSetupError(404, "environment_not_found_error", `Environment ${input.environment_id} was not found`);
  if (env.archived_at) throw new SessionSetupError(409, "environment_archived_error", "Archived environments can't start new sessions");

  const now = nowIso();
  const resources: SessionResource[] = [];
  for (const res of input.resources ?? []) {
    const file = await store.files.get(res.file_id);
    if (!file) throw new SessionSetupError(404, "file_not_found_error", `File ${res.file_id} was not found`);
    if (!file.downloadable) throw new SessionSetupError(400, "file_not_found_error", `File ${file.id} has expired`);
    const mount = res.mount_path ?? `/mnt/session/uploads/${file.id}`;
    if (!mount.startsWith("/") || mount.split("/").includes("..") || mount.startsWith("/mnt/session/outputs")) {
      throw new SessionSetupError(400, "session_creation_rejected_error", `Invalid mount_path: ${mount}`);
    }
    if (resources.some((r) => r.mount_path === mount)) {
      throw new SessionSetupError(400, "session_creation_rejected_error", `Two files share mount_path ${mount}`);
    }
    resources.push({ id: newId("resource"), type: "file", file_id: file.id, mount_path: mount, created_at: now, updated_at: now });
  }

  const session: Session = {
    type: "session",
    id: newId("session"),
    title: input.title ?? null,
    status: "idle",
    agent,
    environment_id: env.id,
    vault_ids: vaultIds,
    budget: input.budget ?? null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: "0", active_seconds: 0 },
    stats: { active_seconds: 0, duration_seconds: 0 },
    resources,
    outcome_evaluations: [],
    metadata: input.metadata ?? {},
    deployment_id: input.deployment_id ?? null,
    runs_on: SANDBOX_PROVIDER === "e2b" ? "cloud" : "local",
    stop_reason: null,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  if (input.initial_events?.some((e) => e.type === "user.message")) await assertCanStartTurn(store, "idle");
  await store.sessions.insert(session);
  if (input.initial_events?.length) await runtime.receive(session, input.initial_events);
  return session;
}
