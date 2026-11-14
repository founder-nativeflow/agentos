import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, CircleHelp, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import type { ProviderSettings } from "@agentos/types";
import { PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiRequestError, timeAgo } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Model provider, API keys and members." />
      <div className="grid gap-6 lg:max-w-3xl">
        <ProviderCard />
        <ApiKeysCard />
      </div>
    </>
  );
}

function StatusBadge({ s }: { s: ProviderSettings }) {
  if (!s.configured) return <Badge variant="outline"><CircleHelp className="size-3" /> Not configured</Badge>;
  if (s.status === "valid") return <Badge className="bg-emerald-600 text-white"><CheckCircle2 className="size-3" /> Valid</Badge>;
  if (s.status === "invalid") return <Badge variant="destructive"><CircleAlert className="size-3" /> Invalid</Badge>;
  return <Badge variant="secondary">Unknown</Badge>;
}

function ProviderCard() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["provider"], queryFn: () => api<ProviderSettings>("/v1/x/providers/openrouter") });
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api<ProviderSettings>("/v1/x/providers/openrouter", { method: "PUT", json: { api_key: key } }),
    onSuccess: (s) => {
      qc.setQueryData(["provider"], s);
      setKey("");
      if (s.status === "invalid") setError("OpenRouter rejected this key. Check it and try again.");
    },
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : "Could not save the key."),
  });
  const test = useMutation({
    mutationFn: () => api<ProviderSettings>("/v1/x/providers/openrouter/test", { method: "POST" }),
    onSuccess: (s) => qc.setQueryData(["provider"], s),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!key.trim().startsWith("sk-or-")) return setError("OpenRouter keys start with sk-or-.");
    setError(null);
    save.mutate();
  }

  const s = settings.data;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Model provider: OpenRouter</CardTitle>
          {s && <StatusBadge s={s} />}
        </div>
        <CardDescription>
          One OpenRouter API key unlocks every OpenRouter model for your agents. It's stored only on this machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {s?.configured && (
          <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
            <span className="font-mono">{s.key_hint}</span>
            <span className="text-muted-foreground">{s.last_checked_at ? `Checked ${timeAgo(s.last_checked_at)}` : "Not checked"}</span>
            <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
              {test.isPending ? "Testing…" : "Test connection"}
            </Button>
          </div>
        )}
        <form onSubmit={submit} className="grid gap-2">
          <Label htmlFor="or-key">{s?.configured ? "Replace key" : "OpenRouter API key"}</Label>
          <div className="flex gap-2">
            <Input id="or-key" type="password" placeholder="sk-or-…" value={key} onChange={(e) => { setKey(e.target.value); setError(null); }} />
            <Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save & test"}</Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

type ApiKey = { type: "api_key"; id: string; name: string; hint: string; created_at: string };

function ApiKeysCard() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["api_keys"], queryFn: () => api<{ data: ApiKey[] }>("/v1/x/api_keys") });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/x/api_keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api_keys"] });
      toast.success("API key revoked");
    },
    onError: (e) => toast.error(e instanceof ApiRequestError ? e.message : "Could not revoke the key."),
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>API keys</CardTitle>
          <CreateKeyDialog />
        </div>
        <CardDescription>
          Use a key with the Anthropic SDK (<span className="font-mono">baseURL: "http://localhost:4000"</span>) or the{" "}
          <span className="font-mono">agentos</span> CLI. Keys are shown once; only a hash is stored.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.data?.data.length === 0 && (
              <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">No API keys.</TableCell></TableRow>
            )}
            {keys.data?.data.map((k) => (
              <TableRow key={k.id}>
                <TableCell className="font-medium">{k.name}</TableCell>
                <TableCell className="font-mono text-xs">{k.hint}</TableCell>
                <TableCell className="text-muted-foreground">{timeAgo(k.created_at)}</TableCell>
                <TableCell>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Revoke ${k.name}`}
                    disabled={revoke.isPending}
                    onClick={() => {
                      if (window.confirm(`Revoke "${k.name}"? Anything using this key stops working immediately.`)) revoke.mutate(k.id);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function CreateKeyDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api<ApiKey & { key: string }>("/v1/x/api_keys", { method: "POST", json: { name } }),
    onSuccess: (k) => {
      setCreated(k.key);
      qc.invalidateQueries({ queryKey: ["api_keys"] });
    },
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : "Could not create the key."),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the key a name, e.g. the app that will use it.");
    setError(null);
    create.mutate();
  }

  function onOpenChange(o: boolean) {
    setOpen(o);
    if (!o) {
      setName("");
      setCreated(null);
      setError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild><Button size="sm"><Plus /> Create key</Button></DialogTrigger>
      <DialogContent>
        {created ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><KeyRound className="size-4" /> Copy your new key</DialogTitle>
              <DialogDescription>This is the only time it's shown. Store it somewhere safe.</DialogDescription>
            </DialogHeader>
            <div className="flex gap-2">
              <Input readOnly value={created} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button
                type="button"
                variant="outline"
                onClick={() => navigator.clipboard.writeText(created).then(() => toast.success("Copied"))}
              >
                <Copy /> Copy
              </Button>
            </div>
            <DialogFooter><Button onClick={() => onOpenChange(false)}>Done</Button></DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>Keys have full access to this AgentOS workspace.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. my-app" autoFocus />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create key"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
