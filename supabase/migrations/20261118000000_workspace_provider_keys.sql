-- Bring-your-own OpenRouter key per workspace (Supabase Auth mode). The key itself is in
-- Supabase Vault; the workspace row keeps only its id, a hint and the last check result.
alter table agentos.workspaces add column if not exists openrouter_secret_id uuid;
alter table agentos.workspaces add column if not exists openrouter_hint text;
alter table agentos.workspaces add column if not exists openrouter_status text;
alter table agentos.workspaces add column if not exists openrouter_checked_at timestamptz;

-- Deleting a workspace also deletes its key from Vault.
create or replace function agentos.drop_workspace_openrouter_secret() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.openrouter_secret_id is not null then
    delete from vault.secrets where id = old.openrouter_secret_id;
  end if;
  return old;
end $$;
drop trigger if exists workspaces_drop_openrouter_secret on agentos.workspaces;
create trigger workspaces_drop_openrouter_secret after delete on agentos.workspaces
  for each row execute function agentos.drop_workspace_openrouter_secret();
