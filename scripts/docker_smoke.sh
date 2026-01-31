#!/bin/bash
set -e

echo "=== Bloom Kernel Docker Smoke Test ==="

# Generate unique run ID for idempotency
RUN_ID=$(date +%s)_$$
echo "Run ID: $RUN_ID"

# Check if .env exists
if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
fi

# Set test values in .env (idempotent - uses sed to replace)
sed -i.bak 's/ADMIN_API_KEY=.*/ADMIN_API_KEY=smoketest_key/' .env
sed -i.bak 's/DEV_MASTER_MNEMONIC=.*/DEV_MASTER_MNEMONIC=test test test test test test test test test test test junk/' .env
rm -f .env.bak

echo "[1] Building containers..."
docker compose build --quiet

echo "[2] Starting services..."
docker compose up -d

cleanup() {
  echo "[CLEANUP] Shutting down containers..."
  docker compose down --volumes 2>/dev/null || true
}
trap cleanup EXIT

echo "[3] Waiting for API to be ready (healthz)..."
for i in {1..30}; do
  HEALTH=$(curl -s http://localhost:3000/healthz 2>/dev/null || echo "{}")
  if echo "$HEALTH" | grep -q '"db_connected":true'; then
    echo "    API ready!"
    echo "    healthz: $HEALTH"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "    ERROR: API failed to start within 30 seconds"
    echo "    Last response: $HEALTH"
    docker compose logs
    exit 1
  fi
  sleep 1
done

# Verify healthz response shape
echo "[3b] Verifying healthz response shape..."
HEALTH=$(curl -s http://localhost:3000/healthz)
for key in api_version db_connected migrations_applied card_mode env_type; do
  if ! echo "$HEALTH" | grep -q "\"$key\""; then
    echo "    ERROR: healthz missing required key: $key"
    echo "    Response: $HEALTH"
    exit 1
  fi
done
echo "    healthz shape verified"

echo "[4] Creating API key..."
KEY_RESPONSE=$(curl -s -X POST http://localhost:3000/api/admin/keys \
  -H "Content-Type: application/json" \
  -H "x-admin-key: smoketest_key" \
  -d "{\"user_id\": \"smoke_user_$RUN_ID\", \"scopes\": [\"*\"]}")
API_KEY=$(echo "$KEY_RESPONSE" | grep -o '"api_key":"[^"]*"' | cut -d'"' -f4)

if [ -z "$API_KEY" ]; then
  echo "    ERROR: Failed to create API key"
  echo "    Response: $KEY_RESPONSE"
  exit 1
fi
echo "    Got API key: ${API_KEY:0:20}..."

echo "[5] Creating agent..."
AGENT_ID="smoke_agent_$RUN_ID"
AGENT_RESPONSE=$(curl -s -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "{\"agent_id\": \"$AGENT_ID\"}")
CREATED_AGENT_ID=$(echo "$AGENT_RESPONSE" | grep -o '"agent_id":"[^"]*"' | cut -d'"' -f4)

if [ -z "$CREATED_AGENT_ID" ]; then
  echo "    ERROR: Failed to create agent"
  echo "    Response: $AGENT_RESPONSE"
  exit 1
fi
echo "    Created agent: $CREATED_AGENT_ID"

echo "[6] Getting agent state..."
STATE_RESPONSE=$(curl -s "http://localhost:3000/api/state?agent_id=$AGENT_ID" \
  -H "x-api-key: $API_KEY")
STATUS=$(echo "$STATE_RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$STATUS" != "active" ]; then
  echo "    ERROR: Unexpected agent status (expected 'active')"
  echo "    Response: $STATE_RESPONSE"
  exit 1
fi
echo "    Agent status: $STATUS"

echo "[7] Testing can_do endpoint..."
CANDO_RESPONSE=$(curl -s -X POST http://localhost:3000/api/can_do \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "{\"agent_id\": \"$AGENT_ID\", \"intent_json\": {\"type\": \"request_job\"}}")

# Verify can_do response has required fields
if ! echo "$CANDO_RESPONSE" | grep -q '"allowed"'; then
  echo "    ERROR: can_do response missing 'allowed' field"
  echo "    Response: $CANDO_RESPONSE"
  exit 1
fi

if ! echo "$CANDO_RESPONSE" | grep -q '"quote_id"'; then
  echo "    ERROR: can_do response missing 'quote_id' field"
  echo "    Response: $CANDO_RESPONSE"
  exit 1
fi

ALLOWED=$(echo "$CANDO_RESPONSE" | grep -o '"allowed":[^,}]*' | cut -d':' -f2)
echo "    can_do response: allowed=$ALLOWED (shape verified)"

echo ""
echo "=== SMOKE TEST PASSED ==="
echo "Run ID: $RUN_ID"
echo ""
echo "To clean up manually: docker compose down --volumes"
