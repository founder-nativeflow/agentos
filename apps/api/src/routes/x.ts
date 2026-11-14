import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { ProviderSettings } from "@agentos/types";
import { loadConfig, newApiKey, saveConfig, signSession, verifyPassword } from "../lib/config.js";
import { requireAuth, SESSION_COOKIE } from "../lib/auth.js";
import { ApiError, conflict, notFound, unauthorized } from "../lib/errors.js";
import { checkKey, keyHint, listModels } from "../lib/openrouter.js";
import { nowIso } from "../lib/ids.js";

/** AgentOS-only endpoints, kept under /v1/x so the CMA surface stays clean. */
export const x = new Hono();

/* ------------------------------------------------ Console admin login */

x.post("/auth/login", async (c) => {
  const cfg = loadConfig();
  if (!cfg) throw new ApiError(403, "permission_error", "AgentOS is not initialised. Run `pnpm agentos init` first.");
  const { username, password } = z.object({ username: z.string(), password: z.string() }).parse(await c.req.json());
  if (username !== cfg.admin.username || !verifyPassword(password, cfg.admin.salt, cfg.admin.password_hash)) {
    throw unauthorized("Incorrect username or password");
  }
  setCookie(c, SESSION_COOKIE, signSession(username, cfg.session_secret), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return c.json({ username });
});

x.post("/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

x.get("/auth/me", requireAuth, (c) => c.json({ actor: c.get("actor"), username: loadConfig()?.admin.username }));

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

x.put("/providers/openrouter", requireAuth, async (c) => {
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

x.delete("/providers/openrouter", requireAuth, (c) => {
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

const keyView = (k: { id: string; name: string; hint: string; created_at: string }) => ({
  type: "api_key", id: k.id, name: k.name, hint: k.hint, created_at: k.created_at,
});

x.get("/api_keys", requireAuth, (c) => c.json({ data: (loadConfig()?.api_keys ?? []).map(keyView) }));

x.post("/api_keys", requireAuth, async (c) => {
  const { name } = z.object({ name: z.string().trim().min(1).max(64) }).parse(await c.req.json());
  const cfg = loadConfig()!;
  const { key, record } = newApiKey(name);
  cfg.api_keys.push(record);
  saveConfig(cfg);
  // The plain key is returned exactly once.
  return c.json({ ...keyView(record), key });
});

x.delete("/api_keys/:id", requireAuth, (c) => {
  const cfg = loadConfig()!;
  const id = c.req.param("id");
  const hit = cfg.api_keys.find((k) => k.id === id);
  if (!hit) throw notFound("API key", id);
  const actor = c.get("actor") as { type: string; id: string } | undefined;
  if (actor?.type === "api_key" && actor.id === id) throw conflict("A key can't revoke itself; use the Console or another key");
  cfg.api_keys = cfg.api_keys.filter((k) => k.id !== id);
  saveConfig(cfg);
  return c.json({ type: "api_key_deleted", id });
});
