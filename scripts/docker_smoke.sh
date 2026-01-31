#!/bin/bash
set -e

echo "=== Bloom Kernel Docker Smoke Test ==="

# Check if .env exists
if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
  # Set a test admin key
  sed -i.bak 's/ADMIN_API_KEY=change_me/ADMIN_API_KEY=smoketest_key/' .env
  # Set a test mnemonic (well-known test mnemonic, never use with real funds)
  sed -i.bak 's/DEV_MASTER_MNEMONIC=REPLACE_WITH_DEV_ONLY_MNEMONIC/DEV_MASTER_MNEMONIC=test test test test test test test test test test test junk/' .env
  rm -f .env.bak
fi

echo "[1] Building containers..."
docker compose build --quiet

echo "[2] Starting services..."
docker compose up -d

echo "[3] Waiting for API to be ready..."
for i in {1..30}; do
  if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "    API ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "    ERROR: API failed to start"
    docker compose logs
    docker compose down
    exit 1
  fi
  sleep 1
done

echo "[4] Creating API key..."
KEY_RESPONSE=$(curl -s -X POST http://localhost:3000/api/admin/keys \
  -H "Content-Type: application/json" \
  -H "x-admin-key: smoketest_key" \
  -d '{"user_id": "smoke_user", "scopes": ["*"]}')
API_KEY=$(echo "$KEY_RESPONSE" | grep -o '"api_key":"[^"]*"' | cut -d'"' -f4)

if [ -z "$API_KEY" ]; then
  echo "    ERROR: Failed to create API key"
  echo "    Response: $KEY_RESPONSE"
  docker compose down
  exit 1
fi
echo "    Got API key: ${API_KEY:0:20}..."

echo "[5] Creating agent..."
AGENT_RESPONSE=$(curl -s -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"agent_id": "smoke_agent"}')
AGENT_ID=$(echo "$AGENT_RESPONSE" | grep -o '"agent_id":"[^"]*"' | cut -d'"' -f4)

if [ -z "$AGENT_ID" ]; then
  echo "    ERROR: Failed to create agent"
  echo "    Response: $AGENT_RESPONSE"
  docker compose down
  exit 1
fi
echo "    Created agent: $AGENT_ID"

echo "[6] Getting agent state..."
STATE_RESPONSE=$(curl -s "http://localhost:3000/api/state?agent_id=$AGENT_ID" \
  -H "x-api-key: $API_KEY")
STATUS=$(echo "$STATE_RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$STATUS" != "active" ]; then
  echo "    ERROR: Unexpected agent status"
  echo "    Response: $STATE_RESPONSE"
  docker compose down
  exit 1
fi
echo "    Agent status: $STATUS"

echo "[7] Testing can_do..."
CANDO_RESPONSE=$(curl -s -X POST http://localhost:3000/api/can_do \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "{\"agent_id\": \"$AGENT_ID\", \"intent_json\": {\"type\": \"request_job\"}}")
ALLOWED=$(echo "$CANDO_RESPONSE" | grep -o '"allowed":[^,}]*' | cut -d':' -f2)

echo "    can_do response: allowed=$ALLOWED"

echo "[8] Cleaning up..."
docker compose down

echo ""
echo "=== SMOKE TEST PASSED ==="
