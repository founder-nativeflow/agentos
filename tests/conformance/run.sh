#!/usr/bin/env bash
# Runs the official Anthropic SDK against a throwaway AgentOS API.
# Needs local Supabase (pnpm db:start) and Docker. The model is a scripted mock,
# so no OpenRouter key or credit is used.
# Usage: pnpm test:conformance   (from the repo root)
#        AGENTOS_TEST_AUTH=supabase pnpm test:conformance   (Supabase Auth mode: users,
#        workspaces and DB-stored API keys, against the local Supabase Auth service)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentos-conformance.XXXXXX")"
HOME_DIR="$(printf '%s' "$HOME_DIR" | tr -s /)"   # TMPDIR may end in "/"; the API labels resources with the normalised path
PORT="${AGENTOS_TEST_PORT:-4100}"
MOCK_PORT="${AGENTOS_MOCK_PORT:-4199}"
MCP_PORT="${AGENTOS_MCP_PORT:-4198}"
ECHO_HTTP_PORT=4197
ECHO_HTTPS_PORT=4196
WORKSPACE="ws_test_$(date +%s)_$RANDOM"
AUTH_MODE="${AGENTOS_TEST_AUTH:-local}"
RUN_TAG="conf$(date +%s)$RANDOM"   # test users are ${RUN_TAG}-*@example.test
export AGENTOS_HOME="$HOME_DIR"

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null || true
  [[ -n "${MCP_PID:-}" ]] && kill "$MCP_PID" 2>/dev/null || true
  [[ -n "${ECHO_PID:-}" ]] && kill "$ECHO_PID" 2>/dev/null || true
  # Remove this run's sandboxes and data.
  docker ps -aq --filter "label=agentos.session" --filter "name=agentos-sesn" | while read -r id; do
    ws="$(docker inspect -f '{{index .Config.Labels "agentos.session"}}' "$id" 2>/dev/null || true)"
    grep -qx "$ws" "$HOME_DIR/sessions.txt" 2>/dev/null && docker rm -f "$id" > /dev/null || true
  done
  # This run's egress proxy and sandbox network.
  docker ps -aq --filter "label=agentos.home=$HOME_DIR" | xargs docker rm -f > /dev/null 2>&1 || true
  docker network ls -q --filter "label=agentos.home=$HOME_DIR" | xargs docker network rm > /dev/null 2>&1 || true
  # Supabase mode: this run's users and their workspaces.
  if [[ "$AUTH_MODE" == "supabase" ]]; then
    docker exec supabase_db_agentos psql -U postgres -qc "
      delete from vault.secrets where id in (select c.secret_id from agentos.credentials c join agentos.vaults v on v.id = c.vault_id
        join agentos.workspace_members m on m.workspace_id = v.workspace_id join auth.users u on u.id = m.user_id where u.email like '${RUN_TAG}-%');
      delete from agentos.workspaces where id in (select m.workspace_id from agentos.workspace_members m join auth.users u on u.id = m.user_id where u.email like '${RUN_TAG}-%');
      delete from auth.users where email like '${RUN_TAG}-%';" > /dev/null 2>&1 || true
  fi
  # Vault secrets don't cascade with the workspace; remove them first.
  docker exec supabase_db_agentos psql -U postgres -qc "delete from vault.secrets where id in (select c.secret_id from agentos.credentials c join agentos.vaults v on v.id = c.vault_id where v.workspace_id = '$WORKSPACE'); delete from agentos.workspaces where id = '$WORKSPACE'" > /dev/null 2>&1 || true
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

for p in "$PORT" "$MOCK_PORT" "$MCP_PORT" "$ECHO_HTTP_PORT" "$ECHO_HTTPS_PORT"; do
  if lsof -ti "tcp:$p" > /dev/null 2>&1; then echo "Port $p is busy"; exit 1; fi
done

