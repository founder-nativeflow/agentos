import type { SessionEvent } from "@agentos/types";

/**
 * Subscribes to a session's event stream (SSE) using fetch, so the session
 * cookie is sent and every event type is received. Reconnects with the last
 * sequence number so nothing is missed.
 */
export function subscribeToSession(
  sessionId: string,
  afterSeq: number,
  onEvent: (seq: number, event: SessionEvent) => void,
): () => void {
  const controller = new AbortController();
  let lastSeq = afterSeq;
  let stopped = false;

  const connect = async () => {
    while (!stopped) {
      try {
        const res = await fetch(`/v1/sessions/${sessionId}/events/stream?after_seq=${lastSeq}`, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = "";
            let id = "";
            let data = "";
            for (const line of chunk.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("id:")) id = line.slice(3).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!event || event === "ping" || !data) continue;
            const seq = Number(id);
            if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq);
            onEvent(seq, JSON.parse(data) as SessionEvent);
          }
        }
      } catch {
        if (stopped) return;
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 1000));
    }
  };
  void connect();
  return () => {
    stopped = true;
    controller.abort();
  };
}
