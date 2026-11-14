-- Phase 2: credential vaults. Secret values live in Supabase Vault (vault.secrets);
-- agentos.credentials keeps only the secret's id and non-secret config.
alter table agentos.vaults add column if not exists updated_at timestamptz not null default now();
alter table agentos.credentials add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table agentos.credentials add column if not exists updated_at timestamptz not null default now();
create index if not exists credentials_vault on agentos.credentials (vault_id, created_at desc);
