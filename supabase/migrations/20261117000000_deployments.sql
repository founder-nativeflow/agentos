-- Deployments (CMA /v1/deployments) and their runs (/v1/deployment_runs).
alter table agentos.deployments add column if not exists description text;
alter table agentos.deployments add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table agentos.deployments add column if not exists archived_at timestamptz;
alter table agentos.deployments add column if not exists last_scheduled_run_at timestamptz;
-- AgentOS extension: webhook trigger (hash of the secret token; the token is shown once).
alter table agentos.deployments add column if not exists webhook_token_hash text;
alter table agentos.deployments alter column paused_reason type jsonb using
  case when paused_reason is null then null else jsonb_build_object('type', paused_reason) end;
create index if not exists deployments_ws_created on agentos.deployments (workspace_id, created_at desc);
create index if not exists deployments_scheduled on agentos.deployments (status) where schedule is not null and archived_at is null;

alter table agentos.deployment_runs add column if not exists agent jsonb;
alter table agentos.deployment_runs add column if not exists scheduled_at timestamptz;
-- At most one scheduled run per (deployment, scheduled time), even with several API replicas.
create unique index if not exists deployment_runs_schedule_once on agentos.deployment_runs (deployment_id, scheduled_at) where scheduled_at is not null;
create index if not exists deployment_runs_deployment on agentos.deployment_runs (deployment_id, created_at desc);
