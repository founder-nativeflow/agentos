import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Lock, Plus, Trash2, Variable } from "lucide-react";
import { toast } from "sonner";
import type { Page, Vault, VaultCredential } from "@agentos/types";
import { PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiRequestError, timeAgo } from "@/lib/api";

export function useVaults() {
  return useQuery({ queryKey: ["vaults"], queryFn: () => api<Page<Vault>>("/v1/vaults?limit=100") });
}

const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

export function VaultsPage() {
  const vaults = useVaults();
  return (
    <>
      <PageHeader
        title="Credential vaults"
        description="Tokens and secrets for MCP servers and APIs. Values are encrypted in Supabase Vault and never shown again."
        actions={<CreateVaultDialog />}
      />
      <div className="grid gap-4">
        {vaults.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {vaults.data?.data.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No vaults yet. Create one, add credentials, then pick it when you start a session.
            </CardContent>
          </Card>
        )}
        {vaults.data?.data.map((v) => <VaultCard key={v.id} vault={v} />)}
      </div>
    </>
  );
}

function VaultCard({ vault: v }: { vault: Vault }) {
  const qc = useQueryClient();
  const creds = useQuery({
    queryKey: ["vaults", v.id, "credentials"],
    queryFn: () => api<Page<VaultCredential>>(`/v1/vaults/${v.id}/credentials?limit=100`),
  });
  const remove = useMutation({
    mutationFn: () => api(`/v1/vaults/${v.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vaults"] });
      toast.success(`Deleted ${v.display_name}`);
    },
    onError: (e) => toast.error(errText(e, "Could not delete the vault.")),
  });
  const removeCred = useMutation({
    mutationFn: (id: string) => api(`/v1/vaults/${v.id}/credentials/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vaults", v.id, "credentials"] }),
    onError: (e) => toast.error(errText(e, "Could not delete the credential.")),
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base"><Lock className="size-4" /> {v.display_name}</CardTitle>
            <CardDescription className="font-mono text-xs">{v.id} · created {timeAgo(v.created_at)}</CardDescription>
          </div>
          <div className="flex gap-2">
            <AddCredentialDialog vaultId={v.id} />
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete vault ${v.display_name}`}
              onClick={() => window.confirm(`Delete "${v.display_name}" and all its credentials? Sessions using it lose access.`) && remove.mutate()}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {creds.data?.data.length === 0 && <p className="text-sm text-muted-foreground">No credentials yet.</p>}
        <div className="grid gap-2">
          {creds.data?.data.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
              {c.auth.type === "static_bearer" ? <KeyRound className="size-4 shrink-0" /> : <Variable className="size-4 shrink-0" />}
              <span className="font-medium">{c.display_name ?? (c.auth.type === "environment_variable" ? c.auth.secret_name : "MCP token")}</span>
              {c.auth.type === "static_bearer" ? (
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{c.auth.mcp_server_url}</span>
              ) : (
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  ${c.auth.secret_name} →{" "}
                  {c.auth.networking.type === "limited" ? c.auth.networking.allowed_hosts.join(", ") : "any allowed host"}
                </span>
              )}
              <Badge variant="outline" className="ml-auto">{c.auth.type === "static_bearer" ? "MCP bearer" : "Env variable"}</Badge>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label="Delete credential"
                onClick={() => window.confirm("Delete this credential? The secret is erased.") && removeCred.mutate(c.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CreateVaultDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api<Vault>("/v1/vaults", { method: "POST", json: { display_name: name.trim() } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vaults"] });
      setOpen(false);
      setName("");
    },
    onError: (e) => setError(errText(e, "Could not create the vault.")),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild><Button><Plus /> Create vault</Button></DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!name.trim()) return setError("Name the vault, e.g. the team or project it's for.");
            create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create vault</DialogTitle>
            <DialogDescription>A vault groups credentials. Sessions get access by vault.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="vault-name">Name</Label>
            <Input id="vault-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Data team" autoFocus />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create vault"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddCredentialDialog({ vaultId }: { vaultId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"static_bearer" | "environment_variable">("static_bearer");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [secretName, setSecretName] = useState("");
  const [hosts, setHosts] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setLabel(""); setUrl(""); setToken(""); setSecretName(""); setHosts(""); setError(null);
  };

  const create = useMutation({
    mutationFn: () => {
      const hostList = hosts.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
      const auth =
        kind === "static_bearer"
          ? { type: "static_bearer", mcp_server_url: url.trim(), token }
          : {
              type: "environment_variable",
              secret_name: secretName.trim(),
              secret_value: token,
              networking: hostList.length ? { type: "limited", allowed_hosts: hostList } : { type: "unrestricted" },
            };
      return api<VaultCredential>(`/v1/vaults/${vaultId}/credentials`, {
        method: "POST",
        json: { display_name: label.trim() || undefined, auth },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vaults", vaultId, "credentials"] });
      setOpen(false);
      reset();
      toast.success("Credential saved");
    },
    onError: (e) => setError(errText(e, "Could not save the credential.")),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (kind === "static_bearer" && !/^https?:\/\/\S+$/.test(url.trim())) return setError("Enter the MCP server's full URL.");
    if (kind === "environment_variable" && !/^[A-Z_][A-Z0-9_]*$/.test(secretName.trim())) {
      return setError("Use an environment variable name like GITHUB_TOKEN (capitals, digits, _).");
    }
    if (!token) return setError(kind === "static_bearer" ? "Paste the token." : "Paste the secret value.");
    setError(null);
    create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Plus /> Add credential</Button></DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add credential</DialogTitle>
            <DialogDescription>The secret is encrypted and can't be viewed again, only replaced.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="static_bearer">MCP server token (bearer)</SelectItem>
                <SelectItem value="environment_variable">Secret for an API (environment variable)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cred-label">Label (optional)</Label>
            <Input id="cred-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "static_bearer" ? "Linear" : "GitHub"} />
          </div>
          {kind === "static_bearer" ? (
            <div className="grid gap-2">
              <Label htmlFor="cred-url">MCP server URL</Label>
              <Input id="cred-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.linear.app/mcp" />
              <p className="text-xs text-muted-foreground">Must match the URL in the agent's MCP servers.</p>
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="cred-name">Variable name</Label>
                <Input id="cred-name" value={secretName} onChange={(e) => setSecretName(e.target.value.toUpperCase())} placeholder="GITHUB_TOKEN" className="font-mono" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cred-hosts">Only send to these hosts</Label>
                <Input id="cred-hosts" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="api.github.com" />
                <p className="text-xs text-muted-foreground">Comma-separated. Leave empty to allow any host the environment allows.</p>
              </div>
            </>
          )}
          <div className="grid gap-2">
            <Label htmlFor="cred-secret">{kind === "static_bearer" ? "Token" : "Secret value"}</Label>
            <Input id="cred-secret" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending ? "Saving…" : "Save credential"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
