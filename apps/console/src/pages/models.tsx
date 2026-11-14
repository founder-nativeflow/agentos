import { useMemo, useState } from "react";
import { Wrench } from "lucide-react";
import { PageHeader } from "@/components/layout";
import { useModels } from "@/components/model-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatContext, formatPricePerMillion } from "@/lib/api";

export function ModelsPage() {
  const models = useModels();
  const [search, setSearch] = useState("");
  const [toolsOnly, setToolsOnly] = useState(false);
  const rows = useMemo(() => {
    const s = search.toLowerCase();
    return (models.data ?? []).filter((m) => (!toolsOnly || m.supports_tools) && (!s || m.id.includes(s) || m.name.toLowerCase().includes(s)));
  }, [models.data, search, toolsOnly]);

  return (
    <>
      <PageHeader title="Models" description="Every model available through OpenRouter. Agents, sub-agents, advisors and graders can use any of them." />
      <div className="mb-4 flex items-center gap-4">
        <Input placeholder="Search models…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
        <div className="flex items-center gap-2">
          <Switch id="m-tools" checked={toolsOnly} onCheckedChange={setToolsOnly} />
          <Label htmlFor="m-tools">Supports tools</Label>
        </div>
        <span className="ml-auto text-sm text-muted-foreground">{rows.length} of {models.data?.length ?? 0}</span>
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Context</TableHead>
              <TableHead>Input / 1M</TableHead>
              <TableHead>Output / 1M</TableHead>
              <TableHead>Tools</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.isLoading && <TableRow><TableCell colSpan={5} className="text-muted-foreground">Loading from OpenRouter…</TableCell></TableRow>}
            {rows.slice(0, 300).map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <div className="font-medium">{m.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{m.id}</div>
                </TableCell>
                <TableCell>{formatContext(m.context_length)}</TableCell>
                <TableCell>{formatPricePerMillion(m.pricing.prompt)}</TableCell>
                <TableCell>{formatPricePerMillion(m.pricing.completion)}</TableCell>
                <TableCell>{m.supports_tools ? <Wrench className="size-4" aria-label="Supports tools" /> : <span className="text-muted-foreground">—</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
