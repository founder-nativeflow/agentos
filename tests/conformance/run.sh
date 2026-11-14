#!/usr/bin/env bash
# Runs the official Anthropic SDK against a throwaway AgentOS API.
# Needs local Supabase (pnpm db:start) and Docker. The model is a scripted mock,
# so no OpenRouter key or credit is used.
# Usage: pnpm test:conformance   (from the repo root)
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
AGENTOS_EGRESS_UPSTREAM_CA="$HOME_DIR/echo-ca.pem" PORT="$PORT" AGENTOS_WORKSPACE="$WORKSPACE" OPENROUTER_BASE_URL="http://localhost:$MOCK_PORT" OPENROUTER_API_KEY="mock" \
  node --import tsx src/index.ts > "$HOME_DIR/api.log" 2>&1 &
API_PID=$!
cd "$ROOT"
for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/health" > /dev/null && break
  sleep 0.25
done
curl -sf "http://localhost:$PORT/health" > /dev/null || { echo "API did not start:"; cat "$HOME_DIR/api.log"; exit 1; }

# 3. SDK tests.
cd "$ROOT/tests/conformance"
set +e
AGENTOS_BASE_URL="http://localhost:$PORT" AGENTOS_API_KEY="$API_KEY" AGENTOS_MCP_URL="http://localhost:$MCP_PORT/mcp" npx vitest run "$@"
STATUS=$?
set -e
docker exec supabase_db_agentos psql -U postgres -tAc "select id from agentos.sessions where workspace_id = '$WORKSPACE'" > "$HOME_DIR/sessions.txt" 2>/dev/null || true
[[ $STATUS -ne 0 ]] && { echo "--- api log (tail)"; tail -30 "$HOME_DIR/api.log"; }
exit $STATUS