# 1. Throwaway admin + API key.
INIT_OUT="$(echo "conformance-pass-123" | (cd "$ROOT" && pnpm -s agentos init --username admin --password-stdin --force))"
API_KEY="$(printf '%s\n' "$INIT_OUT" | awk '/Your API key/{getline; gsub(/^ +| +$/, ""); print; exit}')"
[[ "$API_KEY" == aos-* && ${#API_KEY} -gt 20 ]] || { echo "Could not read API key from init output"; exit 1; }

# 2. Mock model + API (isolated workspace in the local Supabase database).
MOCK_PORT="$MOCK_PORT" node "$ROOT/tests/conformance/mock-openrouter.mjs" > "$HOME_DIR/mock.log" 2>&1 &
MOCK_PID=$!
(cd "$ROOT/tests/conformance" && MCP_PORT="$MCP_PORT" exec node mock-mcp.mjs > "$HOME_DIR/mcp.log" 2>&1) &
MCP_PID=$!
(cd "$ROOT/tests/conformance" && ECHO_CA_OUT="$HOME_DIR/echo-ca.pem" ECHO_HTTP_PORT="$ECHO_HTTP_PORT" ECHO_HTTPS_PORT="$ECHO_HTTPS_PORT" exec node echo-server.mjs > "$HOME_DIR/echo.log" 2>&1) &
ECHO_PID=$!
for _ in $(seq 1 40); do [[ -s "$HOME_DIR/echo-ca.pem" ]] && break; sleep 0.25; done
cd "$ROOT/apps/api"
SUPA_ENV=""
if [[ "$AUTH_MODE" == "supabase" ]]; then
  eval "$(cd "$ROOT" && supabase status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
  export AGENTOS_AUTH=supabase SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
fi
AGENTOS_SCHEDULER_INTERVAL_MS=1000 AGENTOS_EGRESS_UPSTREAM_CA="$HOME_DIR/echo-ca.pem" PORT="$PORT" AGENTOS_WORKSPACE="$WORKSPACE" OPENROUTER_BASE_URL="http://localhost:$MOCK_PORT" OPENROUTER_API_KEY="mock" \
  node --import tsx src/index.ts > "$HOME_DIR/api.log" 2>&1 &
API_PID=$!
cd "$ROOT"
for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/health" > /dev/null && break
  sleep 0.25
done
curl -sf "http://localhost:$PORT/health" > /dev/null || { echo "API did not start:"; cat "$HOME_DIR/api.log"; exit 1; }

# Supabase mode: sign up a user (creates their workspace) and make a DB-stored API key for the SDK.
if [[ "$AUTH_MODE" == "supabase" ]]; then
  JAR="$HOME_DIR/cookies.txt"
  curl -sf -c "$JAR" -H 'content-type: application/json' "http://localhost:$PORT/v1/x/auth/signup" \
    -d "{\"email\":\"${RUN_TAG}-owner@example.test\",\"password\":\"owner-pass-123\",\"workspace_name\":\"Conformance\"}" > /dev/null \
    || { echo "Sign-up failed:"; tail -20 "$HOME_DIR/api.log"; exit 1; }
  API_KEY="$(curl -sf -b "$JAR" -H 'content-type: application/json' "http://localhost:$PORT/v1/x/api_keys" -d '{"name":"conformance"}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).key))")"
  [[ "$API_KEY" == aos-* ]] || { echo "Could not create a DB API key"; exit 1; }
  export AGENTOS_TEST_RUN_TAG="$RUN_TAG"
fi

# 3. SDK tests.
cd "$ROOT/tests/conformance"
set +e
AGENTOS_BASE_URL="http://localhost:$PORT" AGENTOS_API_KEY="$API_KEY" AGENTOS_MCP_URL="http://localhost:$MCP_PORT/mcp" npx vitest run "$@"
STATUS=$?
set -e
docker exec supabase_db_agentos psql -U postgres -tAc "select id from agentos.sessions where workspace_id = '$WORKSPACE' or workspace_id in (select m.workspace_id from agentos.workspace_members m join auth.users u on u.id = m.user_id where u.email like '${RUN_TAG}-%')" > "$HOME_DIR/sessions.txt" 2>/dev/null || true
[[ $STATUS -ne 0 ]] && { echo "--- api log (tail)"; tail -30 "$HOME_DIR/api.log"; }
exit $STATUS
