#!/bin/bash
set -e

echo "=== Bloom Kernel Local Smoke Test ==="

# Create test .env if needed
if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
  sed -i.bak 's/ADMIN_API_KEY=change_me/ADMIN_API_KEY=smoketest_key/' .env
  rm -f .env.bak
fi

# Use a test database file (in-memory doesn't persist across processes)
export DB_PATH="/tmp/bloom_smoke_test.db"
export ADMIN_API_KEY="smoketest_key"
export PORT=3099

# Clean up old test DB
rm -f "$DB_PATH"

echo "[1] Running migrations..."
pnpm migrate

echo "[2] Starting server in background..."
pnpm start &
SERVER_PID=$!

cleanup() {
  echo "[cleanup] Stopping server..."
  kill $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

echo "[3] Waiting for API to be ready..."
for i in {1..30}; do
  if curl -s http://localhost:$PORT/api/health > /dev/null 2>&1; then
    echo "    API ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "    ERROR: API failed to start"
    exit 1
  fi
  sleep 1
done

echo "[3] Health check..."
HEALTH=$(curl -s http://localhost:$PORT/api/health)
echo "    $HEALTH"

echo "[4] Creating API key..."
KEY_RESPONSE=$(curl -s -X POST http://localhost:$PORT/api/admin/keys \
  -H "Content-Type: application/json" \
  -H "x-admin-key: smoketest_key" \
  -d '{"user_id": "smoke_user", "scopes": ["*"]}')
API_KEY=$(echo "$KEY_RESPONSE" | grep -o '"api_key":"[^"]*"' | cut -d'"' -f4)

if [ -z "$API_KEY" ]; then
  echo "    ERROR: Failed to create API key"
  echo "    Response: $KEY_RESPONSE"
  exit 1
fi
echo "    Got API key: ${API_KEY:0:20}..."

echo "[5] Creating agent..."
AGENT_RESPONSE=$(curl -s -X POST http://localhost:$PORT/api/agents \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{}')
AGENT_ID=$(echo "$AGENT_RESPONSE" | grep -o '"agent_id":"[^"]*"' | cut -d'"' -f4)

if [ -z "$AGENT_ID" ]; then
  echo "    ERROR: Failed to create agent"
  echo "    Response: $AGENT_RESPONSE"
  exit 1
fi
echo "    Created agent: $AGENT_ID"

echo "[6] Getting agent state..."
STATE_RESPONSE=$(curl -s "http://localhost:$PORT/api/state?agent_id=$AGENT_ID" \
  -H "x-api-key: $API_KEY")
# Check if response contains "status":"active"
if echo "$STATE_RESPONSE" | grep -q '"status":"active"'; then
  echo "    Agent status: active"
else
  echo "    ERROR: Unexpected agent status"
  echo "    Response: $STATE_RESPONSE"
  exit 1
fi

echo "[7] Testing can_do..."
CANDO_RESPONSE=$(curl -s -X POST http://localhost:$PORT/api/can_do \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "{\"agent_id\": \"$AGENT_ID\", \"intent_json\": {\"type\": \"request_job\"}}")
echo "    Response: $CANDO_RESPONSE"

echo ""
echo "=== LOCAL SMOKE TEST PASSED ==="
