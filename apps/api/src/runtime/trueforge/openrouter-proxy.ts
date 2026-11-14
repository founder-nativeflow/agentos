import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import type { ModelConfig } from "@agentos/types";
import { openRouterBase } from "../model.js";

/**
 * Loopback proxy between trueforge-core and OpenRouter, inside the API process.
 *
 * trueforge-core talks to "any OpenAI-compatible endpoint" but (as of 0.182):
 *  - reads cost only from a gateway field (`usage.costInUSD`), not OpenRouter's `usage.cost`;
 *  - can't express OpenRouter routing (`models` fallbacks, `provider` preferences).
 * This proxy adds `usage: {include: true}` and the agent's routing to each request,
 * and copies `usage.cost` → `usage.costInUSD` in the (streamed) response, so cost is
 * exact and budgets stay exact.
 *
 * Per-agent routing travels in the path: /r/<base64url(json) | _>/chat/completions.
 */

interface Routing {
  fallbacks?: string[];
  provider?: ModelConfig["provider"];
}

let started: Promise<string> | null = null;

/** trueforge-core's HTTP client may compress request bodies. */
function decode(buf: Buffer, encoding: string | string[] | undefined): string {
  const enc = String(encoding ?? "identity").toLowerCase().trim();
  if (enc === "identity" || enc === "") return buf.toString("utf8");
  if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buf).toString("utf8");
  if (enc === "deflate") return zlib.inflateSync(buf).toString("utf8");
  if (enc === "br") return zlib.brotliDecompressSync(buf).toString("utf8");
  const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (enc === "zstd" && zstd) return zstd(buf).toString("utf8");
  throw new Error(`Unsupported request content-encoding: ${enc}`);
}

/** Adds costInUSD next to cost in one parsed chunk/body. */
function withCost(obj: Record<string, unknown>): Record<string, unknown> {
  const u = obj.usage as Record<string, unknown> | undefined;
  if (u && typeof u.cost === "number" && u.costInUSD === undefined) u.costInUSD = u.cost;
  return obj;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const m = req.url?.match(/^\/r\/([A-Za-z0-9_-]*)(\/.*)$/);
  if (!m || req.method !== "POST") return void res.writeHead(404).end();
  // "_" = no routing (an empty path segment would be collapsed by the client).
  const routing: Routing = m[1] && m[1] !== "_" ? JSON.parse(Buffer.from(m[1], "base64url").toString()) : {};
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(decode(Buffer.concat(chunks), req.headers["content-encoding"])) as Record<string, unknown>;
  body.usage = { include: true };
  if (routing.fallbacks?.length) body.models = [body.model, ...routing.fallbacks];
  if (routing.provider) body.provider = routing.provider;

  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const h of ["authorization", "http-referer", "x-title", "accept"]) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  let up: Response;
  try {
    up = await fetch(`${openRouterBase().replace(/\/$/, "")}${m[2]}`, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ error: { message: `OpenRouter unreachable: ${(err as Error).message}` } }));
  }
  const type = up.headers.get("content-type") ?? "";
  res.writeHead(up.status, { "content-type": type || "application/json" });
  if (!up.body) return void res.end();

  if (!type.includes("text/event-stream")) {
    const text = await up.text();
    try {
      return void res.end(JSON.stringify(withCost(JSON.parse(text))));
    } catch {
      return void res.end(text);
    }
  }
  // SSE: rewrite only `data:` lines that carry usage; pass everything else through untouched.
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i + 1);
        buf = buf.slice(i + 1);
        if (line.startsWith("data:") && line.includes('"usage"')) {
          const payload = line.slice(5).trim();
          try {
            res.write(`data: ${JSON.stringify(withCost(JSON.parse(payload)))}\n`);
            continue;
          } catch {
            /* not JSON: pass through */
          }
        }
        res.write(line);
      }
    }
    if (buf) res.write(buf);
  } catch {
    /* client went away */
  }
  res.end();
}

/** Base URL (on 127.0.0.1) to give trueforge-core for an agent's model config. */
export async function proxiedBaseUrl(model: ModelConfig): Promise<string> {
  started ??= new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: (err as Error).message } }));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    server.unref();
  });
  const origin = await started;
  const routing: Routing = {
    ...(model.fallbacks?.length ? { fallbacks: model.fallbacks } : {}),
    ...(model.provider ? { provider: model.provider } : {}),
  };
  const key = Object.keys(routing).length ? Buffer.from(JSON.stringify(routing)).toString("base64url") : "_";
  return `${origin}/r/${key}`;
}
