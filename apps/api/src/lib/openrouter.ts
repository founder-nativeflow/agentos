import type { OpenRouterModel } from "@agentos/types";

const BASE = "https://openrouter.ai/api/v1";
const TTL_MS = 60 * 60 * 1000;

let cache: { at: number; models: OpenRouterModel[] } | null = null;

interface RawModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number | null;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
}

/** OpenRouter's public model catalog (no key needed), cached for an hour. */
export async function listModels(force = false): Promise<OpenRouterModel[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.models;
  const res = await fetch(`${BASE}/models`, { headers: { "User-Agent": "AgentOS" } });
  if (!res.ok) throw new Error(`OpenRouter models request failed: ${res.status}`);
  const body = (await res.json()) as { data: RawModel[] };
  const models = body.data.map<OpenRouterModel>((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    context_length: m.context_length ?? null,
    pricing: {
      prompt: m.pricing?.prompt ?? "0",
      completion: m.pricing?.completion ?? "0",
      input_cache_read: m.pricing?.input_cache_read,
    },
    supported_parameters: m.supported_parameters ?? [],
    input_modalities: m.architecture?.input_modalities ?? ["text"],
    supports_tools: (m.supported_parameters ?? []).includes("tools"),
  }));
  cache = { at: Date.now(), models };
  return models;
}

/** Validates an OpenRouter key by asking OpenRouter about it. */
export async function checkKey(key: string): Promise<{ valid: boolean; detail?: unknown }> {
  const res = await fetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "AgentOS" } });
  if (!res.ok) return { valid: false };
  return { valid: true, detail: await res.json().catch(() => undefined) };
}

export function keyHint(key: string): string {
  return key.length > 10 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "…";
}
