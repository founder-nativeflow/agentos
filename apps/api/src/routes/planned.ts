import { Hono } from "hono";
import { ApiError } from "../lib/errors.js";

/**
 * CMA resources that are part of the AgentOS contract but not built yet.
 * They answer 404 `not_found_error` in the CMA envelope with an explicit
 * "not implemented yet (planned: Phase N)" message. 404 rather than 501 because
 * the Anthropic SDKs automatically retry every 5xx, which would add seconds of
 * pointless retries to each call.
 * Each line names the phase that delivers it (see the PRD, §10).
 */
export const PLANNED: Array<{ prefix: string; phase: string }> = [
  { prefix: "/memory_stores", phase: "Phase 3" },
  { prefix: "/skills", phase: "Phase 3" },
];

export const planned = new Hono();

for (const { prefix, phase } of PLANNED) {
  planned.all(`${prefix}/*`, () => {
    throw new ApiError(404, "not_found_error", `${prefix.slice(1)} is not implemented yet in AgentOS (planned: ${phase}).`);
  });
  planned.all(prefix, () => {
    throw new ApiError(404, "not_found_error", `${prefix.slice(1)} is not implemented yet in AgentOS (planned: ${phase}).`);
  });
}
