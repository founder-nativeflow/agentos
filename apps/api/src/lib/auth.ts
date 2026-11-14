import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { loadConfig, sha256, verifySession } from "./config.js";
import { ApiError, unauthorized } from "./errors.js";

export const SESSION_COOKIE = "agentos_session";

/**
 * Accepts, like CMA:
 *  - `x-api-key: <key>` or `Authorization: Bearer <key>` (SDKs, scripts)
 *  - the Console's signed session cookie (after admin login)
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const cfg = loadConfig();
  if (!cfg) {
    throw new ApiError(403, "permission_error", "AgentOS is not initialised. Run `pnpm agentos init` first.");
  }

  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie && verifySession(cookie, cfg.session_secret)) {
    c.set("actor", { type: "user", id: "admin" });
    return next();
  }

  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const key = c.req.header("x-api-key") ?? bearer;
  if (key) {
    const hit = cfg.api_keys.find((k) => k.key_hash === sha256(key));
    if (hit) {
      c.set("actor", { type: "api_key", id: hit.id });
      return next();
    }
  }
  throw unauthorized();
};
