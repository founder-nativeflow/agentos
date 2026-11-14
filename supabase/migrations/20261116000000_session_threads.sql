-- Session threads (sub-agents). One row per spawned thread; the primary thread is the session itself.
alter table agentos.threads add column if not exists status_detail jsonb;           -- last stop_reason
alter table agentos.threads add column if not exists usage jsonb not null default '{}'::jsonb;
alter table agentos.threads add column if not exists stats jsonb not null default '{}'::jsonb;
alter table agentos.threads add column if not exists updated_at timestamptz not null default now();
alter table agentos.threads add column if not exists archived_at timestamptz;
create index if not exists threads_session on agentos.threads (session_id, created_at);
create index if not exists session_events_thread on agentos.session_events (session_id, thread_id, seq) where thread_id is not null;
