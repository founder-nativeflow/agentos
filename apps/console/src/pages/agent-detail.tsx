import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import type { Agent, Page } from "@agentos/types";
import { PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, timeAgo } from "@/lib/api";
import { PlannedCard } from "./placeholder";
import { CreateSessionDialog, SessionsTable } from "./sessions";

export function AgentDetailPage() {
  const { id = "" } = useParams();
  const agent = useQuery({ queryKey: ["agent", id], queryFn: () => api<Agent>(`/v1/agents/${id}`) });
  const versions = useQuery({ queryKey: ["agent", id, "versions"], queryFn: () => api<Page<Agent>>(`/v1/agents/${id}/versions`) });

  if (agent.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (agent.isError || !agent.data) return <p className="text-sm text-destructive">Agent not found.</p>;
  const a = agent.data;

  return (
    <>
      <Link to="/agents" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> Agents
      </Link>
      <PageHeader title={a.name} description={a.description ?? undefined} />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{a.id}</span>
        <Badge variant="secondary">v{a.version}</Badge>
        {a.archived_at && <Badge variant="destructive">Archived</Badge>}
        <span>Updated {timeAgo(a.updated_at)}</span>
      </div>
      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="observability">Observability</TabsTrigger>
        </TabsList>
        <TabsContent value="config" className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-base">Model</CardTitle></CardHeader>
            <CardContent className="font-mono text-sm">{a.model.id}</CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Tools</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {a.tools.length === 0 && <span className="text-sm text-muted-foreground">None</span>}
              {a.tools.map((t, i) => (
                <Badge key={i} variant="outline" className="font-mono">
                  {"name" in t ? t.name : "mcp_server_name" in t ? `mcp: ${t.mcp_server_name}` : t.type}
                </Badge>
              ))}
            </CardContent>
          </Card>
          {a.mcp_servers.length > 0 && (
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle className="text-base">MCP servers</CardTitle></CardHeader>
              <CardContent className="grid gap-2">
                {a.mcp_servers.map((m) => {
                  const ts = a.tools.find((t) => t.type === "mcp_toolset" && "mcp_server_name" in t && t.mcp_server_name === m.name) as
                    | { default_config?: { permission_policy?: { type: string } } }
                    | undefined;
                  return (
                    <div key={m.name} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{m.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{m.url}</span>
                      <Badge variant="outline" className="ml-auto">
                        {ts ? (ts.default_config?.permission_policy?.type ?? "always_ask").replace("_", " ") : "no toolset"}
                      </Badge>
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground">Tokens come from the credential vaults you pick when starting a session.</p>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle className="text-base">Sub-agents</CardTitle></CardHeader>
            <CardContent className="text-sm">
              {a.multiagent?.subagents?.type === "enabled"
                ? <Badge variant="secondary">Enabled · inline sub-agents</Badge>
                : <span className="text-muted-foreground">Off</span>}
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle className="text-base">System prompt</CardTitle></CardHeader>
            <CardContent><pre className="whitespace-pre-wrap text-sm">{a.system ?? "—"}</pre></CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="raw" className="mt-4">
          <pre className="overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs">{JSON.stringify(a, null, 2)}</pre>
        </TabsContent>
        <TabsContent value="versions" className="mt-4 grid gap-2">
          {versions.data?.data.map((v) => (
            <div key={v.version} className="flex items-center justify-between rounded-md border px-4 py-2 text-sm">
              <span>v{v.version} {v.version === a.version && <Badge variant="secondary" className="ml-2">Latest</Badge>}</span>
              <span className="font-mono text-xs text-muted-foreground">{v.model.id}</span>
              <span className="text-muted-foreground">{timeAgo(v.updated_at)}</span>
            </div>
          ))}
        </TabsContent>
        <TabsContent value="sessions" className="mt-4 grid gap-3"><div className="flex justify-end"><CreateSessionDialog agentId={a.id} /></div><SessionsTable agentId={a.id} /></TabsContent>
        <TabsContent value="observability" className="mt-4"><PlannedCard what="Observability" phase="Phase 3" /></TabsContent>
      </Tabs>
    </>
  );
}
