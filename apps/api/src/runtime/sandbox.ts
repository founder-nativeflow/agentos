import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Environment } from "@agentos/types";
import { SESSIONS_DIR } from "../lib/paths.js";
import { E2BSandbox } from "./e2b.js";

/**
 * How the sandbox reaches the network: "bridge" (direct, unrestricted) or the
 * internal sandbox network whose only exit is the egress proxy.
 */
export interface SandboxNetwork {
  network: string;
  env: Record<string, string>;
  /** CA the sandbox must trust for HTTPS the proxy intercepts (secret injection). */
  caPem?: string;
}

/** A host file copied into the sandbox when it starts (session `resources`). */
export interface SandboxMount {
  hostPath: string;
  mountPath: string;
}

/**
 * One sandbox per session. Phase 1 ships the local Docker provider; cloud
 * providers (E2B, Railway Sandboxes) implement the same interface in Phase 2.
 */
export interface Sandbox {
  exec(command: string, opts?: { stdin?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ExecResult>;
  destroy(): Promise<void>;
  /** Host folder that mirrors /mnt/session/outputs. */
  outputsDir: string;
  /** Brings /mnt/session/outputs down to outputsDir (no-op where it is bind-mounted). */
  syncOutputs?(): Promise<void>;
}

/** Which sandbox provider this API process uses: local Docker (default) or E2B. */
export const SANDBOX_PROVIDER: "docker" | "e2b" = process.env.AGENTOS_SANDBOX_PROVIDER === "e2b" ? "e2b" : "docker";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_IMAGE = process.env.AGENTOS_SANDBOX_IMAGE ?? "python:3.12-slim";
const MAX_OUTPUT = 100_000;

function run(args: string[], opts: { stdin?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  return new Promise((done) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, add: Buffer) => (s.length < MAX_OUTPUT ? s + add.toString() : s);
    child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const trunc = (s: string) => (s.length >= MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[output truncated]` : s);
      done({ stdout: trunc(stdout), stderr: trunc(stderr), exitCode: code ?? -1, timedOut });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

export class DockerSandbox implements Sandbox {
  readonly name: string;
  readonly outputsDir: string;
  private ready: Promise<void> | null = null;

  constructor(
    private sessionId: string,
    private env: Environment,
    private mounts: SandboxMount[] = [],
    private net: SandboxNetwork = { network: "bridge", env: {} },
  ) {
    this.name = `agentos-${sessionId.toLowerCase()}`;
    this.outputsDir = resolve(SESSIONS_DIR, sessionId, "outputs");
  }

  /** Starts (or reuses) the session container and installs environment packages once. */
  private ensure(): Promise<void> {
    this.ready ??= (async () => {
      const exists = await run(["inspect", "-f", "{{.State.Running}}", this.name]);
      if (exists.exitCode === 0) {
        if (exists.stdout.trim() !== "true") await run(["start", this.name]);
        return;
      }
      mkdirSync(this.outputsDir, { recursive: true });
      // "bridge" = direct internet; otherwise the internal network behind the egress proxy.
      const envArgs = Object.entries(this.net.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const res = await run([
        "run", "-d", "--name", this.name,
        "--label", "agentos.session=" + this.sessionId,
        "--network", this.net.network,
        ...envArgs,
        "--memory", "2g", "--cpus", "2", "--pids-limit", "512",
        "-v", `${this.outputsDir}:/mnt/session/outputs`,
        "-w", "/workspace",
        DEFAULT_IMAGE, "sleep", "infinity",
      ], { timeoutMs: 180_000 });
      if (res.exitCode !== 0) throw new Error(`Could not start sandbox: ${res.stderr.trim() || res.stdout.trim()}`);
      await run(["exec", this.name, "mkdir", "-p", "/workspace", "/mnt/session/uploads"]);
      if (this.net.caPem) {
        // Trust the AgentOS egress CA (system store; tools also read the env vars set at start).
        const caFile = resolve(SESSIONS_DIR, this.sessionId, "agentos-egress-ca.crt");
        writeFileSync(caFile, this.net.caPem);
        await run(["cp", caFile, `${this.name}:/usr/local/share/ca-certificates/agentos-egress.crt`]);
        const upd = await run(["exec", this.name, "sh", "-c",
          "update-ca-certificates >/dev/null 2>&1 || cat /usr/local/share/ca-certificates/agentos-egress.crt >> /etc/ssl/certs/ca-certificates.crt"]);
        if (upd.exitCode !== 0) throw new Error(`Could not install the egress CA: ${upd.stderr.trim()}`);
      }
      for (const m of this.mounts) {
        await run(["exec", this.name, "mkdir", "-p", dirname(m.mountPath)]);
        const cp = await run(["cp", m.hostPath, `${this.name}:${m.mountPath}`]);
        if (cp.exitCode !== 0) throw new Error(`Could not copy ${m.mountPath} into the sandbox: ${cp.stderr.trim()}`);
      }
      await this.installPackages();
    })();
    return this.ready;
  }

  private async installPackages() {
    const p = this.env.config.packages ?? {};
    const steps: string[] = [];
    if (p.apt?.length) steps.push(`apt-get update -qq && apt-get install -y -qq ${p.apt.join(" ")}`);
    if (p.pip?.length) steps.push(`pip install -q ${p.pip.join(" ")}`);
    if (p.npm?.length) steps.push(`(command -v npm >/dev/null || (apt-get update -qq && apt-get install -y -qq nodejs npm)) && npm install -g ${p.npm.join(" ")}`);
    for (const step of steps) {
      const r = await run(["exec", this.name, "bash", "-lc", step], { timeoutMs: 600_000 });
      if (r.exitCode !== 0) throw new Error(`Package install failed: ${r.stderr.slice(-2000)}`);
    }
  }

  async exec(command: string, opts: { stdin?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
    await this.ensure();
    const args = ["exec", ...(opts.stdin !== undefined ? ["-i"] : []), "-w", "/workspace", this.name, "bash", "-lc", command];
    return run(args, { stdin: opts.stdin, timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal });
  }

  async destroy(): Promise<void> {
    await run(["rm", "-f", this.name]);
    this.ready = null;
  }
}

/** Keeps one sandbox object per session for the life of the API process. */
const sandboxes = new Map<string, Sandbox>();

export function sandboxFor(sessionId: string, env: Environment, mounts: SandboxMount[] = [], net?: SandboxNetwork): Sandbox {
  let sb = sandboxes.get(sessionId);
  if (!sb) {
    sb = SANDBOX_PROVIDER === "e2b" ? new E2BSandbox(sessionId, env, mounts, net) : new DockerSandbox(sessionId, env, mounts, net);
    sandboxes.set(sessionId, sb);
  }
  return sb;
}

export async function destroySandbox(sessionId: string): Promise<void> {
  const sb = sandboxes.get(sessionId);
  if (sb) await sb.destroy();
  else if (SANDBOX_PROVIDER === "e2b") await new E2BSandbox(sessionId, { config: {} } as Environment).destroy();
  else await run(["rm", "-f", `agentos-${sessionId.toLowerCase()}`]);
  sandboxes.delete(sessionId);
}

/** Syncs a session's outputs to the host (E2B); Docker outputs are already there. */
export async function syncSandboxOutputs(sessionId: string): Promise<void> {
  await sandboxes.get(sessionId)?.syncOutputs?.();
}
