import { useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { CanvasStep } from "./workflow-canvas";

const HELP = "Use {{input}} for the run's input and {{nodes.<step id>.output}} for an earlier step's result.";

/** Edit one step. `agents` are the choices for an agent step (value = id or draft key). */
export function StepEditor({
  step, agents, upstream, onSave, onDelete, onClose, readOnly,
}: {
  step: CanvasStep | null;
  agents: Array<{ value: string; label: string }>;
  /** Ids of steps that run before this one (for template hints). */
  upstream: string[];
  onSave: (s: CanvasStep) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState<CanvasStep | null>(step);
  useEffect(() => { setDraft(step); }, [step]);
  if (!draft) return <Sheet open={false} onOpenChange={onClose} />;
  const set = (patch: Partial<CanvasStep>) => setDraft({ ...draft, ...patch } as CanvasStep);
  const agentValue = draft.type === "agent" ? ("agent_key" in draft ? draft.agent_key : draft.agent.id) : "";

  return (
    <Sheet open={Boolean(step)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{draft.label}</SheetTitle>
          <SheetDescription>
            Step id <code className="text-xs">{draft.id}</code> · {draft.type}
          </SheetDescription>
        </SheetHeader>
        <fieldset disabled={readOnly} className="grid gap-4 px-4">
          <div className="grid gap-1.5">
            <Label htmlFor="step-label">Name</Label>
            <Input id="step-label" value={draft.label} onChange={(e) => set({ label: e.target.value })} />
          </div>

          {draft.type === "start" && (
            <div className="grid gap-1.5">
              <Label htmlFor="step-input">What each run starts with</Label>
              <Textarea id="step-input" value={draft.input_description ?? ""} onChange={(e) => set({ input_description: e.target.value })} placeholder="A support ticket's subject and body" />
            </div>
          )}

          {draft.type === "agent" && (
            <>
              <div className="grid gap-1.5">
                <Label>Agent</Label>
                <Select
                  value={agentValue}
                  onValueChange={(v) => setDraft("agent_key" in draft ? { ...draft, agent_key: v } : { ...draft, agent: { id: v, version: null } })}
                >
                  <SelectTrigger><SelectValue placeholder="Choose an agent" /></SelectTrigger>
                  <SelectContent>
                    {agents.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="step-prompt">Task for the agent</Label>
                <Textarea id="step-prompt" rows={8} className="font-mono text-xs" value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} />
                <p className="text-xs text-muted-foreground">{HELP}</p>
              </div>
            </>
          )}

          {(draft.type === "condition" || draft.type === "router") && (
            <div className="grid gap-1.5">
              <Label htmlFor="step-source">Checks</Label>
              <Input id="step-source" className="font-mono text-xs" value={draft.source} onChange={(e) => set({ source: e.target.value })} />
              {upstream.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {upstream.map((u) => (
                    <button key={u} type="button" className="rounded border px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent" onClick={() => set({ source: `{{nodes.${u}.output}}` })}>
                      {u}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {draft.type === "condition" && (
            <div className="grid grid-cols-[140px_1fr] gap-2">
              <div className="grid gap-1.5">
                <Label>Rule</Label>
                <Select value={draft.operator} onValueChange={(v) => set({ operator: v as typeof draft.operator })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contains">contains</SelectItem>
                    <SelectItem value="not_contains">doesn't contain</SelectItem>
                    <SelectItem value="equals">equals</SelectItem>
                    <SelectItem value="matches">matches pattern</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="step-value">Value</Label>
                <Input id="step-value" value={draft.value} onChange={(e) => set({ value: e.target.value })} />
              </div>
              <p className="col-span-2 text-xs text-muted-foreground">Connect the "true" and "false" handles to the steps for each outcome.</p>
            </div>
          )}

          {draft.type === "router" && (
            <div className="grid gap-2">
              <Label>Routes</Label>
              <p className="text-xs text-muted-foreground">A model reads the checked text and picks one route. Describe when each applies.</p>
              {draft.routes.map((r, i) => (
                <div key={i} className="grid grid-cols-[110px_1fr_auto] gap-2">
                  <Input aria-label="Route key" className="font-mono text-xs" value={r.key}
                    onChange={(e) => set({ routes: draft.routes.map((x, j) => (j === i ? { ...x, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") } : x)) })} />
                  <Input aria-label="When to take it" value={r.description}
                    onChange={(e) => set({ routes: draft.routes.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} />
                  <Button type="button" size="icon" variant="ghost" aria-label="Remove route" disabled={draft.routes.length <= 2}
                    onClick={() => set({ routes: draft.routes.filter((_, j) => j !== i) })}><X /></Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="justify-self-start"
                onClick={() => set({ routes: [...draft.routes, { key: `route_${draft.routes.length + 1}`, description: "" }] })}>
                <Plus /> Add route
              </Button>
            </div>
          )}

          {draft.type === "output" && (
            <div className="grid gap-1.5">
              <Label htmlFor="step-template">Result</Label>
              <Textarea id="step-template" rows={6} className="font-mono text-xs" value={draft.template} onChange={(e) => set({ template: e.target.value })} />
              <p className="text-xs text-muted-foreground">{HELP}</p>
            </div>
          )}
        </fieldset>
        {!readOnly && (
          <SheetFooter className="flex-row justify-between">
            {onDelete && draft.type !== "start" ? (
              <Button variant="ghost" className="text-destructive" onClick={() => onDelete(draft.id)}><Trash2 /> Delete step</Button>
            ) : <span />}
            <Button onClick={() => onSave(draft)}>Save step</Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
