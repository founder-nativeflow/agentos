import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import forge from "node-forge";
import { AGENTOS_HOME } from "../lib/paths.js";

/**
 * Manages the egress proxy container for this AgentOS install: its CA, the
 * bundled proxy code, the internal sandbox network, and per-session rules.
 * Names are derived from AGENTOS_HOME, so a test run and the dev API never share
 * a proxy.
 */

export interface EgressRules {
  session_id: string;
  allowed: string[] | null;
  injections: Array<{ placeholder: string; value: string; hosts: string[] | null; header: boolean; body: boolean }>;
}

const DIR = resolve(AGENTOS_HOME, "egress");
const SUFFIX = createHash("sha256").update(AGENTOS_HOME).digest("hex").slice(0, 8);
export const EGRESS_CONTAINER = `agentos-egress-${SUFFIX}`;
export const SANDBOX_NETWORK = `agentos-sbx-${SUFFIX}`;
const IMAGE = process.env.AGENTOS_EGRESS_IMAGE ?? "node:22-alpine";
const PROXY_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "proxy.ts");

/** Hosts opened by `allow_package_managers`. */
export const PACKAGE_MANAGER_HOSTS = [
  "pypi.org", "files.pythonhosted.org",
  "registry.npmjs.org", "registry.yarnpkg.com",
  "deb.debian.org", "security.debian.org", "archive.ubuntu.com", "security.ubuntu.com", "dl-cdn.alpinelinux.org",
  "crates.io", "index.crates.io", "static.crates.io",
  "proxy.golang.org", "sum.golang.org", "rubygems.org",
];

function docker(args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn("docker", args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(t);
      done({ code: code ?? -1, out: out.trim(), err: err.trim() });
    });
  });
}

function secretFile(): string {
  mkdirSync(DIR, { recursive: true });
  const f = resolve(DIR, "secret");
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 });
  return readFileSync(f, "utf8").trim();
}

/** Creates the AgentOS egress CA once per install. */
function ensureCa() {
  const pem = resolve(DIR, "ca.pem");
  const key = resolve(DIR, "ca.key");
  if (existsSync(pem) && existsSync(key)) return;
  const kp = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(kp.publicKey);
  cert.serialNumber = "01" + randomBytes(15).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const subject = [
    { name: "commonName", value: `AgentOS egress CA (${SUFFIX})` },
    { name: "organizationName", value: "AgentOS local" },
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(kp.privateKey), forge.md.sha256.create());
  writeFileSync(key, kp.privateKey, { mode: 0o600 });
  writeFileSync(pem, forge.pki.certificateToPem(cert));
}

async function bundleProxy() {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [PROXY_SRC],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: resolve(DIR, "proxy.cjs"),
    logLevel: "silent",
  });
}

/**
 * Remote mode (cloud): the proxy runs as its own service. Configure with
 * AGENTOS_EGRESS_ADMIN_URL + AGENTOS_EGRESS_ADMIN_SECRET (admin API),
 * AGENTOS_EGRESS_PUBLIC_ADDR (host:port sandboxes connect to) and
 * AGENTOS_EGRESS_CA_PEM (the proxy's CA certificate, PEM).
 */
const REMOTE_ADMIN = process.env.AGENTOS_EGRESS_ADMIN_URL ?? null;

class EgressManager {
  private ready: Promise<string> | null = null;
  private readonly secret = REMOTE_ADMIN ? (process.env.AGENTOS_EGRESS_ADMIN_SECRET ?? "") : secretFile();

  /** host:port that sandboxes outside this machine (E2B) use to reach the proxy. */
  publicAddress(): string | null {
    return process.env.AGENTOS_EGRESS_PUBLIC_ADDR ?? null;
  }

  /** PEM of the CA that sandboxes trust for intercepted HTTPS. */
  caPem(): string {
    if (REMOTE_ADMIN) return (process.env.AGENTOS_EGRESS_CA_PEM ?? "").replace(/\\n/g, "\n");
    ensureCa();
    return readFileSync(resolve(DIR, "ca.pem"), "utf8");
  }

  /** Per-session proxy credential (stable across API restarts). */
  token(sessionId: string): string {
    return createHmac("sha256", this.secret).update(`token:${sessionId}`).digest("base64url").slice(0, 32);
  }

