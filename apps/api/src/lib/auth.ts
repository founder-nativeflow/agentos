import type { Context, MiddlewareHandler } from "hono";
import { authThrottle, limitRequests } from "./limits.js";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { loadConfig, sha256, verifySession } from "./config.js";
import { ApiError, unauthorized } from "./errors.js";
import { storeScope } from "./scope.js";
import type { WorkspaceRole } from "./store.js";
import { AUTH_MODE, refreshSession, userFromToken, type AuthTokens, type AuthUser } from "./supabase-auth.js";

export const SESSION_COOKIE = "agentos_session";
/** Supabase Auth mode cookies. */
export const ACCESS_COOKIE = "agentos_at";
export const REFRESH_COOKIE = "agentos_rt";
export const WORKSPACE_COOKIE = "agentos_ws";
/** CMA / Anthropic SDK header for choosing a workspace. */
export const WORKSPACE_HEADER = "anthropic-workspace-id";

export interface Actor {
  type: "user" | "api_key";
  id: string;
  role: WorkspaceRole;
  workspace_id: string | null;
  email?: string;
}

/**
 * Cookie flags: always HttpOnly + SameSite=Lax; Secure when served over HTTPS (directly, or
 * behind a proxy with AGENTOS_TRUST_PROXY=1), in production, or with AGENTOS_SECURE_COOKIES=1.
 */
export function cookieOpts(c: Context, maxAge?: number) {
  const https =
    new URL(c.req.url).protocol === "https:" ||
    (process.env.AGENTOS_TRUST_PROXY === "1" && c.req.header("x-forwarded-proto") === "https");
  const secure = https || process.env.NODE_ENV === "production" || process.env.AGENTOS_SECURE_COOKIES === "1";
  return { httpOnly: true, sameSite: "Lax" as const, path: "/", secure, ...(maxAge ? { maxAge } : {}) };
}

export function setAuthCookies(c: Context, t: AuthTokens): void {
  setCookie(c, ACCESS_COOKIE, t.access_token, cookieOpts(c, t.expires_in));
  setCookie(c, REFRESH_COOKIE, t.refresh_token, cookieOpts(c, 60 * 60 * 24 * 30));
}

export function clearAuthCookies(c: Context): void {
  for (const name of [SESSION_COOKIE, ACCESS_COOKIE, REFRESH_COOKIE, WORKSPACE_COOKIE]) deleteCookie(c, name, { path: "/" });
}

/** Paths a signed-in user may use before belonging to any workspace. */
const NO_WORKSPACE_OK = ["/v1/x/auth/", "/v1/x/workspaces"];
const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Accepts, like CMA:
 *  - `x-api-key: <key>` or `Authorization: Bearer <key>` (SDKs, scripts)
 *  - the Console's session cookie
 * Local mode: one admin from `agentos init`, one workspace.
 * Supabase mode: Supabase Auth users, many workspaces with roles; API keys belong to a workspace.
 * Every request then runs with a store scoped to its workspace.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const base = c.get("store");
  authThrottle.check(c);
  if (AUTH_MODE === "local") {
    const cfg = loadConfig();
    if (!cfg) throw new ApiError(403, "permission_error", "AgentOS is not initialised. Run `pnpm agentos init` first.");
    let actor: Actor | null = null;
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie && verifySession(cookie, cfg.session_secret)) {
      actor = { type: "user", id: "admin", role: "admin", workspace_id: base.workspaceId };
    } else {
      const key = c.req.header("x-api-key") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
      const hit = key ? cfg.api_keys.find((k) => k.key_hash === sha256(key)) : undefined;
      if (hit) actor = { type: "api_key", id: hit.id, role: "admin", workspace_id: base.workspaceId };
    }
    if (!actor) {
      authThrottle.failed(c);
      throw unauthorized();
    }
    limitRequests(`${actor.type}:${actor.id}`);
    c.set("actor", actor);
    return storeScope.run(base, () => next());
  }

  // ---------------------------------------------------------------- Supabase Auth mode
  let user: AuthUser | null = null;
  let keyWorkspace: string | null = null;
  let keyId: string | null = null;

  const access = getCookie(c, ACCESS_COOKIE);
  if (access) user = await userFromToken(access);
  if (!user) {
    const refresh = getCookie(c, REFRESH_COOKIE);
    if (refresh) {
      try {
        const t = await refreshSession(refresh);
        setAuthCookies(c, t);
        user = t.user;
      } catch {
        /* expired: fall through to other credentials */
      }
    }
  }
  if (!user) {
    const key = c.req.header("x-api-key") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (key?.startsWith("aos-")) {
      const hit = await base.apiKeys.findByHash(sha256(key));
      if (hit) {
        keyWorkspace = hit.workspace_id;
        keyId = hit.id;
      }
    } else if (key && key.split(".").length === 3) {
      user = await userFromToken(key); // a Supabase access token used directly
    }
  }
  if (!user && !keyId) {
    authThrottle.failed(c);
    throw unauthorized();
  }

  const requested = c.req.header(WORKSPACE_HEADER) ?? getCookie(c, WORKSPACE_COOKIE) ?? null;
  let actor: Actor;
  if (keyId) {
    if (c.req.header(WORKSPACE_HEADER) && c.req.header(WORKSPACE_HEADER) !== keyWorkspace) {
      throw new ApiError(403, "permission_error", "This API key belongs to a different workspace");
    }
    actor = { type: "api_key", id: keyId, role: "developer", workspace_id: keyWorkspace };
  } else {
    const memberships = await base.workspaces.membershipsOf(user!.id);
    const chosen = requested ? memberships.find((m) => m.id === requested) : memberships[0];
    if (requested && !chosen && c.req.header(WORKSPACE_HEADER)) {
      throw new ApiError(403, "permission_error", `You are not a member of workspace ${requested}`);
    }
    const m = chosen ?? memberships[0];
    actor = { type: "user", id: user!.id, email: user!.email, role: m?.role ?? "viewer", workspace_id: m?.id ?? null };
  }

  const path = c.req.path;
  if (!actor.workspace_id && !NO_WORKSPACE_OK.some((p) => path.startsWith(p))) {
    throw new ApiError(403, "permission_error", "Create or join a workspace first");
  }
  if (actor.role === "viewer" && !READ_ONLY.has(c.req.method) && !path.startsWith("/v1/x/auth/") && !path.startsWith("/v1/x/workspaces")) {
    throw new ApiError(403, "permission_error", "Viewers have read-only access to this workspace");
  }
  limitRequests(`${actor.type}:${actor.id}`);
  c.set("actor", actor);
  const scoped = actor.workspace_id ? base.scoped(actor.workspace_id) : base;
  c.set("store", scoped);
  return storeScope.run(scoped, () => next());
};

/** Requires the workspace admin role (members, keys management in Supabase mode). */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  if (c.get("actor").role !== "admin") throw new ApiError(403, "permission_error", "Only workspace admins can do this");
  return next();
};
