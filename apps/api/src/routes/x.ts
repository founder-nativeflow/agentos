import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { ProviderSettings } from "@agentos/types";
import { loadConfig, newApiKey, saveConfig, signSession, verifyPassword } from "../lib/config.js";
import {
  ACCESS_COOKIE, clearAuthCookies, requireAdmin, requireAuth, SESSION_COOKIE, setAuthCookies, WORKSPACE_COOKIE,
} from "../lib/auth.js";
import { ApiError, badRequest, conflict, notFound, unauthorized } from "../lib/errors.js";
import { checkKey, keyHint, listModels } from "../lib/openrouter.js";
import { newId, nowIso } from "../lib/ids.js";
void nowIso;
import { AUTH_MODE, findUserByEmail, signInWithPassword, signOut, signUp } from "../lib/supabase-auth.js";

/** AgentOS-only endpoints, kept under /v1/x so the CMA surface stays clean. */
export const x = new Hono();

/* ------------------------------------------------ Auth (local admin or Supabase Auth) */

/** Public: tells the Console which sign-in to show. */
x.get("/auth/mode", (c) =>
  c.json({ mode: AUTH_MODE, signup: AUTH_MODE === "supabase" && process.env.AGENTOS_SIGNUP !== "off" }),
);

x.post("/auth/login", async (c) => {
  const body = z.object({ username: z.string().optional(), email: z.string().optional(), password: z.string() }).parse(await c.req.json());
  if (AUTH_MODE === "supabase") {
    const email = (body.email ?? body.username ?? "").trim();
    if (!email) throw badRequest("Enter your email");
    const t = await signInWithPassword(email, body.password).catch(() => {
      throw unauthorized("Incorrect email or password");
    });
    setAuthCookies(c, t);
    return c.json({ email: t.user.email });
  }
  const cfg = loadConfig();
  if (!cfg) throw new ApiError(403, "permission_error", "AgentOS is not initialised. Run `pnpm agentos init` first.");
  const username = body.username ?? "";
  if (username !== cfg.admin.username || !verifyPassword(body.password, cfg.admin.salt, cfg.admin.password_hash)) {
    throw unauthorized("Incorrect username or password");
  }
  setCookie(c, SESSION_COOKIE, signSession(username, cfg.session_secret), { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 12 });
  return c.json({ username });
});

/** Supabase mode: self-serve sign-up; creates the user's first workspace (they become its admin). */
x.post("/auth/signup", async (c) => {
  if (AUTH_MODE !== "supabase" || process.env.AGENTOS_SIGNUP === "off") throw notFound("Endpoint", "/v1/x/auth/signup");
  const body = z
    .object({ email: z.string().email(), password: z.string().min(10, "Use at least 10 characters"), workspace_name: z.string().min(1).max(100).optional() })
    .parse(await c.req.json());
  const { user, tokens } = await signUp(body.email, body.password);
  const store = c.get("store");
  const wsId = newId("workspace");
  await store.workspaces.create(wsId, body.workspace_name ?? `${body.email.split("@")[0]}'s workspace`, user.id);
  if (tokens) {
    setAuthCookies(c, tokens);
    setCookie(c, WORKSPACE_COOKIE, wsId, { httpOnly: true, sameSite: "Lax", path: "/" });
  }
  return c.json({ email: user.email, workspace_id: wsId, needs_confirmation: !tokens }, tokens ? 200 : 202);
});

x.post("/auth/logout", async (c) => {
  const at = getCookie(c, ACCESS_COOKIE);
  if (AUTH_MODE === "supabase" && at) await signOut(at);
  clearAuthCookies(c);
  return c.json({ ok: true });
});

x.get("/auth/me", requireAuth, async (c) => {
  const actor = c.get("actor");
  if (AUTH_MODE === "local") {
    return c.json({ mode: AUTH_MODE, actor, username: loadConfig()?.admin.username, workspace: { id: actor.workspace_id, name: "Default workspace", role: "admin" }, workspaces: [] });
  }
  const workspaces = actor.type === "user" ? await c.get("store").workspaces.membershipsOf(actor.id) : [];
  const current = workspaces.find((w) => w.id === actor.workspace_id) ?? (actor.workspace_id ? { id: actor.workspace_id, name: actor.workspace_id, role: actor.role } : null);
  return c.json({ mode: AUTH_MODE, actor, username: actor.email ?? actor.id, workspace: current, workspaces });
});