  /** What the sandbox sees instead of a secret value. */
  placeholder(sessionId: string, credentialId: string): string {
    return `aos_ph_${createHmac("sha256", this.secret).update(`ph:${sessionId}:${credentialId}`).digest("hex").slice(0, 32)}`;
  }

  proxyUrl(sessionId: string): string {
    return `http://s:${this.token(sessionId)}@${this.publicAddress() ?? "egress:3128"}`;
  }

  /** Starts (once per API process) a fresh proxy container with the current code. Returns the admin URL. */
  ensure(): Promise<string> {
    if (REMOTE_ADMIN) return Promise.resolve(REMOTE_ADMIN.replace(/\/$/, ""));
    this.ready ??= (async () => {
      ensureCa();
      await bundleProxy();
      const extraCa = process.env.AGENTOS_EGRESS_UPSTREAM_CA;
      if (extraCa) copyFileSync(extraCa, resolve(DIR, "upstream-ca.pem"));

      const net = await docker(["network", "inspect", SANDBOX_NETWORK]);
      if (net.code !== 0) {
        const created = await docker(["network", "create", "--internal", "--label", `agentos.home=${AGENTOS_HOME}`, SANDBOX_NETWORK]);
        if (created.code !== 0) throw new Error(`Could not create the sandbox network: ${created.err}`);
      }
      await docker(["rm", "-f", EGRESS_CONTAINER]);
      const run = await docker([
        "run", "-d", "--name", EGRESS_CONTAINER,
        "--label", `agentos.home=${AGENTOS_HOME}`, "--label", "agentos.role=egress",
        "--add-host", "host.docker.internal:host-gateway",
        "-p", "127.0.0.1::3129",
        "-e", `EGRESS_ADMIN_SECRET=${this.secret}`,
        "-e", "EGRESS_CA_DIR=/egress",
        ...(extraCa ? ["-e", "NODE_EXTRA_CA_CERTS=/egress/upstream-ca.pem"] : []),
        "-v", `${DIR}:/egress:ro`,
        "--memory", "256m",
        IMAGE, "node", "/egress/proxy.cjs",
      ], 300_000);
      if (run.code !== 0) throw new Error(`Could not start the egress proxy: ${run.err}`);
      const conn = await docker(["network", "connect", "--alias", "egress", SANDBOX_NETWORK, EGRESS_CONTAINER]);
      if (conn.code !== 0) throw new Error(`Could not attach the egress proxy: ${conn.err}`);
      const port = await docker(["port", EGRESS_CONTAINER, "3129/tcp"]);
      const hostPort = port.out.split("\n")[0]?.split(":").pop();
      if (!hostPort) throw new Error("Could not find the egress proxy's admin port");
      const url = `http://127.0.0.1:${hostPort}`;
      for (let i = 0; i < 80; i++) {
        const ok = await fetch(`${url}/health`).then((r) => r.ok).catch(() => false);
        if (ok) return url;
        await new Promise((r) => setTimeout(r, 250));
      }
      const logs = await docker(["logs", "--tail", "20", EGRESS_CONTAINER]);
      throw new Error(`The egress proxy did not become healthy: ${logs.out} ${logs.err}`);
    })();
    this.ready.catch(() => (this.ready = null));
    return this.ready;
  }

  async push(sessionId: string, rules: EgressRules): Promise<void> {
    const url = await this.ensure();
    const res = await fetch(`${url}/sessions/${this.token(sessionId)}`, {
      method: "PUT",
      headers: { "x-admin-secret": this.secret, "content-type": "application/json" },
      body: JSON.stringify(rules),
    }).catch((e: Error) => {
      // The container may have been removed; start a new one next time.
      this.ready = null;
      throw e;
    });
    if (!res.ok) throw new Error(`Egress proxy rejected the session rules (${res.status})`);
  }

  async remove(sessionId: string): Promise<void> {
    if (!this.ready) return;
    const url = await this.ready.catch(() => null);
    if (!url) return;
    await fetch(`${url}/sessions/${this.token(sessionId)}`, { method: "DELETE", headers: { "x-admin-secret": this.secret } }).catch(() => {});
  }
}

export const egress = new EgressManager();
