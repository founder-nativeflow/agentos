import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PageHeader } from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgents } from "./agents";
import { useModels } from "@/components/model-picker";

function lastDays(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() - (n - 1 - i) * 86_400_000);
    return { day: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), sessions: 0 };
  });
}

export function OverviewPage() {
  const agents = useAgents();
  const models = useModels();
  const kpis = [
    { label: "Agents", value: agents.data?.data.length ?? "–", hint: "Active" },
    { label: "Sessions", value: 0, hint: "Last 30 days (Phase 1)" },
    { label: "Error rate", value: "—", hint: "Last 30 days" },
    { label: "Models available", value: models.data?.length ?? "–", hint: "Via OpenRouter" },
  ];
  return (
    <>
      <PageHeader title="Overview" description="How your agents are doing in this workspace." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardHeader className="pb-2">
              <CardDescription>{k.label}</CardDescription>
              <CardTitle className="text-3xl">{k.value}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">{k.hint}</CardContent>
          </Card>
        ))}
      </div>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Sessions over time</CardTitle>
          <CardDescription>Sessions started each day in the last 30 days. Fills in once sessions run (Phase 1).</CardDescription>
        </CardHeader>
        <CardContent className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={lastDays(30)}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={11} interval={4} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} width={24} />
              <Tooltip />
              <Bar dataKey="sessions" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </>
  );
}
