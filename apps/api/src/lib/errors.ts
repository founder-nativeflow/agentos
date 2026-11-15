import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ErrorResponse, ErrorType } from "@agentos/types";
import { ZodError } from "zod";

/** An error rendered in the CMA error envelope. */
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public errorType: ErrorType,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new ApiError(400, "invalid_request_error", msg);
export const conflict = (msg: string) => new ApiError(409, "invalid_request_error", msg);
export const notFound = (what: string, id: string) =>
  new ApiError(404, "not_found_error", `${what} '${id}' not found`);
export const unauthorized = (msg = "Invalid or missing API key") =>
  new ApiError(401, "authentication_error", msg);

export function errorBody(c: Context, type: ErrorType, message: string): ErrorResponse {
  return { type: "error", error: { type, message }, request_id: c.get("requestId") ?? "req_unknown" };
}

export function handleError(err: Error, c: Context) {
  if (err instanceof ApiError) {
    const retry = (err as ApiError & { retryAfterSeconds?: number }).retryAfterSeconds;
    if (retry) c.header("retry-after", String(retry));
    return c.json(errorBody(c, err.errorType, err.message), err.status);
  }
  if (err instanceof ZodError) {
    const msg = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return c.json(errorBody(c, "invalid_request_error", msg), 400);
  }
  if (err instanceof SyntaxError) {
    return c.json(errorBody(c, "invalid_request_error", "Request body is not valid JSON"), 400);
  }
  console.error(err);
  return c.json(errorBody(c, "api_error", "Internal server error"), 500);
}
