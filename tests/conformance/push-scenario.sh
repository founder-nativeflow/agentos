#!/usr/bin/env bash
# `agentos push` end to end between two AgentOS instances ("local" :4610 → "cloud" :4611,
# separate workspaces in the local Supabase DB). Only the CLI and the public API are used.
# Usage: bash tests/conformance/push-scenario.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentos-push.XXXXXX")"
HOME_DIR="$(printf '%s' "$HOME_DIR" | tr -s /)"
export AGENTOS_HOME="$HOME_DIR"
SRC=http://localhost:4610
DST=http://localhost:4611
TAG="push$(date +%s)$RANDOM"
WS_SRC="ws_${TAG}_src"
WS_DST="ws_${TAG}_dst"
FAIL=0

cleanup() {
  for p in ${PIDS:-}; do kill "$p" 2>/dev/null || true; done
  for id in $(docker exec supabase_db_agentos psql -U postgres -tAc "select lower(id) from agentos.sessions where workspace_id in ('$WS_SRC','$WS_DST')" 2>/dev/null); do
    docker rm -f "agentos-$id" > /dev/null 2>&1 || true
  done
  docker exec supabase_db_agentos psql -U postgres -qc "
    delete from vault.secrets where id in (select c.secret_id from agentos.credentials c join agentos.vaults v on v.id = c.vault_id where v.workspace_id in ('$WS_SRC','$WS_DST'));
    delete from agentos.workspaces where id in ('$WS_SRC','$WS_DST');" > /dev/null 2>&1 || true
  docker ps -aq --filter "label=agentos.home=$HOME_DIR" | xargs docker rm -f > /dev/null 2>&1 || true
  docker network ls -q --filter "label=agentos.home=$HOME_DIR" | xargs docker network rm > /dev/null 2>&1 || true
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

KEY="$(echo "push-pass-12345" | (cd "$ROOT" && pnpm -s agentos init --username admin --password-stdin --force) | awk '/Your API key/{getline; gsub(/^ +| +$/, ""); print; exit}')"
MOCK_PORT=4612 node "$ROOT/tests/conformance/mock-openrouter.mjs" > "$HOME_DIR/mock.log" 2>&1 & PIDS="$!"
for spec in "4610 $WS_SRC" "4611 $WS_DST"; do
  set -- $spec
  (cd "$ROOT/apps/api" && PORT=$1 AGENTOS_WORKSPACE=$2 AGENTOS_SCHEDULER=off OPENROUTER_BASE_URL=http://localhost:4612 OPENROUTER_API_KEY=mock \
    exec node --import tsx src/index.ts > "$HOME_DIR/api-$1.log" 2>&1) & PIDS="$PIDS $!"
done
for u in $SRC $DST; do for _ in $(seq 1 60); do curl -sf "$u/health" > /dev/null && break; sleep 0.25; done; done

api() { local base=$1; shift; curl -sf -H "x-api-key: $KEY" -H 'content-type: application/json' "$base$@"; }
jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log(eval('o'+process.argv[1]))})" "$1"; }
check() { if [[ "$2" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1: expected [$3], got [$2]"; FAIL=1; fi; }
cli() { (cd "$ROOT" && AGENTOS_URL=$SRC AGENTOS_API_KEY=$KEY pnpm -s agentos "$@" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'); }
count() { api "$DST" "/v1/$1" | jget ".data.length"; }

# --- the local setup: environment, vault + secret, agent, file, scheduled deployment with a webhook
ENV=$(api $SRC /v1/environments -d '{"name":"reports-env","config":{"type":"local","networking":{"type":"limited","allowed_hosts":["api.example.com"]},"packages":{"pip":["requests"]}}}' | jget .id)
VAULT=$(api $SRC /v1/vaults -d '{"display_name":"Team secrets"}' | jget .id)
api $SRC "/v1/vaults/$VAULT/credentials" -d '{"auth":{"type":"environment_variable","secret_name":"REPORT_TOKEN","secret_value":"local-only-secret","networking":{"type":"unrestricted"}}}' > /dev/null
AGENT=$(api $SRC /v1/agents -d '{"name":"Reporter","model":"mock/model","system":"Write reports. v1"}' | jget .id)
printf 'region,sales\nnorth,10\n' > "$HOME_DIR/data.csv"
FILE=$(curl -sf -H "x-api-key: $KEY" -F "file=@$HOME_DIR/data.csv" $SRC/v1/files | jget .id)
DEPL=$(api $SRC /v1/deployments -d "{\"name\":\"Daily report\",\"agent\":\"$AGENT\",\"environment_id\":\"$ENV\",\"vault_ids\":[\"$VAULT\"],\"resources\":[{\"type\":\"file\",\"file_id\":\"$FILE\",\"mount_path\":\"/mnt/session/uploads/data.csv\"}],\"initial_events\":[{\"type\":\"user.message\",\"content\":[{\"type\":\"text\",\"text\":\"hello report\"}]}],\"schedule\":{\"type\":\"cron\",\"expression\":\"0 7 * * *\",\"timezone\":\"Europe/London\"}}" | jget .id)
api $SRC "/v1/deployments/$DEPL/webhook" -X POST > /dev/null

echo "1. Remote"
AGENTOS_REMOTE_KEY=$KEY cli remote add cloud $DST | sed 's/^/  /'
check "remote is listed" "$(cli remote list | grep -c "^cloud")" "1"

echo "2. Safety: a vault missing on the target stops the push before any write"
OUT=$(cli push Reporter --to cloud --deployment $DEPL || true)
check "explains the missing vault" "$(echo "$OUT" | grep -c 'vault "Team secrets", which doesn.t exist on cloud')" "1"
check "nothing was created on the target" "$(count agents)/$(count environments)" "0/0"

echo "3. Dry run shows the plan and changes nothing"
api $DST /v1/vaults -d '{"display_name":"Team secrets"}' > /dev/null
OUT=$(cli push Reporter --to cloud --deployment $DEPL --dry-run)
echo "$OUT" | sed 's/^/    /'
check "plan creates the agent, environment and deployment" "$(echo "$OUT" | grep -cE '^\s+\+ (agent|environment|deployment)')" "3"
check "nothing was created on the target" "$(count agents)/$(count deployments)" "0/0"

echo "4. Push"
cli push Reporter --to cloud --deployment $DEPL | sed 's/^/    /'
TA=$(api $DST "/v1/agents" | jget ".data[0].id")
check "agent created at v1 and linked to the source" "$(api $DST /v1/agents/$TA | jget '.version+":"+o.metadata["agentos.source"]')" "1:$AGENT"
check "environment is a cloud one with the same rules" "$(api $DST /v1/environments | jget '.data[0].config.type+":"+o.data[0].config.networking.allowed_hosts[0]+":"+o.data[0].config.packages.pip[0]')" "cloud:api.example.com:requests"
TD=$(api $DST /v1/deployments | jget ".data[0].id")
check "deployment arrived paused and pinned to v1" "$(api $DST /v1/deployments/$TD | jget '.status+":"+o.agent.id+":"+o.agent.version')" "paused:$TA:1"
check "schedule copied" "$(api $DST /v1/deployments/$TD | jget '.schedule.expression+" "+o.schedule.timezone')" "0 7 * * * Europe/London"
TF=$(api $DST /v1/deployments/$TD | jget '.resources[0].file_id')
check "file uploaded to the target" "$(curl -sf -H "x-api-key: $KEY" $DST/v1/files/$TF/content)" "$(cat "$HOME_DIR/data.csv")"
check "secret not copied (target vault has no credentials)" "$(api $DST /v1/vaults | jget '.data[0].id' | xargs -I{} sh -c "curl -sf -H 'x-api-key: $KEY' $DST/v1/vaults/{}/credentials" | jget '.data.length')" "0"
check "webhook not copied" "$(api $DST /v1/deployments/$TD | jget '.x_webhook.enabled')" "false"

echo "5. Pushing again: unchanged things are left alone"
OUT=$(cli push Reporter --to cloud --deployment $DEPL)
check "nothing to push (agent, file and deployment unchanged)" "$(echo "$OUT" | grep -c 'Nothing to push')" "1"
check "file not uploaded again" "$(count files)" "1"
check "still v1" "$(api $DST /v1/agents/$TA | jget .version)" "1"

echo "6. A new local version: push makes a new cloud version and re-pins the deployment"
api $SRC "/v1/agents/$AGENT" -d '{"version":1,"system":"Write reports. v2"}' > /dev/null
cli push Reporter --to cloud --deployment $DEPL | sed 's/^/    /'
check "cloud agent v2 with the new prompt" "$(api $DST /v1/agents/$TA | jget '.version+":"+o.system')" "2:Write reports. v2"
check "deployment pinned to v2, still paused" "$(api $DST /v1/deployments/$TD | jget '.agent.version+":"+o.status')" "2:paused"

echo "7. --activate, then a run on the target"
cli push Reporter --to cloud --deployment $DEPL --activate > /dev/null
check "deployment active" "$(api $DST /v1/deployments/$TD | jget .status)" "active"
RUN=$(api $DST "/v1/deployments/$TD/run" -X POST)
check "run created a session on the target" "$(echo "$RUN" | jget '.session_id.slice(0,7)+":"+(o.error===null)')" "sesn_01:true"

[[ $FAIL -eq 0 ]] && echo "All push checks passed." || { echo "--- logs"; tail -15 "$HOME_DIR"/api-4611.log; exit 1; }
