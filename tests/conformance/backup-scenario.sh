#!/usr/bin/env bash
# `agentos backup` / `agentos restore` round trip on the local Supabase database.
# Restore replaces ALL AgentOS data, so stop other AgentOS APIs on this database first.
# It takes a safety backup (with secrets) before it starts; it's left in .agentos/backups.
# Usage: bash tests/conformance/backup-scenario.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=4630
WS="ws_backup_$(date +%s)_$RANDOM"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/agentos-backup.XXXXXX")"
TMP="$(printf '%s' "$TMP" | tr -s /)"
BASE="http://localhost:$PORT"
KEY="$(sed -n 's/^AGENTOS_API_KEY=//p' "$ROOT/.agentos/dev-credentials")"
FAIL=0
db() { docker exec supabase_db_agentos psql -U postgres -tAc "$1"; }
cli() { (cd "$ROOT" && pnpm -s agentos "$@" 2>&1); }

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  db "delete from vault.secrets where id in (select c.secret_id from agentos.credentials c join agentos.vaults v on v.id = c.vault_id where v.workspace_id = '$WS'); delete from agentos.workspaces where id = '$WS'" > /dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

if curl -sf http://localhost:4000/health > /dev/null; then echo "Stop the API on :4000 first (restore replaces all data)."; exit 1; fi
cli backup --include-secrets --out "$ROOT/.agentos/backups/safety-$(date +%Y%m%d-%H%M%S)" | tail -1

(cd "$ROOT/apps/api" && PORT=$PORT AGENTOS_WORKSPACE=$WS AGENTOS_SCHEDULER=off exec node --import tsx src/index.ts > "$TMP/api.log" 2>&1) & API_PID=$!
for _ in $(seq 1 60); do curl -sf "$BASE/health" > /dev/null && break; sleep 0.25; done
api() { curl -sf -H "x-api-key: $KEY" -H 'content-type: application/json' "$BASE$@"; }
jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log(eval('o'+process.argv[1]))})" "$1"; }
check() { if [[ "$2" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1: expected [$3], got [$2]"; FAIL=1; fi; }

AGENT=$(api /v1/agents -d '{"name":"backup-marker","model":"mock/model","system":"v1"}' | jget .id)
api "/v1/agents/$AGENT" -d '{"version":1,"system":"v2"}' > /dev/null
VAULT=$(api /v1/vaults -d '{"display_name":"backup vault"}' | jget .id)
api "/v1/vaults/$VAULT/credentials" -d '{"auth":{"type":"environment_variable","secret_name":"TOKEN","secret_value":"s3cret-value-42","networking":{"type":"unrestricted"}}}' > /dev/null
kill "$API_PID"; wait "$API_PID" 2>/dev/null || true; unset API_PID
secret_value() { db "select s.decrypted_secret from agentos.credentials c join agentos.vaults v on v.id = c.vault_id join vault.decrypted_secrets s on s.id = c.secret_id where v.workspace_id = '$WS'"; }
TOTAL_BEFORE=$(db "select (select count(*) from agentos.agent_versions)||'/'||(select count(*) from agentos.sessions)||'/'||(select count(*) from agentos.session_events)")

echo "1. Backup with secrets, lose the data, restore"
cli backup --include-secrets --out "$TMP/b1" | sed 's/^/    /'
check "backup files are private" "$(node -e 'const fs=require("fs");console.log([...new Set(process.argv.slice(1).map(f=>(fs.statSync(f).mode&0o777).toString(8)))].join(" "))' "$TMP/b1/agentos.sql" "$TMP/b1/secrets.json")" "600"
db "delete from vault.secrets where id in (select c.secret_id from agentos.credentials c join agentos.vaults v on v.id = c.vault_id where v.workspace_id = '$WS'); delete from agentos.workspaces where id = '$WS'" > /dev/null
check "data is gone" "$(db "select count(*) from agentos.agents where id = '$AGENT'")" "0"
check "restore refuses without --yes" "$(cli restore "$TMP/b1" | grep -c 'replaces ALL')" "1"
cli restore "$TMP/b1" --yes | sed 's/^/    /'
check "agent and both versions are back" "$(db "select string_agg(version::text, ',' order by version) from agentos.agent_versions where agent_id = '$AGENT'")" "1,2"
check "credential value is back (re-created in Vault)" "$(secret_value)" "s3cret-value-42"
check "everything else is unchanged" "$(db "select (select count(*) from agentos.agent_versions)||'/'||(select count(*) from agentos.sessions)||'/'||(select count(*) from agentos.session_events)")" "$TOTAL_BEFORE"

echo "2. Backup without secrets, restore onto the same database: credential values are kept"
cli backup --out "$TMP/b2" > /dev/null
check "no secrets file" "$(ls "$TMP/b2" | grep -c secrets.json || true)" "0"
cli restore "$TMP/b2" --yes > /dev/null
check "credential value still resolves" "$(secret_value)" "s3cret-value-42"
check "no orphaned or missing Vault rows for the workspace" "$(db "select count(*) from agentos.credentials c join agentos.vaults v on v.id = c.vault_id where v.workspace_id = '$WS' and not exists (select 1 from vault.secrets s where s.id = c.secret_id)")" "0"

echo "3. The API starts on the restored database"
(cd "$ROOT/apps/api" && PORT=$PORT AGENTOS_WORKSPACE=$WS AGENTOS_SCHEDULER=off exec node --import tsx src/index.ts >> "$TMP/api.log" 2>&1) & API_PID=$!
for _ in $(seq 1 60); do curl -sf "$BASE/health" > /dev/null && break; sleep 0.25; done
check "agent served at v2" "$(api "/v1/agents/$AGENT" | jget '.version+":"+o.system')" "2:v2"

[[ $FAIL -eq 0 ]] && echo "All backup checks passed." || { tail -20 "$TMP/api.log"; exit 1; }
