import { loadConfig } from "./config.js";
import type { Store } from "./store.js";
import { AUTH_MODE } from "./supabase-auth.js";

import { ModelError } from "../runtime/model.js";

/** Thrown when no OpenRouter key is available for a workspace (reported as a billing_error). */
export class MissingProviderKeyError extends ModelError {
  constructor(message: string) {
    super(message, "billing_error");
  }
}

/**
 * The OpenRouter key a session's model calls use:
 *  - Supabase mode: the workspace's own key (Settings → Model provider), else a platform key
 *    (OPENROUTER_API_KEY) if the operator set one.
 *  - Local mode: OPENROUTER_API_KEY, else the key saved in Settings (local config file).
 */
export async function resolveOpenRouterKey(store: Store): Promise<string> {
  if (AUTH_MODE === "supabase") {
    const own = await store.workspaceSettings.openRouterKey();
    if (own) return own;
    if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
    throw new MissingProviderKeyError("This workspace has no OpenRouter key. An admin can add one in Settings → Model provider.");
  }
  const key = process.env.OPENROUTER_API_KEY ?? loadConfig()?.openrouter?.key;
  if (!key) throw new MissingProviderKeyError("No OpenRouter API key. Add one in Settings → Model provider.");
  return key;
}