/* ------------------------------------------------ Workspaces + members (Supabase mode) */

const supabaseOnly = async (_c: unknown, next: () => Promise<void>) => {
  if (AUTH_MODE !== "supabase") throw badRequest("Workspaces are managed with Supabase Auth (AGENTOS_AUTH=supabase); local mode has one workspace");
  return next();
};
const roleSchema = z.enum(["admin", "developer", "viewer"]);

x.get("/workspaces", requireAuth, supabaseOnly, async (c) => {
  const actor = c.get("actor");
  return c.json({ data: actor.type === "user" ? await c.get("store").workspaces.membershipsOf(actor.id) : [] });
});

x.post("/workspaces", requireAuth, supabaseOnly, async (c) => {
  const actor = c.get("actor");
  if (actor.type !== "user") throw new ApiError(403, "permission_error", "Sign in as a user to create workspaces");
  const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(await c.req.json());
  const id = newId("workspace");
  await c.get("store").workspaces.create(id, name, actor.id);
  setCookie(c, WORKSPACE_COOKIE, id, { httpOnly: true, sameSite: "Lax", path: "/" });
  return c.json({ id, name, role: "admin" });
});

x.post("/workspaces/:id/select", requireAuth, supabaseOnly, async (c) => {
  const actor = c.get("actor");
  const id = c.req.param("id");
  const mine = actor.type === "user" ? await c.get("store").workspaces.membershipsOf(actor.id) : [];
  const ws = mine.find((w) => w.id === id);
  if (!ws) throw notFound("Workspace", id);
  setCookie(c, WORKSPACE_COOKIE, id, { httpOnly: true, sameSite: "Lax", path: "/" });
  return c.json(ws);
});

x.get("/workspace/members", requireAuth, supabaseOnly, async (c) => {
  const store = c.get("store");
  const ws = c.get("actor").workspace_id!;
  const members = await store.workspaces.members(ws);
  const emails = await store.workspaces.emails(members.map((m) => m.user_id));
  return c.json({ data: members.map((m) => ({ ...m, email: emails.get(m.user_id) ?? "" })) });
});

x.post("/workspace/members", requireAuth, supabaseOnly, requireAdmin, async (c) => {
  const { email, role } = z.object({ email: z.string().email(), role: roleSchema }).parse(await c.req.json());
  const user = await findUserByEmail(email);
  if (!user) throw notFound("User with email", email);
  await c.get("store").workspaces.setMember(c.get("actor").workspace_id!, user.id, role);
  return c.json({ user_id: user.id, email: user.email, role });
});

/** Keeps at least one admin in every workspace. */
async function assertKeepsAdmin(store: ReturnType<typeof getStoreOf>, ws: string, userId: string, newRole: string | null) {
  const members = await store.workspaces.members(ws);
  const admins = members.filter((m) => m.role === "admin" && m.user_id !== userId);
  const target = members.find((m) => m.user_id === userId);
  if (!target) throw notFound("Member", userId);
  if (target.role === "admin" && newRole !== "admin" && admins.length === 0) throw conflict("A workspace needs at least one admin");
}
const getStoreOf = (c: { get: (k: "store") => import("../lib/store.js").Store }) => c.get("store");

x.post("/workspace/members/:userId", requireAuth, supabaseOnly, requireAdmin, async (c) => {
  const { role } = z.object({ role: roleSchema }).parse(await c.req.json());
  const ws = c.get("actor").workspace_id!;
  await assertKeepsAdmin(getStoreOf(c), ws, c.req.param("userId"), role);
  await c.get("store").workspaces.setMember(ws, c.req.param("userId"), role);
  return c.json({ user_id: c.req.param("userId"), role });
});

x.delete("/workspace/members/:userId", requireAuth, supabaseOnly, requireAdmin, async (c) => {
  const ws = c.get("actor").workspace_id!;
  await assertKeepsAdmin(getStoreOf(c), ws, c.req.param("userId"), null);
  await c.get("store").workspaces.removeMember(ws, c.req.param("userId"));
  return c.json({ type: "member_removed", user_id: c.req.param("userId") });
});

