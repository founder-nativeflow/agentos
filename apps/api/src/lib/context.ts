import type { Store } from "./store.js";
import type { Actor } from "./auth.js";
import type { SessionRuntime } from "../runtime/runner.js";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    actor: Actor;
    store: Store;
    runtime: SessionRuntime;
  }
}

export {};
