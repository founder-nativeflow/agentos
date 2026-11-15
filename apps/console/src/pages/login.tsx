import { useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiRequestError } from "@/lib/api";

/** Local mode: the admin from `agentos init`. Supabase mode: email accounts, with sign-up. */
export function LoginPage() {
  const mode = useQuery({ queryKey: ["auth-mode"], queryFn: () => api<{ mode: "local" | "supabase"; signup: boolean }>("/v1/x/auth/mode") });
  const cloud = mode.data?.mode === "supabase";
  const [signup, setSignup] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username || !password) return setError(cloud ? "Enter your email and password." : "Enter your username and password.");
    if (signup && password.length < 10) return setError("Use a password of at least 10 characters.");
    setBusy(true);
    setError(null);
    try {
      if (signup) {
        const r = await api<{ needs_confirmation: boolean }>("/v1/x/auth/signup", {
          method: "POST",
          json: { email: username, password, workspace_name: workspace || undefined },
        });
        if (r.needs_confirmation) {
          setNotice("Check your email to confirm your account, then sign in.");
          setSignup(false);
          return;
        }
      } else {
        await api("/v1/x/auth/login", { method: "POST", json: cloud ? { email: username, password } : { username, password } });
      }
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate((location.state as { from?: string } | null)?.from ?? "/overview", { replace: true });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not reach the AgentOS API.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mb-2 grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Cpu className="size-5" />
          </div>
          <CardTitle className="text-xl">{signup ? "Create your AgentOS account" : "Sign in to AgentOS"}</CardTitle>
          <CardDescription>
            {cloud ? (signup ? "You'll get your own workspace; invite your team later." : "Sign in with your email.") : "Use the admin account created by `agentos init`."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="username">{cloud ? "Email" : "Username"}</Label>
              <Input id="username" type={cloud ? "email" : "text"} autoComplete={cloud ? "email" : "username"} value={username}
                onChange={(e) => { setUsername(e.target.value); setError(null); }} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete={signup ? "new-password" : "current-password"} value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }} />
            </div>
            {signup && (
              <div className="grid gap-2">
                <Label htmlFor="ws">Workspace name (optional)</Label>
                <Input id="ws" value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="Acme" />
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {notice && <p className="text-sm text-emerald-600">{notice}</p>}
            <Button type="submit" disabled={busy}>{busy ? "Please wait…" : signup ? "Create account" : "Sign in"}</Button>
            {cloud && mode.data?.signup && (
              <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => { setSignup(!signup); setError(null); }}>
                {signup ? "Already have an account? Sign in" : "New here? Create an account"}
              </button>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
