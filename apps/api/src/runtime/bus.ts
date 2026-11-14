import { EventEmitter } from "node:events";
import type { SessionEvent } from "@agentos/types";

/** In-process fan-out of new session events to SSE subscribers. */
class SessionBus {
  private emitter = new EventEmitter().setMaxListeners(1000);

  publish(sessionId: string, seq: number, event: SessionEvent) {
    this.emitter.emit(sessionId, seq, event);
  }

  subscribe(sessionId: string, fn: (seq: number, event: SessionEvent) => void): () => void {
    this.emitter.on(sessionId, fn);
    return () => this.emitter.off(sessionId, fn);
  }
}

export const bus = new SessionBus();
