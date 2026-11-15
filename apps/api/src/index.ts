import "./lib/context.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
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

app.use("/v1/*", cors({ origin: (o) => o, credentials: true }));

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
app.route("/v1", planned);

app.notFound((c) => c.json(errorBody(c, "not_found_error", `No route for ${c.req.method} ${c.req.path}`), 404));
app.onError(handleError);

const port = Number(process.env.PORT ?? 4000);

async function main() {
  try {
    if (AUTH_MODE === "local") await store.init(); // Supabase mode: workspaces are created by users
    await runtime.recover();
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
