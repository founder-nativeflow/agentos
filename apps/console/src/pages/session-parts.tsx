import type { Session } from "@agentos/types";
import { Badge } from "@/components/ui/badge";

export function formatUsd(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "–";
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function StatusBadge({ session }: { session: Session }) {
  const s = session.status;
  const stop = session.stop_reason?.type;
  if (s === "running") return <Badge className="bg-blue-600 text-white">Running</Badge>;
  if (s === "terminated") return <Badge variant="outline">Terminated</Badge>;
  if (stop === "requires_action") return <Badge className="bg-amber-500 text-white">Needs action</Badge>;
  if (stop === "budget_reached") return <Badge variant="destructive">Budget reached</Badge>;
  if (stop === "retries_exhausted") return <Badge variant="destructive">Error</Badge>;
  return <Badge variant="secondary">Idle</Badge>;
}
