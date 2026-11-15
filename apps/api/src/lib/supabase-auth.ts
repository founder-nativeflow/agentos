import { createHash } from "node:crypto";
import { ApiError, unauthorized } from "./errors.js";

/**
 * Supabase Auth (GoTrue) for hosted / team deployments: AGENTOS_AUTH=supabase.
 * Local mode keeps the single admin from `agentos init`.
 *
 * Needs SUPABASE_URL and SUPABASE_ANON_KEY; adding members by email also needs
 * SUPABASE_SERVICE_ROLE_KEY. Talks to the GoTrue REST API directly (no SDK).
 */

export type AuthMode = "local" | "supabase";
export const AUTH_MODE: AuthMode = process.env.AGENTOS_AUTH === "supabase" ? "supabase" : "local";

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: AuthUser;
}

function cfg() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new ApiError(500, "api_error", "Supabase Auth is not configured (SUPABASE_URL / SUPABASE_ANON_KEY)");
  return { url, anon, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

async function gotrue<T>(path: string, init: { method?: string; body?: unknown; token?: string; service?: boolean } = {}): Promise<T> {
  const { url, anon, service } = cfg();
  const key = init.service ? service : anon;
  if (init.service && !service) throw new ApiError(500, "api_error", "SUPABASE_SERVICE_ROLE_KEY is required for this operation");
  const res = await fetch(`${url}/auth/v1${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      apikey: key!,
      "content-type": "application/json",
      authorization: `Bearer ${init.token ?? key}`,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(body.msg ?? body.error_description ?? body.message ?? body.error ?? `Auth error ${res.status}`);
    if (res.status === 400 || res.status === 401 || res.status === 403) throw unauthorized(msg);
    if (res.status === 422) throw new ApiError(400, "invalid_request_error", msg);
    throw new ApiError(502, "api_error", `Supabase Auth: ${msg}`);
  }
  return body as T;
}

const toUser = (u: { id: string; email?: string }): AuthUser => ({ id: u.id, email: u.email ?? "" });

export async function signInWithPassword(email: string, password: string): Promise<AuthTokens> {
  const r = await gotrue<AuthTokens & { user: { id: string; email?: string } }>("/token?grant_type=password", { body: { email, password } });
  return { ...r, user: toUser(r.user) };
}

export async function refreshSession(refreshToken: string): Promise<AuthTokens> {
  const r = await gotrue<AuthTokens & { user: { id: string; email?: string } }>("/token?grant_type=refresh_token", { body: { refresh_token: refreshToken } });
  return { ...r, user: toUser(r.user) };
}

/** Self-serve sign-up. Returns tokens when the project doesn't require email confirmation. */
export async function signUp(email: string, password: string): Promise<{ user: AuthUser; tokens: AuthTokens | null }> {
  const r = await gotrue<Record<string, unknown>>("/signup", { body: { email, password } });
  if (r.access_token) {
    const t = r as unknown as AuthTokens & { user: { id: string; email?: string } };
    return { user: toUser(t.user), tokens: { ...t, user: toUser(t.user) } };
  }
  const u = (r.user ?? r) as { id: string; email?: string };
  return { user: toUser(u), tokens: null };
}

export async function signOut(accessToken: string): Promise<void> {
  await gotrue("/logout", { method: "POST", token: accessToken, body: {} }).catch(() => {});
}

/** Verified user for an access token (cached briefly to avoid a round trip per request). */
const cache = new Map<string, { user: AuthUser; until: number }>();
export async function userFromToken(accessToken: string): Promise<AuthUser | null> {
  const key = createHash("sha256").update(accessToken).digest("hex");
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.user;
  try {
    const u = await gotrue<{ id: string; email?: string }>("/user", { token: accessToken });
    const user = toUser(u);
    cache.set(key, { user, until: Date.now() + 30_000 });
    if (cache.size > 5000) cache.clear();
    return user;
  } catch {
    cache.delete(key);
    return null;
  }
}

/** Finds a user by email (service role), for adding workspace members. */
export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const r = await gotrue<{ users: Array<{ id: string; email?: string }> }>(`/admin/users?page=${page}&per_page=200`, { service: true });
    const u = r.users.find((x) => (x.email ?? "").toLowerCase() === target);
    if (u) return toUser(u);
    if (r.users.length < 200) return null;
  }
  return null;
}
