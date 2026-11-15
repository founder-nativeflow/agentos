import type { Context } from "hono";
import { ApiError } from "./errors.js";
import type { Store } from "./store.js";
import { AUTH_MODE } from "./supabase-auth.js";

/**
 * Rate limits and quotas. In memory, per API process (one process per deployment today; a
 * shared store such as Redis is the upgrade path when the API runs on several replicas).
 * Every limit is an env var; 0 turns it off. Defaults are on in cloud (Supabase) mode and
 * relaxed in local mode, where the only user is the machine's owner.
 */
const cloud = AUTH_MODE === "supabase";
const num = (name: string, cloudDefault: number, localDefault: number) => {
  const v = process.env[name];
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : cloud ? cloudDefault : localDefault;
};
export const LIMITS = {
  /** Requests per minute per API key / user. */
  requestsPerMinute: num("AGENTOS_RATE_LIMIT_RPM", 600, 0),
  /** Webhook calls per minute per client IP. */
  webhooksPerMinute: num("AGENTOS_WEBHOOK_RPM", 60, 0),
  /** Failed sign-ins per 15 minutes, per account and per client IP. */
  loginFailures: num("AGENTOS_LOGIN_MAX_FAILURES", 10, 10),
  /** Failed API-key / token checks per 15 minutes per client IP. */
  authFailures: num("AGENTOS_AUTH_MAX_FAILURES", 100, 0),
  /** Sessions running at the same time, per workspace. */
  runningSessions: num("AGENTOS_MAX_RUNNING_SESSIONS", 10, 0),
};

export class RateLimitError extends ApiError {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(429, "rate_limit_error", message);
  }
}

/** Fixed-window counters. */
class Counter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  constructor(private windowMs: number) {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }, Math.min(windowMs, 60_000)).unref();
  }
  private entry(key: string) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { n: 0, resetAt: now + this.windowMs };
      this.hits.set(key, e);
    }
    return e;
  }
  /** Counts a hit; returns seconds to wait when over `max`, else 0. */
  hit(key: string, max: number): number {
    const e = this.entry(key);
    e.n++;
    return e.n > max ? Math.ceil((e.resetAt - Date.now()) / 1000) : 0;
  }
  /** Seconds to wait if `key` is already at `max`, without counting. */
  blocked(key: string, max: number): number {
    const e = this.hits.get(key);
    return e && e.resetAt > Date.now() && e.n >= max ? Math.ceil((e.resetAt - Date.now()) / 1000) : 0;
  }
  reset(key: string) {
    this.hits.delete(key);
  }
}

const perMinute = new Counter(60_000);
const perQuarterHour = new Counter(15 * 60_000);

/** Client IP: the socket address, or the first X-Forwarded-For hop when AGENTOS_TRUST_PROXY=1. */
export function clientIp(c: Context): string {
  if (process.env.AGENTOS_TRUST_PROXY === "1") {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

export function limitRequests(actorKey: string) {
  if (!LIMITS.requestsPerMinute) return;
  const wait = perMinute.hit(`req:${actorKey}`, LIMITS.requestsPerMinute);
  if (wait) throw new RateLimitError(`Rate limit: at most ${LIMITS.requestsPerMinute} requests per minute. Retry in ${wait}s.`, wait);
}

export function limitWebhook(c: Context) {
  if (!LIMITS.webhooksPerMinute) return;
  const wait = perMinute.hit(`hook:${clientIp(c)}`, LIMITS.webhooksPerMinute);
  if (wait) throw new RateLimitError(`Too many webhook calls. Retry in ${wait}s.`, wait);
}

/** Sign-in throttling: call `check` before verifying a password, `failed`/`succeeded` after. */
export const loginThrottle = {
  check(c: Context, account: string) {
    if (!LIMITS.loginFailures) return;
    const wait = Math.max(
      perQuarterHour.blocked(`login:acct:${account.toLowerCase()}`, LIMITS.loginFailures),
      perQuarterHour.blocked(`login:ip:${clientIp(c)}`, LIMITS.loginFailures),
    );
    if (wait) throw new RateLimitError(`Too many failed sign-in attempts. Try again in ${Math.ceil(wait / 60)} min.`, wait);
  },
  failed(c: Context, account: string) {
    perQuarterHour.hit(`login:acct:${account.toLowerCase()}`, Infinity);
    perQuarterHour.hit(`login:ip:${clientIp(c)}`, Infinity);
  },
  succeeded(account: string) {
    perQuarterHour.reset(`login:acct:${account.toLowerCase()}`);
  },
};

/** Failed credential checks (bad API keys) per IP. */
export const authThrottle = {
  check(c: Context) {
    if (!LIMITS.authFailures) return;
    const wait = perQuarterHour.blocked(`auth:ip:${clientIp(c)}`, LIMITS.authFailures);
    if (wait) throw new RateLimitError(`Too many failed authentication attempts. Retry in ${Math.ceil(wait / 60)} min.`, wait);
  },
  failed(c: Context) {
    if (LIMITS.authFailures) perQuarterHour.hit(`auth:ip:${clientIp(c)}`, Infinity);
  },
};

/** Throws when starting one more session turn would exceed the workspace's running-session quota. */
export async function assertCanStartTurn(store: Store, sessionStatus: string) {
  if (!LIMITS.runningSessions || sessionStatus === "running") return;
  const running = await store.sessions.countRunning();
  if (running >= LIMITS.runningSessions) {
    throw new RateLimitError(
      `This workspace already has ${running} sessions running (limit ${LIMITS.runningSessions}). Wait for one to go idle, or interrupt one.`,
      10,
    );
  }
}
