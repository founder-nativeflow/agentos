import { AsyncLocalStorage } from "node:async_hooks";
import type { Store } from "./store.js";

/**
 * The workspace-scoped store for the current request (and for the agent loop a request
 * starts, which inherits the async context). Local mode always uses the default store.
 */
export const storeScope = new AsyncLocalStorage<Store>();
