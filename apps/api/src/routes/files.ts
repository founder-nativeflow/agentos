import { Hono } from "hono";
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { newId, nowIso } from "../lib/ids.js";
import { ApiError, badRequest, notFound } from "../lib/errors.js";
import { paginate } from "../lib/pagination.js";
import { FILES_DIR, mimeFor, storageFile } from "../lib/paths.js";
import { publicFile, type StoredFile } from "../lib/store.js";

/** Local uploads are capped well below CMA's limit; the cloud store lifts it. */
const MAX_UPLOAD_BYTES = Number(process.env.AGENTOS_MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);

/** CMA-compatible Files API (`/v1/files`). Bytes live under AGENTOS_HOME/files locally. */
export const files = new Hono();

files.post("/", async (c) => {
  const body = await c.req.parseBody().catch(() => {
    throw badRequest("Send the file as multipart/form-data with a `file` field");
  });
  const file = body.file;
  if (!(file instanceof File)) throw badRequest("Missing `file` (multipart/form-data)");
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, "request_too_large", `Files are limited to ${MAX_UPLOAD_BYTES} bytes locally`);

  let expiresAt: string | null = null;
  if (body.expires_in_seconds !== undefined) {
    const secs = Number(body.expires_in_seconds);
    if (!Number.isInteger(secs) || secs < 3600 || secs > 7_776_000) throw badRequest("expires_in_seconds must be between 3600 and 7776000");
    expiresAt = new Date(Date.now() + secs * 1000).toISOString();
  }

  const id = newId("file");
  const filename = basename(file.name || "") || "unnamed";
  const mime = file.type && file.type !== "application/octet-stream" ? file.type : mimeFor(filename);
  mkdirSync(FILES_DIR, { recursive: true });
  writeFileSync(storageFile(`files/${id}`), Buffer.from(await file.arrayBuffer()));

  const stored: StoredFile = {
    type: "file",
    id,
    filename,
    mime_type: mime,
    size_bytes: file.size,
    created_at: nowIso(),
    downloadable: true,
    expires_at: expiresAt,
    scope: null,
    storage_path: `files/${id}`,
  };
  await c.get("store").files.insert(stored);
  return c.json(publicFile(stored));
});

files.get("/", async (c) => {
  const q = c.req.query();
  const ids = [...(c.req.queries("ids") ?? []), ...(c.req.queries("ids[]") ?? [])].flatMap((v) => v.split(",")).filter(Boolean);
  if (ids.length > 100) throw badRequest("ids accepts at most 100 entries");
  if (ids.length && (q.page || q.limit)) throw badRequest("ids can't be combined with page or limit");
  const all = (await c.get("store").files.list({ scopeId: q.scope_id, ids: ids.length ? [...new Set(ids)] : undefined })).map(publicFile);
  if (ids.length) return c.json({ data: all, next_page: null });
  return c.json(paginate(all, q));
});

async function load(c: { get: (k: "store") => import("../lib/store.js").Store }, id: string) {
  const f = await c.get("store").files.get(id);
  if (!f) throw notFound("File", id);
  return f;
}

files.get("/:id", async (c) => c.json(publicFile(await load(c, c.req.param("id")))));

files.get("/:id/content", async (c) => {
  const f = await load(c, c.req.param("id"));
  const path = storageFile(f.storage_path);
  if (!f.downloadable || !existsSync(path)) throw notFound("File content", f.id);
  c.header("content-type", f.mime_type);
  c.header("content-length", String(f.size_bytes));
  c.header("content-disposition", `attachment; filename="${f.filename.replace(/"/g, "")}"`);
  return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
});

files.delete("/:id", async (c) => {
  const f = await load(c, c.req.param("id"));
  await c.get("store").files.remove(f.id);
  // Uploaded bytes go with the row; a session output stays in the session's outputs folder.
  if (!f.scope) rmSync(storageFile(f.storage_path), { force: true });
  return c.json({ type: "file_deleted", id: f.id });
});
