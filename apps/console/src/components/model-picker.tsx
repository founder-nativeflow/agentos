import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Wrench } from "lucide-react";
import type { OpenRouterModel } from "@agentos/types";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { api, formatContext, formatPricePerMillion } from "@/lib/api";
import { cn } from "@/lib/utils";

export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => api<{ data: OpenRouterModel[] }>("/v1/x/models").then((r) => r.data),
    staleTime: 10 * 60_000,
  });
}

/** OpenRouter model picker: search, "supports tools" filter, price and context per model. */
export function ModelPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const models = useModels();
  const [search, setSearch] = useState("");
  const [toolsOnly, setToolsOnly] = useState(true);

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    return (models.data ?? []).filter(
      (m) => (!toolsOnly || m.supports_tools) && (!s || m.id.toLowerCase().includes(s) || m.name.toLowerCase().includes(s)),
    );
  }, [models.data, search, toolsOnly]);

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-3 border-b p-2">
        <Input placeholder="Search OpenRouter models…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8" />
        <div className="flex shrink-0 items-center gap-2">
          <Switch id="tools-only" checked={toolsOnly} onCheckedChange={setToolsOnly} />
          <Label htmlFor="tools-only" className="text-xs">Supports tools</Label>
        </div>
      </div>
      <ScrollArea className="h-56">
        {models.isLoading && <p className="p-3 text-sm text-muted-foreground">Loading models from OpenRouter…</p>}
        {models.isError && <p className="p-3 text-sm text-destructive">Could not load the model catalog.</p>}
        {filtered.map((m) => (
          <button
            type="button"
            key={m.id}
            onClick={() => onChange(m.id)}
            className={cn(
              "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent",
              value === m.id && "bg-accent",
            )}
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{m.name}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">{m.id}</span>
            </span>
            <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              {m.supports_tools && <Wrench className="size-3.5" aria-label="Supports tools" />}
              <span>{formatContext(m.context_length)}</span>
              <span>{formatPricePerMillion(m.pricing.prompt)} / {formatPricePerMillion(m.pricing.completion)}</span>
              {value === m.id && <Check className="size-4 text-foreground" />}
            </span>
          </button>
        ))}
        {models.data && filtered.length === 0 && <p className="p-3 text-sm text-muted-foreground">No models match.</p>}
      </ScrollArea>
      <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">Prices per 1M tokens (input / output). {filtered.length} models shown.</p>
    </div>
  );
}
