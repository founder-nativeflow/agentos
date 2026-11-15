import type { WorkflowEdge } from "@agentos/types";
import type { CanvasStep } from "@/components/workflow-canvas";

/** A new step of the given kind, placed to the right of the rightmost step. */
export function newStep(type: CanvasStep["type"], steps: CanvasStep[], agent: { key?: string; id?: string }): CanvasStep {
  const ids = new Set(steps.map((s) => s.id));
  let n = 1;
  while (ids.has(`${type}_${n}`)) n++;
  const id = `${type}_${n}`;
  const maxX = Math.max(0, ...steps.map((s) => s.position?.x ?? 0));
  const position = { x: maxX + 280, y: 40 * (n - 1) };
  switch (type) {
    case "agent":
      return agent.key !== undefined
        ? { type, id, label: "New agent step", position, agent_key: agent.key, prompt: "{{input}}" }
        : { type, id, label: "New agent step", position, agent: { id: agent.id ?? "", version: null }, prompt: "{{input}}" };
    case "condition":
      return { type, id, label: "New condition", position, source: "{{input}}", operator: "contains", value: "" };
    case "router":
      return { type, id, label: "New router", position, source: "{{input}}", routes: [{ key: "first", description: "" }, { key: "second", description: "" }] };
    case "output":
      return { type, id, label: "Result", position, template: "{{input}}" };
    default:
      return { type: "start", id, label: "Start", position };
  }
}

/** Steps that run before `id` (for template hints). */
export function upstreamOf(id: string, edges: WorkflowEdge[]): string[] {
  const out = new Set<string>();
  const visit = (x: string) => {
    for (const e of edges.filter((e) => e.target === x)) {
      if (!out.has(e.source)) {
        out.add(e.source);
        visit(e.source);
      }
    }
  };
  visit(id);
  return [...out];
}

export function removeStep(id: string, steps: CanvasStep[], edges: WorkflowEdge[]) {
  return { steps: steps.filter((s) => s.id !== id), edges: edges.filter((e) => e.source !== id && e.target !== id) };
}

/** Drops connections whose branch no longer exists (e.g. a router route was renamed). */
export function pruneEdges(steps: CanvasStep[], edges: WorkflowEdge[]): WorkflowEdge[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return edges.filter((e) => {
    const src = byId.get(e.source);
    if (!src || !byId.has(e.target)) return false;
    if (src.type === "condition") return e.branch === "true" || e.branch === "false";
    if (src.type === "router") return src.routes.some((r) => r.key === e.branch);
    return !e.branch;
  });
}

/** JSON with sorted keys (the API's jsonb storage doesn't keep key order). */
export const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val));
