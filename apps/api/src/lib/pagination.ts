import type { Page } from "@agentos/types";
import { badRequest } from "./errors.js";

/** CMA `page` / `next_page` cursor pagination over an already-ordered array. */
export function paginate<T>(items: T[], query: { limit?: string; page?: string }): Page<T> {
  const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100);
  let offset = 0;
  if (query.page) {
    try {
      offset = JSON.parse(Buffer.from(query.page, "base64url").toString()).o;
    } catch {
      throw badRequest("Invalid page cursor");
    }
  }
  const data = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? Buffer.from(JSON.stringify({ o: offset + limit })).toString("base64url") : null;
  return { data, next_page: next };
}
