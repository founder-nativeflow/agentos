import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import type { FileMetadata, Page } from "@agentos/types";
import { PageHeader } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiRequestError, timeAgo } from "@/lib/api";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function useFiles() {
  return useQuery({ queryKey: ["files"], queryFn: () => api<Page<FileMetadata>>("/v1/files?limit=100") });
}

export function FilesPage() {
  const files = useFiles();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(list)) {
        const form = new FormData();
        form.append("file", f);
        const res = await fetch("/v1/files", { method: "POST", body: form, credentials: "include" });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
        }
      }
      toast.success(list.length === 1 ? "File uploaded" : `${list.length} files uploaded`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
      void qc.invalidateQueries({ queryKey: ["files"] });
    }
  }

  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/files/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files"] }),
    onError: (e) => toast.error(e instanceof ApiRequestError ? e.message : "Could not delete the file."),
  });

  return (
    <>
      <PageHeader
        title="Files"
        description="Files you upload for sessions, and files agents save to /mnt/session/outputs."
        actions={
          <>
            <input ref={input} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
            <Button onClick={() => input.current?.click()} disabled={uploading}><Upload /> {uploading ? "Uploading…" : "Upload files"}</Button>
          </>
        }
      />
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden xl:table-cell">ID</TableHead>
              <TableHead className="hidden lg:table-cell">Type</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.isLoading && <TableRow><TableCell colSpan={7} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {files.data?.data.length === 0 && (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No files yet. Upload one to attach it to a session.</TableCell></TableRow>
            )}
            {files.data?.data.map((f) => (
              <TableRow key={f.id}>
                <TableCell className="max-w-64 truncate font-medium" title={f.id}>{f.filename}</TableCell>
                <TableCell className="hidden font-mono text-xs xl:table-cell">{f.id}</TableCell>
                <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{f.mime_type}</TableCell>
                <TableCell className="text-sm">{formatBytes(f.size_bytes)}</TableCell>
                <TableCell>
                  {f.scope ? (
                    <Link to={`/sessions/${f.scope.id}?inspector=outputs`}><Badge variant="secondary">Session output</Badge></Link>
                  ) : (
                    <Badge variant="outline">Upload</Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{timeAgo(f.created_at)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {f.downloadable && (
                      <Button asChild size="icon" variant="ghost" aria-label={`Download ${f.filename}`}>
                        <a href={`/v1/files/${f.id}/content`}><Download className="size-4" /></a>
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${f.filename}`}
                      onClick={() => window.confirm(`Delete ${f.filename}?`) && remove.mutate(f.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
