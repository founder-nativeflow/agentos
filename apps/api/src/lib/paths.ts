import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, independent of the working directory (apps/api/src/lib → ../../../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Local data folder: config, session sandboxes' outputs, uploaded files. */
export const AGENTOS_HOME = resolve(process.env.AGENTOS_HOME ?? resolve(REPO_ROOT, ".agentos"));
export const SESSIONS_DIR = resolve(AGENTOS_HOME, "sessions");
export const FILES_DIR = resolve(AGENTOS_HOME, "files");

/** Absolute path for a file's storage_path (stored relative to AGENTOS_HOME). */
export function storageFile(storagePath: string): string {
  return resolve(AGENTOS_HOME, storagePath);
}

const MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json",
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", ts: "text/plain", py: "text/x-python",
  xml: "application/xml", yaml: "application/yaml", yml: "application/yaml", pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}
