-- Phase 1: what the session runtime needs.

-- Sessions carry a snapshot of the agent version they run (CMA `session.agent`),
-- the last stop reason and runtime stats.
alter table agentos.sessions
  add column agent_snapshot jsonb not null default '{}'::jsonb,
  add column stop_reason    jsonb,
  add column stats          jsonb not null default '{"active_seconds":0,"duration_seconds":0}'::jsonb;

-- Events are stored as the full CMA event object (flat: id, type, …fields).
comment on column agentos.session_events.payload is 'Full CMA event object as returned by the API';
create index session_events_type on agentos.session_events (session_id, type);

-- Single-machine local mode uses one default workspace.
insert into agentos.workspaces (id, name) values ('ws_default', 'Default workspace')
on conflict (id) do nothing;
