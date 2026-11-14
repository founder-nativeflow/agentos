import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AGENTOS_HOME } from "./paths.js";
import { newId, nowIso } from "./ids.js";

/**
 * Local AgentOS config (Phase 0). Written by `agentos init`.
 * Users and API keys move into Supabase Auth with the cloud work (Phase 2).
 */
export interface LocalConfig {
  admin: { username: string; password_hash: string; salt: string };
  session_secret: string;
  api_keys: Array<{ id: string; name: string; key_hash: string; hint: string; created_at: string }>;
  openrouter?: { key: string; hint: string; status: "valid" | "invalid" | "unknown"; last_checked_at: string | null };
}

export const CONFIG_PATH = resolve(AGENTOS_HOME, "config.json");

export function loadConfig(): LocalConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as LocalConfig;
}

export function saveConfig(cfg: LocalConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const candidate = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

export function sha256(value: string): string {
  return createHmac("sha256", "agentos-api-key").update(value).digest("hex");
}

/** Signed console session token: base64url(payload).signature */
export function signSession(username: string, secret: string, ttlSeconds = 60 * 60 * 12): string {
  const payload = Buffer.from(JSON.stringify({ sub: username, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token: string, secret: string): { sub: string } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub: string; exp: number };
  return data.exp > Date.now() ? { sub: data.sub } : null;
}

export type ApiKeyRecord = LocalConfig["api_keys"][number];

/** A new API key; the plain key is shown once and only its hash is stored. */
export function newApiKey(name: string): { key: string; record: ApiKeyRecord } {
  const key = `aos-${randomBytes(24).toString("base64url")}`;
  return {
    key,
    record: { id: newId("apiKey"), name, key_hash: sha256(key), hint: `${key.slice(0, 8)}…${key.slice(-4)}`, created_at: nowIso() },
  };
}
