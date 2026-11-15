#!/usr/bin/env bash
# Security behaviour, against an API on :4620 started with tight limits:
#   running sessions per workspace, webhook calls per minute, sign-in throttling, bad-API-key
#   throttling, requests per minute; CORS, security headers, body-size limit; SSRF guard on
#   web_fetch and MCP server URLs.
# Usage: bash tests/conformance/security-scenario.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=4620
MOCK_PORT=4619
WS="ws_limits_$(date +%s)_$RANDOM"
LOG="$(mktemp -d "${TMPDIR:-/tmp}/agentos-limits.XXXXXX")"
LOG="$(printf '%s' "$LOG" | tr -s /)"
BASE="http://localhost:$PORT"
KEY="$(sed -n 's/^AGENTOS_API_KEY=//p' "$ROOT/.agentos/dev-credentials" 2>/dev/null || true)"
[[ -n "$KEY" ]] || { echo "Needs .agentos/dev-credentials with AGENTOS_API_KEY"; exit 1; }
FAIL=0

cleanup() {
  for p in ${PIDS:-}; do kill "$p" 2>/dev/null || true; done
  for id in $(docker exec supabase_db_agentos psql -U postgres -tAc "select lower(id) from agentos.sessions where workspace_id = '$WS'" 2>/dev/null); do
    docker rm -f "agentos-$id" > /dev/null 2>&1 || true
  done
  docker exec supabase_db_agentos psql -U postgres -qc "delete from agentos.workspaces where id = '$WS'" > /dev/null 2>&1 || true
  rm -rf "$LOG"
}
trap cleanup EXIT

MOCK_PORT=$MOCK_PORT node "$ROOT/tests/conformance/mock-openrouter.mjs" > "$LOG/mock.log" 2>&1 & PIDS="$!"
(cd "$ROOT/apps/api" && PORT=$PORT AGENTOS_WORKSPACE=$WS AGENTOS_SCHEDULER=off OPENROUTER_BASE_URL="http://localhost:$MOCK_PORT" OPENROUTER_API_KEY=mock \
  AGENTOS_RATE_LIMIT_RPM=0 AGENTOS_LOGIN_MAX_FAILURES=3 AGENTOS_AUTH_MAX_FAILURES=5 AGENTOS_WEBHOOK_RPM=2 AGENTOS_MAX_RUNNING_SESSIONS=1 \
  AGENTOS_BLOCK_PRIVATE_NETWORKS=1 AGENTOS_CORS_ORIGINS=https://console.example.test AGENTOS_MAX_BODY_BYTES=100000 \
  exec node --import tsx src/index.ts > "$LOG/api.log" 2>&1) & PIDS="$PIDS $!"
for _ in $(seq 1 60); do curl -sf "$BASE/health" > /dev/null && break; sleep 0.25; done

check() { if [[ "$2" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1: expected [$3], got [$2]"; FAIL=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
api() { curl -sf -H "x-api-key: $KEY" -H 'content-type: application/json' "$BASE$@"; }
jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log(eval('o'+process.argv[1]))})" "$1"; }
login() { code -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}" "$BASE/v1/x/auth/login"; }

echo "1. Running sessions per workspace (limit 1)"
ENV=$(api /v1/environments -d '{"name":"limits","config":{"type":"local"}}' | jget .id)
AGENT=$(api /v1/agents -d '{"name":"limits","model":"mock/model","tools":[{"type":"agent_toolset_20260401"}]}' | jget .id)
S1=$(api /v1/sessions -d "{\"agent\":\"$AGENT\",\"environment_id\":\"$ENV\"}" | jget .id)
S2=$(api /v1/sessions -d "{\"agent\":\"$AGENT\",\"environment_id\":\"$ENV\"}" | jget .id)
msg() { printf '{"events":[{"type":"user.message","content":[{"type":"text","text":"%s"}]}]}' "$1"; }
api "/v1/sessions/$S1/events" -d "$(msg slow)" > /dev/null
for _ in $(seq 1 40); do [[ "$(api /v1/sessions/$S1 | jget .status)" == "running" ]] && break; sleep 0.25; done
check "a second session can't start while one runs" "$(code -H "x-api-key: $KEY" -H 'content-type: application/json' -d "$(msg hi)" "$BASE/v1/sessions/$S2/events")" "429"
check "...with a rate_limit_error and retry-after" "$(curl -s -D "$LOG/h" -H "x-api-key: $KEY" -H 'content-type: application/json' -d "$(msg hi)" "$BASE/v1/sessions/$S2/events" | jget .error.type):$(grep -ci '^retry-after:' "$LOG/h")" "rate_limit_error:1"
api "/v1/sessions/$S1/events" -d '{"events":[{"type":"user.interrupt"}]}' > /dev/null
for _ in $(seq 1 40); do [[ "$(api /v1/sessions/$S1 | jget .status)" == "idle" ]] && break; sleep 0.25; done
check "an interrupt stops the running command promptly" "$(api /v1/sessions/$S1 | jget .status)" "idle"
check "after the first goes idle, the second starts" "$(code -H "x-api-key: $KEY" -H 'content-type: application/json' -d "$(msg hi)" "$BASE/v1/sessions/$S2/events")" "200"

echo "2. SSRF guard: web_fetch and MCP can't reach internal addresses"
events_of() { api "/v1/sessions/$1/events" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d).data)))"; }
wait_idle() { for _ in $(seq 1 80); do events_of "$1" | grep -q session.status_idle && return; sleep 0.25; done; }
for target in "http://127.0.0.1:$PORT/health" "http://169.254.169.254/latest/meta-data/" "http://localhost:$PORT/health"; do
  S=$(api /v1/sessions -d "{\"agent\":\"$AGENT\",\"environment_id\":\"$ENV\"}" | jget .id)
  api "/v1/sessions/$S/events" -d "$(msg "fetch url $target")" > /dev/null; wait_idle "$S"
  check "web_fetch $target is blocked" "$(events_of "$S" | grep -c 'private or internal address')" "1"
