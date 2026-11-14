/**
 * AgentOS egress proxy. Runs in its own container (bundled by egress/manager.ts).
 *
 * Sandboxes that need network rules sit on an internal Docker network whose only
 * way out is this proxy. Every request carries a per-session token (in the proxy
 * URL's user info), which selects that session's rules:
 *   - allowed: host allow-list (null = any host)
 *   - injections: placeholder → secret swaps for vault `environment_variable`
 *     credentials, applied only to hosts the credential allows.
 * HTTPS to a host that has injections is decrypted with the AgentOS CA (which the
 * sandbox trusts) so headers/body can be rewritten; all other HTTPS is tunnelled
 * untouched. The real secret never enters the sandbox.
 *
 * Ports: 3128 proxy, 3129 admin (config push from the API, bound to 127.0.0.1 on the host).
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import forge from "node-forge";

interface Injection {
  placeholder: string;
  value: string;
  /** null = any host the session may reach */
  hosts: string[] | null;
  header: boolean;
  body: boolean;
}
interface SessionRules {
  session_id: string;
  allowed: string[] | null;
  injections: Injection[];
}

const ADMIN_SECRET = process.env.EGRESS_ADMIN_SECRET ?? "";
const CA_DIR = process.env.EGRESS_CA_DIR ?? "/egress";
const MAX_BODY = 20 * 1024 * 1024;

const rules = new Map<string, SessionRules>();
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

/* ------------------------------------------------------------ host rules */

/** `api.github.com`, `*.example.com`, optionally with `:port`. */
export function hostMatches(pattern: string, host: string, port: number): boolean {
  const [pHost, pPort] = pattern.toLowerCase().split(":");
  if (pPort && Number(pPort) !== port) return false;
  const h = host.toLowerCase();
  if (pHost!.startsWith("*.")) return h.endsWith(pHost!.slice(1)) && h.length > pHost!.length - 1;
  return h === pHost;
}

function allowed(r: SessionRules, host: string, port: number): boolean {
  return r.allowed === null || r.allowed.some((p) => hostMatches(p, host, port));
}

function injectionsFor(r: SessionRules, host: string, port: number): Injection[] {
  return r.injections.filter((i) => i.hosts === null || i.hosts.some((p) => hostMatches(p, host, port)));
}

function sessionFor(header: string | undefined): SessionRules | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const token = decoded.slice(decoded.indexOf(":") + 1);
  return rules.get(token) ?? null;
}

const denyText = (host: string) =>
  `AgentOS egress proxy: ${host} is not in this environment's allowed hosts. Add it to the environment's networking.allowed_hosts to allow it.\n`;

/* ------------------------------------------------------------ rewriting */

function rewriteHeaders(headers: http.IncomingHttpHeaders, inj: Injection[]): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k === "proxy-authorization" || k === "proxy-connection") continue;
    const swap = (s: string) => inj.filter((i) => i.header).reduce((acc, i) => acc.split(i.placeholder).join(i.value), s);
    out[k] = Array.isArray(v) ? v.map(swap) : v === undefined ? v : swap(v);
  }
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("request body too large for secret injection");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function rewriteBody(body: Buffer, inj: Injection[]): Buffer {
  const active = inj.filter((i) => i.body);
  if (!active.length || !body.length) return body;
  let s = body.toString("latin1");
  let changed = false;
  for (const i of active) {
    if (s.includes(i.placeholder)) {
      s = s.split(i.placeholder).join(Buffer.from(i.value, "utf8").toString("latin1"));
      changed = true;
    }
  }
  return changed ? Buffer.from(s, "latin1") : body;
}

/** Sends a (possibly rewritten) request upstream and pipes the response back. */
async function forward(req: http.IncomingMessage, res: http.ServerResponse, target: { protocol: "http:" | "https:"; host: string; port: number; path: string }, inj: Injection[]) {
  const headers = rewriteHeaders(req.headers, inj);
  let body: Buffer | null = null;
  const hasBody = req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined;
  if (hasBody && inj.some((i) => i.body)) {
    body = rewriteBody(await readBody(req), inj);
    delete headers["transfer-encoding"];
    headers["content-length"] = String(body.length);
  }
  const mod = target.protocol === "https:" ? https : http;
  const up = mod.request(
    { host: target.host, port: target.port, path: target.path, method: req.method, headers, servername: target.host },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`AgentOS egress proxy: upstream error: ${err.message}\n`);
  });
  if (body) up.end(body);
  else req.pipe(up);
}

/* ------------------------------------------------------------ TLS (MITM) */

const caCert = forge.pki.certificateFromPem(readFileSync(`${CA_DIR}/ca.pem`, "utf8"));
const caKey = forge.pki.privateKeyFromPem(readFileSync(`${CA_DIR}/ca.key`, "utf8"));
// One key pair for every leaf certificate (only the certificates differ per host).
const leaf = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const leafPublic = forge.pki.publicKeyFromPem(leaf.publicKey);
const leafKeyPem = leaf.privateKey;
const contexts = new Map<string, tls.SecureContext>();

