-- Workflows (AgentOS extension): versioned graphs of agent steps, conditions and routers.
create table if not exists agentos.workflows (
  id             text primary key,                      -- wf_…
  workspace_id   text not null references agentos.workspaces(id) on delete cascade,
  latest_version integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz
);
create index if not exists workflows_ws on agentos.workflows (workspace_id, created_at desc);

create table if not exists agentos.workflow_versions (
  workflow_id text not null references agentos.workflows(id) on delete cascade,
  version     integer not null,
  spec        jsonb not null,                           -- name, description, nodes, edges, environment_id, vault_ids, metadata
  created_at  timestamptz not null default now(),
  primary key (workflow_id, version)
);

-- One row per run of a workflow (distinct from CMA's in-session workflow_runs table).
create table if not exists agentos.workflow_executions (
  id               text primary key,                    -- wfrun_…
  workspace_id     text not null references agentos.workspaces(id) on delete cascade,
  workflow_id      text not null references agentos.workflows(id) on delete cascade,
  workflow_version integer not null,
  status           text not null,
  input            text not null default '',
  output           text,
  error            jsonb,
  steps            jsonb not null default '{}'::jsonb,
  cost_usd         numeric(12, 6) not null default 0,
  trigger          jsonb not null default '{"type":"manual"}'::jsonb,
  created_at       timestamptz not null default now(),
  ended_at         timestamptz
);
create index if not exists workflow_executions_wf on agentos.workflow_executions (workspace_id, workflow_id, created_at desc);

-- Builder chats: the conversation and the structured plan behind it.
create table if not exists agentos.builder_chats (
  id           text primary key,                        -- bchat_…
  workspace_id text not null references agentos.workspaces(id) on delete cascade,
  title        text not null,
  model        text not null,
  messages     jsonb not null default '[]'::jsonb,
  plan         jsonb,
  applied      jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists builder_chats_ws on agentos.builder_chats (workspace_id, updated_at desc);

alter table agentos.workflows           enable row level security;
alter table agentos.workflow_versions   enable row level security;
alter table agentos.workflow_executions enable row level security;
alter table agentos.builder_chats       enable row level security;
