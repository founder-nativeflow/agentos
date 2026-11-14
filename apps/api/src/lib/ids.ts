import { randomBytes } from "node:crypto";
import { ID_PREFIX, type IdKind } from "@agentos/types";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** CMA-style id: prefix + "01" + 22 base62 chars, e.g. agent_01Ko1L6SkpW36GHPoqXhu2Lx. */
export function newId(kind: IdKind): string {
  const bytes = randomBytes(22);
  let body = "";
  for (const b of bytes) body += ALPHABET[b % ALPHABET.length];
  return `${ID_PREFIX[kind]}01${body}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
