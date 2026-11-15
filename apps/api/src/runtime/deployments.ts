import { CronExpressionParser } from "cron-parser";
import type { Deployment, DeploymentRun, DeploymentTrigger, InboundEvent } from "@agentos/types";
import { badRequest } from "../lib/errors.js";
import { newId, nowIso } from "../lib/ids.js";
import { storeScope } from "../lib/scope.js";
import type { Store } from "../lib/store.js";
import type { SessionRuntime } from "./runner.js";
import { createSession, SessionSetupError } from "./session-service.js";

/* ------------------------------------------------------------------ cron */

/** CMA rules: 5-field POSIX cron, no seconds/year, no L W # ?, no @shortcuts; IANA timezone. */
export function validateSchedule(expression: string, timezone: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw badRequest("schedule.expression must have exactly 5 fields: minute hour day-of-month month day-of-week");
  if (/[LW#?@]/i.test(expression.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|sun|mon|tue|wed|thu|fri|sat)\b/gi, ""))) {
    throw badRequest("schedule.expression: L, W, #, ? and @ shortcuts are not supported");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw badRequest(`schedule.timezone is not a valid IANA timezone: ${timezone}`);
  }
  try {
    CronExpressionParser.parse(expression, { tz: timezone });
  } catch (err) {
    throw badRequest(`schedule.expression is invalid: ${(err as Error).message}`);
  }
}

/** Next `count` occurrences after `from`. */
export function upcomingRuns(expression: string, timezone: string, count = 5, from = new Date()): string[] {
  const it = CronExpressionParser.parse(expression, { currentDate: from, tz: timezone });
  return Array.from({ length: count }, () => it.next().toDate().toISOString());
}

/** The most recent occurrence at or before `now`. */
export function lastOccurrence(expression: string, timezone: string, now = new Date()): Date {
  const it = CronExpressionParser.parse(expression, { currentDate: new Date(now.getTime() + 1000), tz: timezone });
  return it.prev().toDate();
}

/** API view: adds upcoming_runs_at (empty once archived). */
export function deploymentView(d: Deployment): Deployment {
  if (!d.schedule) return d;
  return {
    ...d,
    schedule: { ...d.schedule, upcoming_runs_at: d.archived_at ? [] : upcomingRuns(d.schedule.expression, d.schedule.timezone) },
  };
}

/* ------------------------------------------------------------------ runs */

/** Errors about what the deployment refers to pause it, as in CMA; transient ones don't. */
const PAUSING = new Set([
  "agent_archived_error", "agent_not_found_error", "environment_archived_error", "environment_not_found_error",
  "vault_not_found_error", "vault_archived_error", "file_not_found_error",
]);

function triggerText(t: DeploymentTrigger): string {
  return t.type === "schedule" ? "scheduled" : t.type === "webhook" ? "webhook" : "manual";
}

/**
 * Runs a deployment once: records a run, creates a session with the pinned agent version
 * and the deployment's settings, and records the session or the error. Returns null when
 * a scheduled run for that time already exists (another replica took it).
 */
export async function runDeployment(
  store: Store,
  runtime: SessionRuntime,
  d: Deployment,
  trigger: DeploymentTrigger,
  extraEvents: InboundEvent[] = [],
): Promise<DeploymentRun | null> {
  const run: DeploymentRun = {
    type: "deployment_run",
    id: newId("deploymentRun"),
    deployment_id: d.id,
    agent: d.agent,
    trigger_context: trigger,
    session_id: null,
    error: null,
    created_at: nowIso(),
  };
  if (!(await store.deploymentRuns.insert(run))) return null;
  try {
    const session = await createSession(store, runtime, {
      agent: d.agent,
      environment_id: d.environment_id,
      title: `${d.name} · ${triggerText(trigger)} run`,
      vault_ids: d.vault_ids,
      resources: d.resources,
      budget: d.budget,
      metadata: { ...d.metadata, deployment_id: d.id, deployment_run_id: run.id },
      initial_events: [...(d.initial_events as InboundEvent[]), ...extraEvents],
      deployment_id: d.id,
    });
    run.session_id = session.id;
  } catch (err) {
    run.error = err instanceof SessionSetupError
      ? { type: err.setupType, message: err.message }
      : { type: "unknown_error", message: (err as Error).message };
    if (err instanceof SessionSetupError && PAUSING.has(err.setupType)) {
      d.status = "paused";
      d.paused_reason = { type: "error", error: { type: err.setupType, message: err.message } };
      d.updated_at = nowIso();
      await store.deployments.update(d);
    }
  }
  await store.deploymentRuns.complete(run.id, run.session_id, run.error);
  return run;
}

/* ------------------------------------------------------------- scheduler */

/** Runs older than this are skipped rather than started late (e.g. after downtime). */
const MISFIRE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Fires cron deployments in every workspace. Safe with several API replicas: a unique
 * (deployment_id, scheduled_at) index lets exactly one replica record each occurrence.
 */
export function startScheduler(base: Store, runtime: SessionRuntime): () => void {
  if (process.env.AGENTOS_SCHEDULER === "off") return () => {};
  const intervalMs = Number(process.env.AGENTOS_SCHEDULER_INTERVAL_MS ?? 15_000);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = new Date();
      for (const { deployment: d, workspace_id } of await base.deployments.scheduledAllWorkspaces()) {
        try {
          const at = lastOccurrence(d.schedule!.expression, d.schedule!.timezone, now);
          const since = Math.max(new Date(d.updated_at).getTime(), new Date(d.created_at).getTime());
          const last = d.schedule!.last_run_at ? new Date(d.schedule!.last_run_at).getTime() : 0;
          if (at.getTime() < since || at.getTime() <= last || now.getTime() - at.getTime() > MISFIRE_WINDOW_MS) continue;
          const scoped = base.scoped(workspace_id);
          await storeScope.run(scoped, async () => {
            const run = await runDeployment(scoped, runtime, d, { type: "schedule", scheduled_at: at.toISOString() });
            if (run) await scoped.deployments.markScheduledRun(d.id, at.toISOString());
          });
        } catch (err) {
          console.error(`[scheduler] deployment ${d.id}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.error(`[scheduler] ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
