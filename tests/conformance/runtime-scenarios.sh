#!/usr/bin/env bash
# Runtime scenarios the SDK suite can't cover from inside one API process:
#   1. thread state survives an API restart (the model still sees earlier turns)
#   2. raising the budget resumes a session that stopped at it
#   3. context compaction emits agent.thread_context_compacted
# Uses the scripted mock model, a throwaway workspace and API on :4600.
# Usage: bash tests/conformance/runtime-scenarios.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=4600
MOCK_PORT=4599
WS="ws_scen_$(date +%s)_$RANDOM"
LOG="$(mktemp -d "${TMPDIR:-/tmp}/agentos-scenarios.XXXXXX")"
LOG="$(printf '%s' "$LOG" | tr -s /)"   # TMPDIR may end in "/"; the API labels resources with the normalised path
BASE="http://localhost:$PORT"
KEY="$(sed -n 's/^AGENTOS_API_KEY=//p' "$ROOT/.agentos/dev-credentials" 2>/dev/null || true)"
[[ -n "$KEY" ]] || { echo "Needs .agentos/dev-credentials with AGENTOS_API_KEY"; exit 1; }
FAIL=0

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null || true
  for id in $(docker exec supabase_db_agentos psql -U postgres -tAc "select lower(id) from agentos.sessions where workspace_id = '$WS'" 2>/dev/null); do
    docker rm -f "agentos-$id" > /dev/null 2>&1 || true
  done
  docker exec supabase_db_agentos psql -U postgres -qc "delete from agentos.workspaces where id = '$WS'" > /dev/null 2>&1 || true
  rm -rf "$LOG"
}
trap cleanup EXIT

start_api() {
  (cd "$ROOT/apps/api" && PORT=$PORT AGENTOS_WORKSPACE=$WS OPENROUTER_BASE_URL="http://localhost:$MOCK_PORT" OPENROUTER_API_KEY=mock \
    AGENTOS_COMPACTION_THRESHOLD_TOKENS="${COMPACT_TOKENS:-}" exec node --import tsx src/index.ts >> "$LOG/api.log" 2>&1) &
  API_PID=$!
  for _ in $(seq 1 60); do curl -sf "$BASE/health" > /dev/null && return; sleep 0.25; done
  echo "API did not start"; tail -20 "$LOG/api.log"; exit 1
}
stop_api() { kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; unset API_PID; }

