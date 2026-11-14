import { Hono } from "hono";
import { z } from "zod";
import type { CredentialAuth, Vault, VaultCredential } from "@agentos/types";
import { newId, nowIso } from "../lib/ids.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { paginate } from "../lib/pagination.js";
import type { Store } from "../lib/store.js";

/**
 * CMA-compatible credential vaults (`/v1/vaults`, `/v1/vaults/{id}/credentials`).
 * Secret values (bearer tokens, environment variable values) are stored in
 * Supabase Vault and are never returned by the API.
 */
export const vaults = new Hono();

const metadata = z.record(z.string().max(64), z.string().max(512)).refine((m) => Object.keys(m).length <= 16, "metadata allows at most 16 pairs");
const metadataPatch = z.record(z.string().max(64), z.string().max(512).nullable()).nullish();

/** Applies a CMA metadata patch: null removes a key, a null patch clears all. */
function patchMetadata(current: Record<string, string>, patch: Record<string, string | null> | null | undefined) {
  if (patch === undefined) return current;
  if (patch === null) return {};
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

const host = z.string().min(1).max(253).regex(/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i, "allowed_hosts entries are host names like api.example.com or *.example.com");
const networking = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unrestricted") }),
  z.object({ type: z.literal("limited"), allowed_hosts: z.array(host).min(1).max(50) }),
]);
const secretName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, "secret_name must be an environment variable name like GITHUB_TOKEN");

const createAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("static_bearer"), token: z.string().min(1).max(16_384), mcp_server_url: z.string().url() }),
  z.object({
    type: z.literal("environment_variable"),
    secret_name: secretName,
    secret_value: z.string().min(1).max(65_536),
    networking,
    injection_location: z.object({ header: z.boolean().optional(), body: z.boolean().optional() }).optional(),
  }),
  z.object({ type: z.literal("mcp_oauth") }).passthrough(),
]);

const updateAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("static_bearer"), token: z.string().min(1).max(16_384).nullish() }),
  z.object({
    type: z.literal("environment_variable"),
    secret_value: z.string().min(1).max(65_536).nullish(),
    networking: networking.nullish(),
    injection_location: z.object({ header: z.boolean().nullish(), body: z.boolean().nullish() }).nullish(),
  }),
  z.object({ type: z.literal("mcp_oauth") }).passthrough(),
]);

const getStore = (c: { get: (k: "store") => Store }) => c.get("store");

async function loadVault(store: Store, id: string) {
  const v = await store.vaults.get(id);
  if (!v) throw notFound("Vault", id);
  return v;
}

async function loadCredential(store: Store, vaultId: string, id: string) {
  const cred = await store.credentials.get(vaultId, id);
  if (!cred) throw notFound("Credential", id);
  return cred;
}

const normaliseUrl = (u: string) => u.replace(/\/+$/, "");

/* ------------------------------------------------------------------ vaults */

vaults.post("/", async (c) => {
  const body = z.object({ display_name: z.string().min(1).max(256), metadata: metadata.optional() }).parse(await c.req.json());
  const now = nowIso();
  const v: Vault = { type: "vault", id: newId("vault"), display_name: body.display_name, metadata: body.metadata ?? {}, created_at: now, updated_at: now, archived_at: null };
  await getStore(c).vaults.insert(v);
  return c.json(v);
});

vaults.get("/", async (c) => {
  const q = c.req.query();
  return c.json(paginate(await getStore(c).vaults.list(q.include_archived === "true"), q));
});

vaults.get("/:id", async (c) => c.json(await loadVault(getStore(c), c.req.param("id"))));

vaults.post("/:id", async (c) => {
  const store = getStore(c);
  const v = await loadVault(store, c.req.param("id"));
  const body = z.object({ display_name: z.string().min(1).max(256).nullish(), metadata: metadataPatch }).parse(await c.req.json());
  if (v.archived_at) throw conflict("Archived vaults can't be changed");
  if (body.display_name) v.display_name = body.display_name;
  v.metadata = patchMetadata(v.metadata, body.metadata);
  v.updated_at = nowIso();
  await store.vaults.update(v);
  return c.json(v);
});

vaults.post("/:id/archive", async (c) => {
  const store = getStore(c);
  const v = await loadVault(store, c.req.param("id"));
  if (!v.archived_at) {
    // Archiving a vault archives its credentials and purges their secret values.
    for (const cred of await store.credentials.list([v.id], false)) {
      cred.archived_at = nowIso();
      cred.updated_at = cred.archived_at;
      await store.credentials.update(cred);
      await store.credentials.purgeSecret(cred.id);
    }
    v.archived_at = nowIso();
    v.updated_at = v.archived_at;
    await store.vaults.update(v);
  }
  return c.json(v);
});

