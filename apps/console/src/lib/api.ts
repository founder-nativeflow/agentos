import type { ErrorResponse } from "@agentos/types";

/** Error thrown for any non-2xx response, carrying the CMA error envelope. */
export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public body: ErrorResponse | null,
  ) {
    super(body?.error.message ?? `Request failed with status ${status}`);
  }
}

/**
 * The Console calls the same /v1 API that SDKs use. In development Vite
 * proxies /v1 to the API on :4000; the session cookie authenticates.
 */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    credentials: "include",
    ...rest,
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorResponse | null;
    throw new ApiRequestError(res.status, body);
  }
  return (await res.json()) as T;
}

export function formatPricePerMillion(perToken: string): string {
  const n = Number(perToken) * 1_000_000;
  if (!Number.isFinite(n) || n < 0) return "–";
  if (n === 0) return "Free";
  return `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
}

export function formatContext(n: number | null): string {
  if (!n) return "–";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`;
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
