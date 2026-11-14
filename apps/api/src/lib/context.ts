import type { Store } from "./store.js";
import type { SessionRuntime } from "../runtime/runner.js";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    actor: { type: "user" | "api_key"; id: string };
    store: Store;
    runtime: SessionRuntime;
  }
}

export {};