done
MCPAGENT=$(api /v1/agents -d "{\"name\":\"mcp\",\"model\":\"mock/model\",\"mcp_servers\":[{\"type\":\"url\",\"name\":\"internal\",\"url\":\"http://127.0.0.1:$PORT/mcp\"}],\"tools\":[{\"type\":\"mcp_toolset\",\"mcp_server_name\":\"internal\"}]}" | jget .id)
S=$(api /v1/sessions -d "{\"agent\":\"$MCPAGENT\",\"environment_id\":\"$ENV\"}" | jget .id)
api "/v1/sessions/$S/events" -d "$(msg hi)" > /dev/null; wait_idle "$S"
check "an MCP server on an internal address is refused" "$(events_of "$S" | grep -c 'mcp_connection_failed_error.*private or internal')" "1"

echo "3. CORS, headers, body size"
hdr() { curl -s -o /dev/null -D - "$@" | tr -d '\r' | tr 'A-Z' 'a-z'; }
check "unknown origin gets no CORS grant" "$(hdr -H "Origin: https://evil.example" -H "x-api-key: $KEY" "$BASE/v1/agents" | grep -c '^access-control-allow-origin')" "0"
check "listed origin gets CORS" "$(hdr -H "Origin: https://console.example.test" -H "x-api-key: $KEY" "$BASE/v1/agents" | grep -c '^access-control-allow-origin: https://console.example.test')" "1"
H=$(hdr -H "x-api-key: $KEY" "$BASE/v1/agents")
check "nosniff, frame and referrer headers" "$(echo "$H" | grep -cE '^(x-content-type-options: nosniff|x-frame-options: sameorigin|referrer-policy: no-referrer)')" "3"
BIG=$(node -e 'console.log(JSON.stringify({name:"x",model:"mock/model",system:"a".repeat(200000)}))')
check "oversized JSON body is 413" "$(code -H "x-api-key: $KEY" -H 'content-type: application/json' -d "$BIG" "$BASE/v1/agents")" "413"

echo "4. Webhook calls per IP (limit 2/min)"
DEPL=$(api /v1/deployments -d "{\"name\":\"hook\",\"agent\":\"$AGENT\",\"environment_id\":\"$ENV\",\"initial_events\":[{\"type\":\"user.message\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}]}" | jget .id)
URL=$(api "/v1/deployments/$DEPL/webhook" -X POST | jget .url)
c1=$(code -X POST -H 'x-agentos-webhook-token: whk_wrong' "$BASE$URL"); c2=$(code -X POST -H 'x-agentos-webhook-token: whk_wrong' "$BASE$URL")
c3=$(code -X POST -H 'x-agentos-webhook-token: whk_wrong' "$BASE$URL")
check "third call in a minute is refused" "$c1 $c2 $c3" "401 401 429"

echo "5. Sign-in throttling (3 failures per 15 min)"
U="$(sed -n 's/^AGENTOS_ADMIN_USERNAME=//p' "$ROOT/.agentos/dev-credentials")"; P="$(sed -n 's/^AGENTOS_ADMIN_PASSWORD=//p' "$ROOT/.agentos/dev-credentials")"
check "three wrong passwords are 401" "$(login "$U" nope1) $(login "$U" nope2) $(login "$U" nope3)" "401 401 401"
check "then even the right password waits" "$(login "$U" "$P")" "429"

echo "6. Bad API keys per IP (5 per 15 min)"
for i in 1 2 3 4 5; do code -H "x-api-key: aos-wrong-$i" "$BASE/v1/agents" > /dev/null; done
check "sixth bad key is refused" "$(code -H 'x-api-key: aos-wrong-6' "$BASE/v1/agents")" "429"

echo "7. Requests per minute per key (limit 40)"
# The IP is now blocked for bad keys too, so restart with a fresh process for a clean count.
kill "${PIDS##* }" 2>/dev/null || true; sleep 0.5
(cd "$ROOT/apps/api" && PORT=$PORT AGENTOS_WORKSPACE=$WS AGENTOS_SCHEDULER=off OPENROUTER_BASE_URL="http://localhost:$MOCK_PORT" OPENROUTER_API_KEY=mock \
  AGENTOS_RATE_LIMIT_RPM=40 exec node --import tsx src/index.ts >> "$LOG/api.log" 2>&1) & PIDS="$PIDS $!"
for _ in $(seq 1 60); do curl -sf "$BASE/health" > /dev/null && break; sleep 0.25; done
codes=""; for i in $(seq 1 42); do codes="$codes $(code -H "x-api-key: $KEY" "$BASE/v1/agents")"; done
check "first 40 succeed" "$(echo "$codes" | tr ' ' '\n' | grep -c '^200$')" "40"
check "then 429" "$(echo "$codes" | tr ' ' '\n' | grep -c '^429$')" "2"

[[ $FAIL -eq 0 ]] && echo "All security checks passed." || { echo "--- api log"; tail -20 "$LOG/api.log"; exit 1; }
