import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AUTH_MODE } from "./supabase-auth.js";

/**
 * SSRF guard for requests the API host makes on an agent's behalf (web_fetch, MCP servers).
 * Blocks loopback, private, link-local (cloud metadata, 169.254.169.254) and other
 * non-public addresses. On by default in cloud (Supabase) mode; in local mode the agent
 * owner is the machine owner, so localhost MCP servers keep working.
 *   AGENTOS_BLOCK_PRIVATE_NETWORKS=1  turn it on in local mode
 *   AGENTOS_ALLOW_PRIVATE_NETWORKS=1  turn it off in cloud mode (e.g. for an internal MCP server)
 */
export const BLOCK_PRIVATE =
  AUTH_MODE === "supabase" ? process.env.AGENTOS_ALLOW_PRIVATE_NETWORKS !== "1" : process.env.AGENTOS_BLOCK_PRIVATE_NETWORKS === "1";

export class BlockedUrlError extends Error {}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
];

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  const a = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (a === "::" || a === "::1") return true;
  return /^(fc|fd|fe[89ab]|ff)/.test(a) || a.startsWith("64:ff9b:") || a.startsWith("2001:db8:");
}

/** Throws BlockedUrlError unless `url` is http(s) and every address it resolves to is public. */
export async function assertPublicUrl(url: string): Promise<void> {
  if (!BLOCK_PRIVATE) return;
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedUrlError(`Only http and https URLs are allowed (${u.protocol})`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new BlockedUrlError(`Could not resolve ${host}`);
  const bad = addrs.find(isPrivateAddress);
  if (bad) throw new BlockedUrlError(`${host} resolves to a private or internal address (${bad}); requests to internal networks are blocked`);
}

/**
 * fetch() that re-checks every redirect hop: against the public-address guard and, when
 * given, the environment's allowed hosts.
 */
export async function guardedFetch(url: string, init: RequestInit, allowHost?: (host: string) => boolean): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const host = new URL(current).hostname;
    if (allowHost && !allowHost(host)) throw new BlockedUrlError(`Blocked by environment networking: ${host} is not in allowed hosts`);
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    current = new URL(loc, current).toString();
  }
  throw new BlockedUrlError("Too many redirects");
}