vaults.delete("/:id", async (c) => {
  const store = getStore(c);
  const v = await loadVault(store, c.req.param("id"));
  await store.vaults.remove(v.id);
  return c.json({ type: "vault_deleted", id: v.id });
});

/* ------------------------------------------------------------- credentials */

vaults.post("/:id/credentials", async (c) => {
  const store = getStore(c);
  const v = await loadVault(store, c.req.param("id"));
  if (v.archived_at) throw conflict("Archived vaults can't take new credentials");
  const body = z
    .object({ auth: createAuth, display_name: z.string().max(256).nullish(), metadata: metadata.optional() })
    .parse(await c.req.json());
  const a = body.auth;
  if (a.type === "mcp_oauth") throw badRequest("mcp_oauth credentials are not supported yet in AgentOS (planned: Phase 3). Use static_bearer.");

  let auth: CredentialAuth;
  let secret: string;
  if (a.type === "static_bearer") {
    auth = { type: "static_bearer", mcp_server_url: normaliseUrl(a.mcp_server_url) };
    secret = a.token;
    const dup = (await store.credentials.list([v.id], false)).some(
      (x) => x.auth.type === "static_bearer" && auth.type === "static_bearer" && x.auth.mcp_server_url === auth.mcp_server_url,
    );
    if (dup) throw conflict(`This vault already has a credential for ${auth.mcp_server_url}`);
  } else {
    auth = {
      type: "environment_variable",
      secret_name: a.secret_name,
      networking: a.networking,
      injection_location: { header: a.injection_location?.header ?? true, body: a.injection_location?.body ?? false },
    };
    secret = a.secret_value;
    const dup = (await store.credentials.list([v.id], false)).some(
      (x) => x.auth.type === "environment_variable" && x.auth.secret_name === a.secret_name,
    );
    if (dup) throw conflict(`This vault already has a secret named ${a.secret_name}`);
  }

  const now = nowIso();
  const cred: VaultCredential = {
    type: "vault_credential",
    id: newId("credential"),
    vault_id: v.id,
    display_name: body.display_name ?? null,
    auth,
    metadata: body.metadata ?? {},
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  await store.credentials.insert(cred, secret);
  return c.json(cred);
});

vaults.get("/:id/credentials", async (c) => {
  const store = getStore(c);
  const v = await loadVault(store, c.req.param("id"));
  const q = c.req.query();
  return c.json(paginate(await store.credentials.list([v.id], q.include_archived === "true"), q));
});

vaults.get("/:id/credentials/:cid", async (c) => {
  const store = getStore(c);
  return c.json(await loadCredential(store, c.req.param("id"), c.req.param("cid")));
});

vaults.post("/:id/credentials/:cid", async (c) => {
  const store = getStore(c);
  const cred = await loadCredential(store, c.req.param("id"), c.req.param("cid"));
  if (cred.archived_at) throw conflict("Archived credentials can't be changed");
  const body = z
    .object({ auth: updateAuth.optional(), display_name: z.string().max(256).nullish(), metadata: metadataPatch })
    .parse(await c.req.json());
  let secret: string | undefined;
  if (body.auth) {
    if (body.auth.type !== cred.auth.type) throw badRequest(`auth.type must stay ${cred.auth.type}`);
    if (body.auth.type === "static_bearer") secret = body.auth.token ?? undefined;
    if (body.auth.type === "environment_variable" && cred.auth.type === "environment_variable") {
      secret = body.auth.secret_value ?? undefined;
      if (body.auth.networking) cred.auth.networking = body.auth.networking;
      const loc = body.auth.injection_location;
      if (loc) {
        if (loc.header != null) cred.auth.injection_location.header = loc.header;
        if (loc.body != null) cred.auth.injection_location.body = loc.body;
      }
    }
  }
  if (body.display_name !== undefined) cred.display_name = body.display_name ?? null;
  cred.metadata = patchMetadata(cred.metadata, body.metadata);
  cred.updated_at = nowIso();
  await store.credentials.update(cred, secret);
  return c.json(cred);
});

vaults.post("/:id/credentials/:cid/archive", async (c) => {
  const store = getStore(c);
  const cred = await loadCredential(store, c.req.param("id"), c.req.param("cid"));
  if (!cred.archived_at) {
    cred.archived_at = nowIso();
    cred.updated_at = cred.archived_at;
    await store.credentials.update(cred);
    await store.credentials.purgeSecret(cred.id);
  }
  return c.json(cred);
});

vaults.delete("/:id/credentials/:cid", async (c) => {
  const store = getStore(c);
  const cred = await loadCredential(store, c.req.param("id"), c.req.param("cid"));
  await store.credentials.remove(cred.id);
  return c.json({ type: "vault_credential_deleted", id: cred.id });
});