function contextFor(host: string): tls.SecureContext {
  let ctx = contexts.get(host);
  if (ctx) return ctx;
  const cert = forge.pki.createCertificate();
  cert.publicKey = leafPublic;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16)).replace(/^[89a-f]/, "1");
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  cert.setSubject([{ name: "commonName", value: host }]);
  cert.setIssuer(caCert.subject.attributes);
  const isIp = net.isIP(host) !== 0;
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [isIp ? { type: 7, ip: host } : { type: 2, value: host }] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  ctx = tls.createSecureContext({ key: leafKeyPem, cert: forge.pki.certificateToPem(cert) });
  contexts.set(host, ctx);
  return ctx;
}

/** Decrypted HTTPS requests from intercepted tunnels land here. */
const mitm = http.createServer((req, res) => {
  const sock = req.socket as tls.TLSSocket & { agentos?: { rules: SessionRules; host: string; port: number } };
  const meta = sock.agentos!;
  const inj = injectionsFor(meta.rules, meta.host, meta.port);
  void forward(req, res, { protocol: "https:", host: meta.host, port: meta.port, path: req.url ?? "/" }, inj).catch((err) => {
    res.writeHead(502).end(`AgentOS egress proxy: ${(err as Error).message}\n`);
  });
});

/* ------------------------------------------------------------ proxy server */

const proxy = http.createServer((req, res) => {
  // Plain-HTTP proxy request: absolute URI.
  const r = sessionFor(req.headers["proxy-authorization"]);
  if (!r) {
    res.writeHead(407, { "proxy-authenticate": 'Basic realm="agentos"', "content-type": "text/plain" });
    res.end("AgentOS egress proxy: unknown session\n");
    return;
  }
  let url: URL;
  try {
    url = new URL(req.url ?? "");
  } catch {
    res.writeHead(400).end("AgentOS egress proxy: expected an absolute URL\n");
    return;
  }
  const port = Number(url.port || 80);
  if (!allowed(r, url.hostname, port)) {
    log(`deny ${r.session_id} http ${url.hostname}:${port}`);
    res.writeHead(403, { "content-type": "text/plain" }).end(denyText(url.hostname));
    return;
  }
  const inj = injectionsFor(r, url.hostname, port);
  void forward(req, res, { protocol: "http:", host: url.hostname, port, path: `${url.pathname}${url.search}` }, inj).catch((err) => {
    res.writeHead(502).end(`AgentOS egress proxy: ${(err as Error).message}\n`);
  });
});

proxy.on("connect", (req, client: net.Socket, head) => {
  const r = sessionFor(req.headers["proxy-authorization"]);
  if (!r) {
    client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="agentos"\r\n\r\n');
    return;
  }
  const [host, portStr] = (req.url ?? "").split(":");
  const port = Number(portStr || 443);
  if (!host || !allowed(r, host, port)) {
    log(`deny ${r.session_id} connect ${host}:${port}`);
    const body = denyText(host ?? "?");
    client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    return;
  }
  client.on("error", () => {});
  if (injectionsFor(r, host, port).length > 0) {
    // Intercept: terminate TLS with a certificate from the AgentOS CA.
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tlsSock = new tls.TLSSocket(client, { isServer: true, secureContext: contextFor(host) }) as tls.TLSSocket & {
      agentos?: { rules: SessionRules; host: string; port: number };
    };
    tlsSock.agentos = { rules: r, host, port };
    tlsSock.on("error", () => {});
    if (head?.length) client.unshift(head);
    mitm.emit("connection", tlsSock);
    return;
  }
  // Plain tunnel.
  const upstream = net.connect(port, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
});

/* ------------------------------------------------------------ admin API */

const admin = http.createServer(async (req, res) => {
  if (req.url === "/health") return void res.writeHead(200).end("ok");
  if (!ADMIN_SECRET || req.headers["x-admin-secret"] !== ADMIN_SECRET) return void res.writeHead(401).end();
  const m = req.url?.match(/^\/sessions\/([A-Za-z0-9_-]+)$/);
  if (!m) return void res.writeHead(404).end();
  const token = m[1]!;
  if (req.method === "PUT") {
    const body = JSON.parse((await readBody(req)).toString()) as SessionRules;
    rules.set(token, body);
    return void res.writeHead(204).end();
  }
  if (req.method === "DELETE") {
    rules.delete(token);
    return void res.writeHead(204).end();
  }
  res.writeHead(405).end();
});

proxy.listen(3128, () => log("egress proxy on :3128"));
admin.listen(3129, () => log("egress admin on :3129"));