api() { curl -sf -H "x-api-key: $KEY" -H 'content-type: application/json' "$@"; }
jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log(eval('o'+process.argv[1]))})" "$1"; }
say() { api "$BASE/v1/sessions/$1/events" -d "{\"events\":[{\"type\":\"user.message\",\"content\":[{\"type\":\"text\",\"text\":\"$2\"}]}]}" > /dev/null; }
idle_count() { api "$BASE/v1/sessions/$1/events?limit=200" | jget ".data.filter(e=>e.type==='session.status_idle').length"; }
wait_idle() { # session, count
  for _ in $(seq 1 120); do [[ "$(idle_count "$1")" -ge "$2" ]] && return; sleep 0.25; done
  echo "timeout waiting for idle #$2"; return 1
}
last_msg() { api "$BASE/v1/sessions/$1/events?limit=200" | jget ".data.filter(e=>e.type==='agent.message').at(-1).content[0].text"; }
check() { if [[ "$2" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1: expected [$3], got [$2]"; FAIL=1; fi; }

MOCK_PORT=$MOCK_PORT node "$ROOT/tests/conformance/mock-openrouter.mjs" > "$LOG/mock.log" 2>&1 &
MOCK_PID=$!
start_api
echo "runtime: $(curl -s "$BASE/health" | jget '.runtime.engine')"

ENV=$(api "$BASE/v1/environments" -d '{"name":"scen","config":{"type":"cloud","networking":{"type":"unrestricted"}}}' | jget .id)
AGENT=$(api "$BASE/v1/agents" -d '{"name":"scen","model":"mock/model","tools":[{"type":"agent_toolset_20260401","default_config":{"permission_policy":{"type":"always_allow"}}}]}' | jget .id)

echo "1. Restart keeps the conversation"
S1=$(api "$BASE/v1/sessions" -d "{\"agent\":\"$AGENT\",\"environment_id\":\"$ENV\"}" | jget .id)
say "$S1" "hello there"; wait_idle "$S1" 1
say "$S1" "count messages"; wait_idle "$S1" 2
check "before restart, model sees both turns" "$(last_msg "$S1")" "I see 2 user messages."
stop_api; start_api
say "$S1" "count messages"; wait_idle "$S1" 3
check "after restart, model still sees all turns" "$(last_msg "$S1")" "I see 3 user messages."

echo "2. Raising the budget resumes"
S2=$(api "$BASE/v1/sessions" -d "{\"agent\":\"$AGENT\",\"environment_id\":\"$ENV\",\"budget\":{\"type\":\"limit\",\"max_list_cost\":{\"amount\":\"5\",\"currency\":\"USD\"}}}" | jget .id)
say "$S2" "budget loop"; wait_idle "$S2" 1
check "stops at the budget" "$(api "$BASE/v1/sessions/$S2" | jget .stop_reason.type)" "budget_reached"
COST1=$(api "$BASE/v1/sessions/$S2" | jget .usage.cost_usd)
api "$BASE/v1/sessions/$S2" -d '{"budget":{"type":"limit","max_list_cost":{"amount":"10","currency":"USD"}}}' > /dev/null
wait_idle "$S2" 2
COST2=$(api "$BASE/v1/sessions/$S2" | jget .usage.cost_usd)
check "after raising, it works again and stops at the new budget" "$(api "$BASE/v1/sessions/$S2" | jget .stop_reason.type)" "budget_reached"
check "it spent more after the raise" "$(node -e "console.log($COST2 > $COST1 && $COST2 >= 0.10)")" "true"

echo "3. A sub-agent waiting for approval survives a restart"
LEAD=$(api "$BASE/v1/agents" -d '{"name":"lead","model":"mock/model","multiagent":{"type":"multiagent_20261001"},"tools":[{"type":"agent_toolset_20260401","default_config":{"permission_policy":{"type":"always_ask"}}}]}' | jget .id)
S4=$(api "$BASE/v1/sessions" -d "{\"agent\":\"$LEAD\",\"environment_id\":\"$ENV\"}" | jget .id)
say "$S4" "use subagent with bash"; wait_idle "$S4" 1
check "paused for the sub-agent's tool" "$(api "$BASE/v1/sessions/$S4" | jget .stop_reason.type)" "requires_action"
USE=$(api "$BASE/v1/sessions/$S4/events?limit=200" | jget ".data.find(e=>e.type==='agent.tool_use').id")
stop_api; start_api
api "$BASE/v1/sessions/$S4/events" -d "{\"events\":[{\"type\":\"user.tool_confirmation\",\"tool_use_id\":\"$USE\",\"result\":\"allow\"}]}" > /dev/null
wait_idle "$S4" 2
check "after restart and approval, the sub-agent finished" "$(api "$BASE/v1/sessions/$S4/events?limit=200" | jget ".data.filter(e=>e.type==='agent.thread_message_received').at(-1).content[0].text.includes('from-subagent')")" "true"
check "and the lead agent answered" "$(api "$BASE/v1/sessions/$S4" | jget .stop_reason.type)" "end_turn"

echo "4. Compaction emits agent.thread_context_compacted"
stop_api; COMPACT_TOKENS=100 start_api
S3=$(api "$BASE/v1/sessions" -d "{\"agent\":\"$AGENT\",\"environment_id\":\"$ENV\"}" | jget .id)
say "$S3" "hello there"; wait_idle "$S3" 1
say "$S3" "count messages"; wait_idle "$S3" 2
N=$(api "$BASE/v1/sessions/$S3/events?limit=200" | jget ".data.filter(e=>e.type==='agent.thread_context_compacted').length")
check "compaction event emitted" "$([[ $N -ge 1 ]] && echo yes || echo "no ($N)")" "yes"
check "the session keeps working after compaction" "$(api "$BASE/v1/sessions/$S3" | jget .stop_reason.type)" "end_turn"

[[ $FAIL -eq 0 ]] && echo "All scenarios passed." || { echo "--- api log (tail)"; tail -30 "$LOG/api.log"; exit 1; }