/* ------------------------------------------------ OpenRouter provider */

function providerView(): ProviderSettings {
  const or = loadConfig()?.openrouter;
  return {
    provider: "openrouter",
    configured: Boolean(or),
    key_hint: or?.hint ?? null,
    last_checked_at: or?.last_checked_at ?? null,
    status: or?.status ?? "unknown",
  };
}

x.get("/providers/openrouter", requireAuth, (c) => c.json(providerView()));

x.put("/providers/openrouter", requireAuth, requireAdmin, async (c) => {
  const { api_key } = z.object({ api_key: z.string().min(10) }).parse(await c.req.json());
  const cfg = loadConfig()!;
  const check = await checkKey(api_key);
  cfg.openrouter = { key: api_key, hint: keyHint(api_key), status: check.valid ? "valid" : "invalid", last_checked_at: nowIso() };
  saveConfig(cfg);
  return c.json(providerView());
});

x.post("/providers/openrouter/test", requireAuth, async (c) => {
  const cfg = loadConfig()!;
  if (!cfg.openrouter) throw new ApiError(400, "invalid_request_error", "No OpenRouter key is configured");
  const check = await checkKey(cfg.openrouter.key);
  cfg.openrouter.status = check.valid ? "valid" : "invalid";
  cfg.openrouter.last_checked_at = nowIso();
  saveConfig(cfg);
  return c.json(providerView());
});

x.delete("/providers/openrouter", requireAuth, requireAdmin, (c) => {
  const cfg = loadConfig()!;
  delete cfg.openrouter;
  saveConfig(cfg);
  return c.json(providerView());
});

/* ------------------------------------------------ Model catalog */

x.get("/models", requireAuth, async (c) => {
  const q = c.req.query();
  let models = await listModels(q.refresh === "true");
  if (q.supports_tools === "true") models = models.filter((m) => m.supports_tools);
  if (q.search) {
    const s = q.search.toLowerCase();
    models = models.filter((m) => m.id.toLowerCase().includes(s) || m.name.toLowerCase().includes(s));
  }
  return c.json({ data: models, count: models.length });
});

/* ------------------------------------------------ API keys */

const keyView = (k: { id: string; name: string; hint: string; created_at: string; last_used_at?: string | null }) => ({
  type: "api_key", id: k.id, name: k.name, hint: k.hint, created_at: k.created_at, last_used_at: k.last_used_at ?? null,
});

// Local mode: keys live in the local config file. Supabase mode: in agentos.api_keys, per workspace.
x.get("/api_keys", requireAuth, async (c) => {
  if (AUTH_MODE === "supabase") return c.json({ data: (await c.get("store").apiKeys.list()).map(keyView) });
  return c.json({ data: (loadConfig()?.api_keys ?? []).map(keyView) });
});

x.post("/api_keys", requireAuth, async (c) => {
  const { name } = z.object({ name: z.string().trim().min(1).max(64) }).parse(await c.req.json());
  const { key, record } = newApiKey(name);
  if (AUTH_MODE === "supabase") {
    const actor = c.get("actor");
    if (actor.role === "viewer") throw new ApiError(403, "permission_error", "Viewers can't create API keys");
    await c.get("store").apiKeys.insert({ ...record, created_by: actor.type === "user" ? actor.id : null });
  } else {
    const cfg = loadConfig()!;
    cfg.api_keys.push(record);
    saveConfig(cfg);
  }
  // The plain key is returned exactly once.
  return c.json({ ...keyView(record), key });
});

x.delete("/api_keys/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  const actor = c.get("actor");
  if (actor.type === "api_key" && actor.id === id) throw conflict("A key can't revoke itself; use the Console or another key");
  if (AUTH_MODE === "supabase") {
    if (actor.role === "viewer") throw new ApiError(403, "permission_error", "Viewers can't revoke API keys");
    if (!(await c.get("store").apiKeys.revoke(id))) throw notFound("API key", id);
    return c.json({ type: "api_key_deleted", id });
  }
  const cfg = loadConfig()!;
  if (!cfg.api_keys.some((k) => k.id === id)) throw notFound("API key", id);
  cfg.api_keys = cfg.api_keys.filter((k) => k.id !== id);
  saveConfig(cfg);
  return c.json({ type: "api_key_deleted", id });
});

