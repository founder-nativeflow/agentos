import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  addEdge, Background, BaseEdge, Controls, EdgeLabelRenderer, getBezierPath, Handle, MarkerType, MiniMap, Position, ReactFlow,
  ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Bot, CheckCircle2, CircleDashed, Flag, GitBranch, Loader2, Play, Split, XCircle } from "lucide-react";
import type { BuilderWorkflowNode, WorkflowEdge, WorkflowNode, WorkflowStepState } from "@agentos/types";
import { cn } from "@/lib/utils";

/** A workflow step as the canvas sees it: a saved step (agent by id) or a builder draft step (agent by key). */
export type CanvasStep = WorkflowNode | BuilderWorkflowNode;

type StepData = {
  step: CanvasStep;
  agentName: string | null;
  state?: WorkflowStepState;
  selected?: boolean;
};

const KIND = {
  start: { icon: Play, label: "Start", tone: "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300" },
  agent: { icon: Bot, label: "Agent", tone: "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200" },
  condition: { icon: GitBranch, label: "Condition", tone: "border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200" },
  router: { icon: Split, label: "Router", tone: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" },
  output: { icon: Flag, label: "Output", tone: "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300" },
} as const;

export function branchesOf(step: CanvasStep): string[] {
  if (step.type === "condition") return ["true", "false"];
  if (step.type === "router") return step.routes.map((r) => r.key);
  return [];
}

function subtitle(step: CanvasStep, agentName: string | null): string {
  switch (step.type) {
    case "start": return step.input_description || "Run input";
    case "agent": return agentName ?? ("agent_key" in step ? step.agent_key : step.agent.id);
    case "condition": return `${step.operator.replace("_", " ")} "${step.value}"`;
    case "router": return `${step.routes.length} routes`;
    case "output": return "Run result";
  }
}

function StatusIcon({ state }: { state?: WorkflowStepState }) {
  if (!state) return null;
  const s = state.status;
  if (s === "running") return <Loader2 className="size-4 animate-spin text-blue-600" aria-label="Running" />;
  if (s === "succeeded") return <CheckCircle2 className="size-4 text-emerald-600" aria-label="Succeeded" />;
  if (s === "failed") return <XCircle className="size-4 text-red-600" aria-label="Failed" />;
  if (s === "skipped") return <CircleDashed className="size-4 text-muted-foreground" aria-label="Skipped" />;
  return <CircleDashed className="size-4 text-muted-foreground/50" aria-label="Pending" />;
}

function StepNode({ data, selected }: NodeProps<Node<StepData>>) {
  const { step, agentName, state } = data;
  const kind = KIND[step.type];
  const Icon = kind.icon;
  const branches = branchesOf(step);
  const faded = state?.status === "skipped" || state?.status === "pending";
  return (
    <div
      className={cn(
        "w-56 rounded-lg border bg-card text-card-foreground shadow-sm transition-opacity",
        selected && "ring-2 ring-primary",
        state?.status === "running" && "ring-2 ring-blue-500",
        state?.status === "failed" && "ring-2 ring-red-500",
        faded && state && "opacity-50",
      )}
    >
      {step.type !== "start" && <Handle type="target" position={Position.Left} className="!size-2.5 !bg-muted-foreground" />}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded border", kind.tone)}>
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{step.label}</div>
          <div className="truncate text-xs text-muted-foreground">{subtitle(step, agentName)}</div>
        </div>
        <StatusIcon state={state} />
      </div>
      {branches.length > 0 ? (
        <div className="flex flex-col gap-1 py-1.5">
          {branches.map((b) => (
            <div key={b} className="relative flex items-center justify-end pr-4 text-xs text-muted-foreground">
              <span className={cn(state?.branch === b && "font-medium text-foreground")}>{b}</span>
              <Handle id={b} type="source" position={Position.Right} className="!size-2.5 !bg-muted-foreground" style={{ top: "50%" }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-1.5 text-xs text-muted-foreground">
          {kind.label}
          {state?.cost_usd && Number(state.cost_usd) > 0 ? ` · $${Number(state.cost_usd).toFixed(4)}` : ""}
        </div>
      )}
      {branches.length === 0 && step.type !== "output" && <Handle type="source" position={Position.Right} className="!size-2.5 !bg-muted-foreground" />}
    </div>
  );
}

function BranchEdge(props: EdgeProps<Edge<{ branch?: string | null; active?: boolean }>>) {
  const [path, x, y] = getBezierPath(props);
  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} style={{ ...props.style, strokeWidth: props.data?.active ? 2.5 : 1.5 }} />
      {props.data?.branch && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground"
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
          >
            {props.data.branch}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { step: StepNode };
const edgeTypes = { branch: BranchEdge };

export interface WorkflowCanvasProps {
  steps: CanvasStep[];
  edges: WorkflowEdge[];
  agentName?: (step: CanvasStep) => string | null;
  /** Run statuses to overlay (read from a workflow run). */
  states?: Record<string, WorkflowStepState>;
  editable?: boolean;
  /** Called with the full graph after a move, connect or delete. */
  onChange?: (steps: CanvasStep[], edges: WorkflowEdge[]) => void;
  onSelect?: (stepId: string | null) => void;
  selectedId?: string | null;
  className?: string;
}

function toFlow(props: WorkflowCanvasProps): { nodes: Node<StepData>[]; edges: Edge[] } {
  const { steps, edges, states, agentName, selectedId } = props;
  return {
    nodes: steps.map((s, i) => ({
      id: s.id,
      type: "step",
      position: s.position ?? { x: i * 280, y: 0 },
      selected: s.id === selectedId,
      data: { step: s, agentName: agentName?.(s) ?? null, state: states?.[s.id] },
      deletable: s.type !== "start",
    })),
    edges: edges.map((e) => {
      const src = states?.[e.source];
      const active = Boolean(states && src?.status === "succeeded" && (!e.branch || src.branch === e.branch));
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.branch ?? undefined,
        type: "branch",
        data: { branch: e.branch ?? null, active },
        animated: states?.[e.target]?.status === "running",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: { stroke: active ? "var(--color-primary, #6d28d9)" : undefined },
      };
    }),
  };
}

function Canvas(props: WorkflowCanvasProps) {
  const initial = useMemo(() => toFlow(props), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const { fitView } = useReactFlow();
  const shape = props.steps.map((s) => s.id).join(",");

  // Follow the props (a new plan from the builder, run statuses, renamed steps).
  useEffect(() => {
    const next = toFlow(props);
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [props.steps, props.edges, props.states, props.selectedId, props.agentName]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.2, maxZoom: 1.1, duration: 200 }), 50);
    return () => clearTimeout(t);
  }, [shape, fitView]);
  // Refit when the panel is resized (e.g. the layout switches from stacked to side by side).
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    let t: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => fitView({ padding: 0.2, maxZoom: 1.1 }), 120);
    });
    ro.observe(box.current);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [fitView]);

  const emit = useCallback(
    (ns: Node<StepData>[], es: Edge[]) => {
      if (!props.onChange) return;
      const byId = new Map(props.steps.map((s) => [s.id, s]));
      props.onChange(
        ns.filter((n) => byId.has(n.id)).map((n) => ({ ...byId.get(n.id)!, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } }) as CanvasStep),
        es.map((e) => ({ id: e.id, source: e.source, target: e.target, branch: (e.sourceHandle as string | null) ?? null })),
      );
    },
    [props],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const id = `e_${c.source}_${c.target}_${c.sourceHandle ?? "x"}`;
      const next = addEdge({ ...c, id, type: "branch", data: { branch: c.sourceHandle ?? null } }, edges);
      setEdges(next);
      emit(nodes, next);
    },
    [edges, nodes, setEdges, emit],
  );

  return (
    <div ref={box} className="h-full w-full">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={() => emit(nodes, edges)}
      onNodesDelete={(deleted) => {
        const gone = new Set(deleted.map((d) => d.id));
        emit(nodes.filter((n) => !gone.has(n.id)), edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)));
      }}
      onEdgesDelete={(deleted) => {
        const gone = new Set(deleted.map((d) => d.id));
        emit(nodes, edges.filter((e) => !gone.has(e.id)));
      }}
      onConnect={props.editable ? onConnect : undefined}
      onNodeClick={(_, n) => props.onSelect?.(n.id)}
      onPaneClick={() => props.onSelect?.(null)}
      nodesDraggable={props.editable}
      nodesConnectable={props.editable}
      elementsSelectable
      deleteKeyCode={props.editable ? ["Backspace", "Delete"] : null}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
      proOptions={{ hideAttribution: true }}
      minZoom={0.3}
      className={cn("bg-muted/30", props.className)}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable className="!bg-background" style={{ width: 140, height: 90 }} maskColor="rgb(0 0 0 / 0.06)" />
    </ReactFlow>
    </div>
  );
}

/** The workflow canvas: steps and connections, optional run statuses, optional editing. */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <div className={cn("h-full min-h-[360px] w-full overflow-hidden rounded-lg border", props.className)}>
      <ReactFlowProvider>
        <Canvas {...props} className="" />
      </ReactFlowProvider>
    </div>
  );
}

/** Small legend for step kinds. */
export function StepLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {(Object.keys(KIND) as Array<keyof typeof KIND>).map((k) => {
        const Icon = KIND[k].icon;
        return (
          <span key={k} className="inline-flex items-center gap-1">
            <span className={cn("flex size-4 items-center justify-center rounded border", KIND[k].tone)}><Icon className="size-2.5" /></span>
            {KIND[k].label}
          </span>
        );
      })}
    </div>
  );
}
