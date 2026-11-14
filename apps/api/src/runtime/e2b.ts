import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ALL_TRAFFIC, CommandExitError, Sandbox as E2B, type SandboxNetworkOpts } from "e2b";
import type { Environment } from "@agentos/types";
import { SESSIONS_DIR } from "../lib/paths.js";
import type { ExecResult, Sandbox, SandboxMount, SandboxNetwork } from "./sandbox.js";

/**
 * Cloud sandbox on E2B (Firecracker microVMs). Same interface as the Docker
 * sandbox; selected with AGENTOS_SANDBOX_PROVIDER=e2b (needs E2B_API_KEY).
 *
 * Networking:
 *  - unrestricted, no secrets      → E2B default (internet on)
 *  - limited, no secrets           → E2B's own allow-list (allowOut + deny all)
 *  - proxy (secrets / full rules)  → only the AgentOS egress proxy is reachable
 *                                    (AGENTOS_EGRESS_PUBLIC_ADDR), which applies
 *                                    the same rules and injection as locally.
 */

const TEMPLATE = process.env.AGENTOS_E2B_TEMPLATE ?? "base";
const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_OUTPUT = 100_000;

export interface E2BNetwork extends SandboxNetwork {
  /** E2B-native network rules (allow-list), when not routing through the egress proxy. */
  e2b?: SandboxNetworkOpts;
}

/** E2B network options for an environment's rules. */
export function e2bNetworkFor(allowed: string[] | null, proxyHost: string | null): SandboxNetworkOpts | undefined {
  if (proxyHost) return { allowOut: [proxyHost], denyOut: [ALL_TRAFFIC] };
  if (allowed === null) return undefined;
  return allowed.length ? { allowOut: allowed, denyOut: [ALL_TRAFFIC] } : { denyOut: [ALL_TRAFFIC] };
}

const trunc = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[output truncated]` : s);

export class E2BSandbox implements Sandbox {
  readonly outputsDir: string;
  private sb: Promise<E2B> | null = null;

  constructor(
    private sessionId: string,
    private env: Environment,
    private mounts: SandboxMount[] = [],
    private net: E2BNetwork = { network: "e2b", env: {} },
  ) {
    this.outputsDir = resolve(SESSIONS_DIR, sessionId, "outputs");
  }

  /** Reconnects to this session's sandbox (it survives API restarts) or creates it. */
  private ensure(): Promise<E2B> {
    this.sb ??= (async () => {
      const found = await E2B.list({ query: { metadata: { agentos_session: this.sessionId }, state: ["running", "paused"] } }).nextItems();
      if (found[0]) {
        const sb = await E2B.connect(found[0].sandboxId, { timeoutMs: SANDBOX_TIMEOUT_MS });
        return sb;
      }
      const sb = await E2B.create(TEMPLATE, {
        metadata: { agentos_session: this.sessionId },
        envs: this.net.env,
        timeoutMs: SANDBOX_TIMEOUT_MS,
        ...(this.net.e2b ? { network: this.net.e2b } : {}),
      });
      const root = { user: "root" as const, timeoutMs: 120_000 };
      await sb.commands.run("mkdir -p /workspace /mnt/session/outputs /mnt/session/uploads && chmod 777 /workspace /mnt/session/outputs", root);
      for (const m of this.mounts) {
        await sb.commands.run(`mkdir -p ${JSON.stringify(posix.dirname(m.mountPath))}`, root);
        const bytes = readFileSync(m.hostPath);
        await sb.files.write(m.mountPath, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { user: "root" });
      }
      if (this.net.caPem) {
        await sb.files.write("/usr/local/share/ca-certificates/agentos-egress.crt", this.net.caPem, { user: "root" });
        await sb.commands.run("update-ca-certificates >/dev/null 2>&1 || cat /usr/local/share/ca-certificates/agentos-egress.crt >> /etc/ssl/certs/ca-certificates.crt", root);
      }
      const p = this.env.config.packages ?? {};
      const steps: string[] = [];
      if (p.apt?.length) steps.push(`apt-get update -qq && apt-get install -y -qq ${p.apt.join(" ")}`);
      if (p.pip?.length) steps.push(`pip install -q ${p.pip.join(" ")}`);
      if (p.npm?.length) steps.push(`npm install -g ${p.npm.join(" ")}`);
      for (const step of steps) {
        try {
          await sb.commands.run(step, { user: "root", timeoutMs: 600_000 });
        } catch (err) {
          throw new Error(`Package install failed: ${err instanceof CommandExitError ? err.stderr.slice(-2000) : (err as Error).message}`);
        }
      }
      return sb;
    })();
    this.sb.catch(() => (this.sb = null));
    return this.sb;
  }

  async exec(command: string, opts: { stdin?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
    const sb = await this.ensure();
    void sb.setTimeout(SANDBOX_TIMEOUT_MS).catch(() => {});
    let cmd = command;
    let stdinFile: string | null = null;
    if (opts.stdin !== undefined) {
      stdinFile = `/tmp/agentos-stdin-${randomBytes(6).toString("hex")}`;
      await sb.files.write(stdinFile, opts.stdin, { user: "root" });
      cmd = `(${command}) < ${stdinFile}; __rc=$?; rm -f ${stdinFile}; exit $__rc`;
    }
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const handle = await sb.commands.run(`cd /workspace && ${cmd}`, {
      background: true,
      user: "root",
      timeoutMs: timeoutMs + 5_000,
      onStdout: (d) => void (stdout.length < MAX_OUTPUT && (stdout += d)),
      onStderr: (d) => void (stderr.length < MAX_OUTPUT && (stderr += d)),
    });
    const kill = () => void handle.kill().catch(() => {});
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    opts.signal?.addEventListener("abort", kill, { once: true });
    try {
      const res = await handle.wait();
      return { stdout: trunc(res.stdout || stdout), stderr: trunc(res.stderr || stderr), exitCode: res.exitCode, timedOut };
    } catch (err) {
      if (err instanceof CommandExitError) {
        return { stdout: trunc(err.stdout || stdout), stderr: trunc(err.stderr || stderr), exitCode: err.exitCode, timedOut };
      }
      return { stdout: trunc(stdout), stderr: trunc(stderr || (err as Error).message), exitCode: -1, timedOut };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
    }
  }

  /** Copies /mnt/session/outputs down to the host so outputs become Files, as with Docker. */
  async syncOutputs(): Promise<void> {
    if (!this.sb) return;
    const sb = await this.sb.catch(() => null);
    if (!sb) return;
    const entries = await sb.files.list("/mnt/session/outputs", { depth: 10 }).catch(() => []);
    for (const e of entries) {
      if (e.type !== "file") continue;
      const rel = posix.relative("/mnt/session/outputs", e.path);
      if (rel.startsWith("..")) continue;
      const bytes = await sb.files.read(e.path, { format: "bytes" });
      const dest = resolve(this.outputsDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
    }
  }

  async destroy(): Promise<void> {
    const sb = this.sb ? await this.sb.catch(() => null) : null;
    this.sb = null;
    if (sb) await sb.kill().catch(() => {});
    else {
      const found = await E2B.list({ query: { metadata: { agentos_session: this.sessionId } } }).nextItems().catch(() => []);
      for (const f of found) await E2B.kill(f.sandboxId).catch(() => {});
    }
  }
}
