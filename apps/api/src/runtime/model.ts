import type { ModelConfig } from "@agentos/types";
import { loadConfig } from "../lib/config.js";
import type { ToolDef } from "./tools.js";

/** OpenAI-compatible chat message, as OpenRouter accepts it. */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ModelResult {
  model: string;
  text: string | null;
  reasoning: string | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    cost_usd: number;
  };
}

export class ModelError extends Error {
  constructor(
    message: string,
    public kind: "model_request_failed_error" | "model_rate_limited_error" | "model_overloaded_error" | "billing_error",
  ) {
    super(message);
  }
}

const BASE = () => process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
export const openRouterBase = BASE;
export const openRouterKey = (): string => apiKey();

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY ?? loadConfig()?.openrouter?.key;
  if (!key) throw new ModelError("No OpenRouter API key. Add one in Settings → Model provider.", "billing_error");
  return key;
}

/**
 * Without max_tokens, OpenRouter reserves the model's full output limit (e.g. 65k
 * tokens) against the key's credit, which fails on keys with a spending cap.
 */
const DEFAULT_MAX_TOKENS = Number(process.env.AGENTOS_MAX_OUTPUT_TOKENS ?? 8192);

const EFFORT: Record<string, "low" | "medium" | "high"> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

/**
 * One model request through OpenRouter. Uses the agent's model, then its
 * fallbacks (OpenRouter `models` routing), and asks for usage + cost.
 */
export async function callModel(
  model: ModelConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal?: AbortSignal,
): Promise<ModelResult> {
  const effort = typeof model.effort === "string" ? model.effort : model.effort?.type;
  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    usage: { include: true },
    max_tokens: model.max_tokens ?? DEFAULT_MAX_TOKENS,
    ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
    ...(model.fallbacks?.length ? { models: [model.id, ...model.fallbacks] } : {}),
    ...(model.provider ? { provider: model.provider } : {}),
    ...(effort ? { reasoning: { effort: EFFORT[effort] ?? "medium" } } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${BASE()}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/agentos",
        "X-Title": "AgentOS",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ModelError(`Could not reach OpenRouter: ${(e as Error).message}`, "model_request_failed_error");
  }

  const json = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok || !json || json.error) {
    const msg = json?.error?.message ?? `OpenRouter returned ${res.status}`;
    const kind = res.status === 429 ? "model_rate_limited_error" : res.status === 402 ? "billing_error" : res.status >= 500 ? "model_overloaded_error" : "model_request_failed_error";
    throw new ModelError(msg, kind);
  }

  const choice = json.choices?.[0];
  const msg = choice?.message ?? {};
  const u = json.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    model: json.model ?? model.id,
    text: typeof msg.content === "string" && msg.content.trim() ? msg.content : null,
    reasoning: typeof msg.reasoning === "string" && msg.reasoning.trim() ? msg.reasoning : null,
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    finishReason: choice?.finish_reason ?? null,
    usage: {
      input_tokens: Math.max((u.prompt_tokens ?? 0) - cached, 0),
      output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: u.prompt_tokens_details?.cache_write_tokens ?? 0,
      cost_usd: Number(u.cost ?? 0),
    },
  };
}
