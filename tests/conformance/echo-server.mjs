// Echo server for the egress tests: replies with the request it received, so a
// test can check exactly what left the sandbox. HTTP on ECHO_HTTP_PORT, HTTPS on
// ECHO_HTTPS_PORT with a certificate from a throwaway CA written to ECHO_CA_OUT
// (the test API passes it to the egress proxy as an extra trusted upstream CA).
import http from "node:http";
import https from "node:https";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import forge from "node-forge";

const HTTP_PORT = Number(process.env.ECHO_HTTP_PORT ?? 4197);
const HTTPS_PORT = Number(process.env.ECHO_HTTPS_PORT ?? 4196);
const pem = (o) => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" }, ...o });

function cert(subjectCN, issuer, issuerKey, pub, ca) {
  const c = forge.pki.createCertificate();
  c.publicKey = forge.pki.publicKeyFromPem(pub);
  c.serialNumber = "01" + randomBytes(8).toString("hex");
  c.validity.notBefore = new Date(Date.now() - 86400000);
  c.validity.notAfter = new Date(Date.now() + 86400000 * 30);
  c.setSubject([{ name: "commonName", value: subjectCN }]);
  c.setIssuer(issuer ?? [{ name: "commonName", value: subjectCN }]);
  c.setExtensions(ca
    ? [{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true }]
    : [{ name: "subjectAltName", altNames: [{ type: 2, value: "host.docker.internal" }, { type: 2, value: "localhost" }] }]);
  c.sign(forge.pki.privateKeyFromPem(issuerKey), forge.md.sha256.create());
  return c;
}

const caKeys = pem();
const ca = cert("AgentOS test upstream CA", null, caKeys.privateKey, caKeys.publicKey, true);
const leafKeys = pem();
const leaf = cert("host.docker.internal", ca.subject.attributes, caKeys.privateKey, leafKeys.publicKey, false);
if (process.env.ECHO_CA_OUT) writeFileSync(process.env.ECHO_CA_OUT, forge.pki.certificateToPem(ca));

const handler = (req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ method: req.method, path: req.url, headers: req.headers, body }));
  });
};
http.createServer(handler).listen(HTTP_PORT, () => console.log(`echo http :${HTTP_PORT}`));
https.createServer({ key: leafKeys.privateKey, cert: forge.pki.certificateToPem(leaf) }, handler)
  .listen(HTTPS_PORT, () => console.log(`echo https :${HTTPS_PORT}`));
