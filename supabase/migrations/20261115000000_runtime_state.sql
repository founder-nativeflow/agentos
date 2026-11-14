-- Agent-loop state per session (trueforge-core thread snapshot + adapter bookkeeping).
-- The event log stays the source of truth for what happened; this is what the loop
-- needs to continue (its context can be compacted, so it can't be rebuilt from events).
alter table agentos.sessions add column if not exists runtime_state jsonb;
