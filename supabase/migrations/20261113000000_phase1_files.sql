-- Phase 1: Files API and session file resources.
alter table agentos.sessions add column if not exists resources jsonb not null default '[]'::jsonb;

alter table agentos.files add column if not exists expires_at timestamptz;
alter table agentos.files add column if not exists downloadable boolean not null default true;

-- Session outputs are synced into files; one row per output path.
create unique index if not exists files_session_output on agentos.files (session_id, storage_path) where session_id is not null;
create index if not exists files_ws_created on agentos.files (workspace_id, created_at desc);
