import "./lib/context.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { API_VERSION, CMA_BETA } from "@agentos/types";
import { newId } from "./lib/ids.js";
import { errorBody, handleError } from "./lib/errors.js";
import { requireAuth } from "./lib/auth.js";
import { Store } from "./lib/store.js";
import { loadConfig, CONFIG_PATH } from "./lib/config.js";
import { AUTH_MODE } from "./lib/supabase-auth.js";
import { RUNTIME, SessionRuntime } from "./runtime/runner.js";
import { TRUEFORGE_VERSION } from "./runtime/trueforge/engine.js";
import { agents } from "./routes/agents.js";
import { environments } from "./routes/environments.js";
import { sessionRoutes } from "./routes/sessions.js";
import { files } from "./routes/files.js";
import { vaults } from "./routes/vaults.js";
import { deploymentRoutes, deploymentRunRoutes, webhookRoute } from "./routes/deployments.js";
import { startScheduler } from "./runtime/deployments.js";
import { planned } from "./routes/planned.js";
import { workflowRoutes, workflowRunRoutes } from "./routes/workflows.js";
import { builderRoutes } from "./routes/builder.js";
import { x } from "./routes/x.js";

const store = new Store();
const runtime = new SessionRuntime(store);
const app = new Hono();

app.use("*", async (c, next) => {
  const requestId = newId("request");
  c.set("requestId", requestId);
  c.set("store", store);
  c.set("runtime", runtime);
  await next();
  c.header("request-id", requestId);
});

/*
 * CORS: SDKs and scripts don't need it, and the Console is served from the API's own origin
 * (or proxied by Vite in development). Browsers on other origins get CORS only when listed in
 * AGENTOS_CORS_ORIGINS (comma-separated); local mode also allows the Vite dev server.
 */
const corsOrigins = new Set(
  [
    ...(process.env.AGENTOS_CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    ...(AUTH_MODE === "local" ? ["http://localhost:5173", "http://127.0.0.1:5173"] : []),
  ],
);
app.use("/v1/*", cors({ origin: (o) => (corsOrigins.has(o) ? o : null), credentials: true }));
app.use(
  "*",
  secureHeaders({
    crossOriginResourcePolicy: false, // file downloads are fetched by the Console with credentials
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  }),
);
// JSON bodies are capped; file uploads have their own limit in /v1/files.
const JSON_LIMIT = Number(process.env.AGENTOS_MAX_BODY_BYTES ?? 10 * 1024 * 1024);
app.use("/v1/*", async (c, next) => {
  if (c.req.path.startsWith("/v1/files")) return next();
  return bodyLimit({
    maxSize: JSON_LIMIT,
    onError: (cc) => cc.json(errorBody(cc, "request_too_large", `Request bodies are limited to ${JSON_LIMIT} bytes`), 413),
  })(c, next);
});

app.get("/health", async (c) => {
  let database = "ok";
  try {
    await store.sql`select 1`;
  } catch {
    database = "unreachable";
  }
  return c.json({
    status: database === "ok" ? "ok" : "degraded",
    service: "agentos-api",
    api_version: API_VERSION,
    cma_beta: CMA_BETA,
    initialised: AUTH_MODE === "supabase" || Boolean(loadConfig()),
    auth: AUTH_MODE,
    database,
    workspace: store.workspaceId,
    runtime: RUNTIME === "trueforge" ? { engine: "trueforge-core", version: TRUEFORGE_VERSION } : { engine: "classic" },
  });
});

/* AgentOS extensions (login is public; the rest require auth inside). */
app.route("/v1/x/hooks", webhookRoute(runtime)); // public; authenticated by the webhook token
app.route("/v1/x", x);

/* CMA-compatible surface. */
app.use("/v1/*", requireAuth);
app.route("/v1/agents", agents);
app.route("/v1/environments", environments);
app.route("/v1/sessions", sessionRoutes(runtime));
app.route("/v1/files", files);
app.route("/v1/vaults", vaults);
app.route("/v1/deployments", deploymentRoutes(runtime));
app.route("/v1/deployment_runs", deploymentRunRoutes());
app.route("/v1/x/workflows", workflowRoutes(runtime));
app.route("/v1/x/workflow_runs", workflowRunRoutes(runtime));
app.route("/v1/x/builder", builderRoutes(runtime));
app.route("/v1", planned);

app.notFound((c) => c.json(errorBody(c, "not_found_error", `No route for ${c.req.method} ${c.req.path}`), 404));
app.onError(handleError);

const port = Number(process.env.PORT ?? 4000);

async function main() {
  try {
    if (AUTH_MODE === "local") await store.init(); // Supabase mode: workspaces are created by users
    await runtime.recover();
    const interrupted = await store.workflowRuns.failInterrupted();
    if (interrupted) console.log(`[workflows] ${interrupted} run(s) interrupted by the restart were marked failed`);
    startScheduler(store, runtime);
  } catch (err) {
    console.error(`Could not connect to the database. Is local Supabase running? (pnpm db:start)\n${(err as Error).message}`);
    process.exit(1);
  }
  serve({ fetch: app.fetch, port }, () => {
    console.log(`AgentOS API listening on http://localhost:${port} (workspace ${store.workspaceId})`);
    console.log(`Config: ${CONFIG_PATH}${loadConfig() ? "" : " (missing: run `pnpm agentos init`)"}`);
  });
}

void main();

export { app };
